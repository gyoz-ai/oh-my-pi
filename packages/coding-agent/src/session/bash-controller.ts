/**
 * Owns the bash-execution subsystem extracted from AgentSession.
 *
 * Responsibilities:
 *  - Tracks the pool of in-flight bash abort controllers (one per concurrent run).
 *  - Buffers `bashExecution` messages produced while the agent is streaming and
 *    flushes them in order once streaming completes (preserves tool_use /
 *    tool_result ordering).
 *  - Routes user-bash invocations through the extension `user_bash` hook,
 *    falling back to the native executor when no hook handles the call.
 *
 * AgentSession composes BashController and delegates its public bash API. The
 * controller never reaches into AgentSession-private state — everything it
 * needs is threaded through `BashControllerHost`.
 */

import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Narrow surface BashController consumes from its host AgentSession. */
export interface BashControllerHost {
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly agent: Agent;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly sessionId: string;
	readonly isStreaming: boolean;
}

export interface BashExecuteOptions {
	excludeFromContext?: boolean;
}

export class BashController {
	readonly #host: BashControllerHost;
	readonly #abortControllers = new Set<AbortController>();
	#pendingMessages: BashExecutionMessage[] = [];

	constructor(host: BashControllerHost) {
		this.#host = host;
	}

	/** Persist `originalText` to a session artifact, swallowing storage errors. */
	async #saveOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.#host.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	/**
	 * Run `command`, attributing the result to the session history.
	 *
	 * Honors a registered `user_bash` extension hook; when no hook supplies a
	 * pre-computed result, falls back to the native bash executor.
	 */
	async execute(
		command: string,
		onChunk: ((chunk: string) => void) | undefined,
		options: BashExecuteOptions | undefined,
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		const runner = this.#host.extensionRunner;

		if (runner?.hasHandlers("user_bash")) {
			const hookResult = await runner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.record(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#abortControllers.add(abortController);
		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.#host.sessionId,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveOriginalArtifact(originalText),
			});
			this.record(command, result, options);
			return result;
		} finally {
			this.#abortControllers.delete(abortController);
		}
	}

	/**
	 * Append a bash-execution record to history. Extensions that own bash
	 * dispatch call this directly so the user still sees the message in the
	 * session.
	 */
	record(command: string, result: BashResult, options: BashExecuteOptions | undefined): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command,
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

	/** Abort every in-flight bash invocation. */
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

	/** Flush queued bash messages into agent state + session history. */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		const messages = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const message of messages) {
			this.#host.agent.appendMessage(message);
			this.#host.sessionManager.appendMessage(message);
		}
	}
}
