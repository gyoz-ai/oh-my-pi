import { createConnection } from "node:net";
import { $env } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import type { SessionObserverRegistry } from "./session-observer-registry";

export interface HerdrFocusAndTitleSource {
	getFocusedAgentId(): string | undefined;
	onFocusChanged(cb: () => void): () => void;
	getSessionTitle(): string | undefined;
	onSessionTitleChanged(cb: () => void): () => void;
}

export function maybeCreateHerdrSubagentReporter(
	registry: SessionObserverRegistry,
	focusAndTitle?: HerdrFocusAndTitleSource,
): { dispose(): Promise<void> } | undefined {
	const socketPath = $env.HERDR_SOCKET_PATH;
	const paneId = $env.HERDR_PANE_ID;
	if ($env.HERDR_ENV !== "1" || !socketPath || !paneId) return undefined;

	const rows = new Map<
		string,
		{
			id: string;
			agent: string;
			status: "working" | "done" | "failed";
			description: string | undefined;
			agent_seq: number;
		}
	>();
	let seq = Date.now() * 1000;
	let flushGen = 0;
	let disposed = false;
	let sending: Promise<void> | undefined;
	let queued: unknown[] | undefined;

	const transmit = (subagents: unknown[]): Promise<void> => {
		seq += 1;
		const focusedAgentId = focusAndTitle?.getFocusedAgentId();
		const frame = `${JSON.stringify({
			id: `custom:omp-subagents:${seq}`,
			method: "pane.report_subagents",
			params: {
				pane_id: paneId,
				source: "custom:omp-subagents",
				seq,
				subagents,
				focused_agent_seq: focusedAgentId ? AgentRegistry.global().get(focusedAgentId)?.seq : undefined,
				session_title: focusAndTitle?.getSessionTitle(),
			},
		})}\n`;
		const { promise, resolve } = Promise.withResolvers<void>();
		let done = false;
		const socket = createConnection(socketPath);
		const finish = () => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve();
		};
		socket.on("error", finish);
		socket.on("connect", () => socket.write(frame));
		socket.on("data", finish);
		socket.on("end", finish);
		const timer = setTimeout(finish, 500);
		timer.unref?.();
		return promise;
	};

	const send = (subagents: unknown[]): Promise<void> => {
		queued = subagents;
		if (sending) return sending;
		sending = (async () => {
			while (queued) {
				const next = queued;
				queued = undefined;
				await transmit(next);
			}
			sending = undefined;
		})();
		return sending;
	};

	const scheduleFlush = (): void => {
		flushGen += 1;
		const gen = flushGen;
		const timer = setTimeout(() => {
			if (gen !== flushGen || disposed) return;
			void send([...rows.values()]);
		}, 100);
		timer.unref?.();
	};

	const unsubscribe = registry.onChange(kind => {
		if (disposed) return;
		if (kind === "reset") {
			rows.clear();
			scheduleFlush();
			return;
		}
		const sessions = registry.getSessions().filter(s => s.kind === "subagent");
		let anyRetainedWorking = false;
		for (const row of rows.values()) {
			if (row.status === "working") {
				anyRetainedWorking = true;
				break;
			}
		}
		if (!anyRetainedWorking && sessions.some(s => s.status === "active" && !rows.has(s.id))) {
			rows.clear();
		}
		for (const session of sessions) {
			const status = session.status === "active" ? "working" : session.status === "completed" ? "done" : "failed";
			if (status !== "working" && !rows.has(session.id)) continue;
			rows.set(session.id, {
				id: session.id,
				agent: session.agent ?? "task",
				status,
				description: AgentRegistry.global().get(session.id)?.activity ?? session.description,
				agent_seq: AgentRegistry.global().get(session.id)?.seq ?? 0,
			});
		}
		scheduleFlush();
	});
	const unsubscribeFocus = focusAndTitle?.onFocusChanged(scheduleFlush);
	const unsubscribeTitle = focusAndTitle?.onSessionTitleChanged(scheduleFlush);

	return {
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			flushGen += 1;
			unsubscribe();
			unsubscribeFocus?.();
			unsubscribeTitle?.();
			rows.clear();
			await send([]);
		},
	};
}
