/**
 * Owns the user-initiated Python execution subsystem extracted from AgentSession.
 *
 * Responsibilities:
 *  - Manages the pool of in-flight Python abort controllers and the wider set
 *    of tracked eval executions (including work started by tools that pipe
 *    through `trackExecution`).
 *  - Owns the kernel-owner id and routes disposal to `disposeKernelSessionsByOwner`.
 *  - Buffers `pythonExecution` messages produced while the agent is streaming.
 *  - Routes user-python invocations through the extension `user_python` hook.
 *  - Provides the dispose-time settle/abort dance that AgentSession waits on
 *    before tearing down kernels.
 *
 * AgentSession composes PythonController and delegates its public python API.
 */

import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Narrow surface PythonController consumes from its host AgentSession. */
export interface PythonControllerHost {
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly agent: Agent;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly isStreaming: boolean;
}

export interface PythonExecuteOptions {
	excludeFromContext?: boolean;
}

export class PythonController {
	readonly #host: PythonControllerHost;
	readonly #abortControllers = new Set<AbortController>();
	readonly #activeExecutions = new Set<Promise<unknown>>();
	readonly #kernelOwnerId: string;
	#pendingMessages: PythonExecutionMessage[] = [];
	#disposing = false;

	constructor(host: PythonControllerHost, kernelOwnerId?: string) {
		this.#host = host;
		this.#kernelOwnerId = kernelOwnerId ?? `agent-session:${Snowflake.next()}`;
	}

	/** Logical owner id for kernels created by this controller. */
	get kernelOwnerId(): string {
		return this.#kernelOwnerId;
	}

	/**
	 * Run `code` against the shared kernel for this session's working directory,
	 * attributing the result to session history. Honors the `user_python`
	 * extension hook before falling back to the native kernel executor.
	 */
	async execute(
		code: string,
		onChunk: ((chunk: string) => void) | undefined,
		options: PythonExecuteOptions | undefined,
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		this.assertExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			const runner = this.#host.extensionRunner;
			if (runner?.hasHandlers("user_python")) {
				const hookResult = await runner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					this.record(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Re-use eval's kernel-id derivation so /py and the eval tool share kernels.
			const sessionFile = this.#host.sessionManager.getSessionFile();
			const sessionId = sessionFile ? `session:${sessionFile}:cwd:${cwd}` : `cwd:${cwd}`;
			const result = await executePythonCommand(code, {
				cwd,
				sessionId,
				kernelOwnerId: this.#kernelOwnerId,
				kernelMode: this.#host.settings.get("python.kernelMode"),
				onChunk,
				signal: abortController.signal,
			});
			this.record(code, result, options);
			return result;
		})();
		return await this.trackExecution(execution, abortController);
	}

	/** Throws when new eval work is no longer accepted (dispose in progress). */
	assertExecutionAllowed(): void {
		if (this.#disposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Register an externally-started eval execution so dispose can await and
	 * abort it alongside controller-owned work. The eval tool uses this to fold
	 * tool-level Python work into the same lifecycle.
	 */
	trackExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		const cleanup = () => {
			this.#abortControllers.delete(abortController);
			this.#activeExecutions.delete(execution);
		};
		void execution.then(cleanup, cleanup);
		return execution;
	}

	/**
	 * Append a python-execution record to history. Extensions that own python
	 * dispatch call this directly so the user still sees the message.
	 */
	record(code: string, result: PythonResult, options: PythonExecuteOptions | undefined): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const message: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// Defer while streaming so we don't split a tool_use / tool_result pair.
		if (this.#host.isStreaming) {
			this.#pendingMessages.push(message);
		} else {
			this.#host.agent.appendMessage(message);
			this.#host.sessionManager.appendMessage(message);
		}
	}

	/** Abort every in-flight Python execution (controller- and tool-tracked). */
	abort(): void {
		for (const controller of this.#abortControllers) {
			controller.abort();
		}
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Flush queued python messages into agent state + session history. */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		const messages = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const message of messages) {
			this.#host.agent.appendMessage(message);
			this.#host.sessionManager.appendMessage(message);
		}
	}

	/**
	 * Synchronously mark the controller as disposing so subsequent eval starts
	 * reject before any awaits run. Idempotent.
	 */
	markDisposing(): void {
		this.#disposing = true;
	}

	/**
	 * Mark the controller as disposing, abort/await tracked work, then dispose
	 * kernels owned by this controller. Idempotent; safe to await twice.
	 * @returns `true` when all executions settled before kernels were detached.
	 */
	async dispose(): Promise<boolean> {
		this.markDisposing();
		const settled = await this.#prepareExecutionsForDispose();
		await disposeKernelSessionsByOwner(this.#kernelOwnerId);
		return settled;
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size > 0) return false;
		}
		return true;
	}

	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}
}
