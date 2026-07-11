import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../task";
import { EventBus } from "../utils/event-bus";
import { maybeCreateHerdrSubagentReporter } from "./herdr-subagent-reporter";
import { SessionObserverRegistry } from "./session-observer-registry";

interface CapturedFrame {
	id: string;
	method: string;
	params: {
		pane_id: string;
		source: string;
		seq: number;
		subagents: Array<{ id: string; agent: string; status: string; description?: string; agent_seq: number }>;
		focused_agent_seq?: number;
		session_title?: string;
	};
}

let dir: string;
let socketPath: string;
let server: Server | undefined;
let frames: CapturedFrame[];
let frameWaiters: Array<{ count: number; resolve: () => void }>;
let bus: EventBus;
let registry: SessionObserverRegistry;
let reporter: { dispose(): Promise<void> } | undefined;
let savedEnv: Record<string, string | undefined>;

function emitLifecycle(
	payload: Partial<SubagentLifecyclePayload> & Pick<SubagentLifecyclePayload, "id" | "status" | "index">,
): void {
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		agent: "task",
		agentSource: "bundled",
		...payload,
	} satisfies SubagentLifecyclePayload);
}

function registerAgent(id: string): number {
	return AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: null,
	}).seq;
}

function waitFrames(count: number): Promise<void> {
	if (frames.length >= count) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	frameWaiters.push({ count, resolve });
	return promise;
}

beforeEach(async () => {
	savedEnv = {
		HERDR_ENV: $env.HERDR_ENV,
		HERDR_SOCKET_PATH: $env.HERDR_SOCKET_PATH,
		HERDR_PANE_ID: $env.HERDR_PANE_ID,
	};
	dir = mkdtempSync(join(tmpdir(), "herdr-reporter-"));
	socketPath = join(dir, "herdr.sock");
	frames = [];
	frameWaiters = [];
	server = createServer(socket => {
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.trim()) {
					frames.push(JSON.parse(line) as CapturedFrame);
					socket.write('{"result":{}}\n');
					const ready = frameWaiters.filter(w => frames.length >= w.count);
					frameWaiters = frameWaiters.filter(w => frames.length < w.count);
					for (const waiter of ready) waiter.resolve();
				}
				nl = buffer.indexOf("\n");
			}
		});
	});
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(socketPath, resolve);
	await promise;
	$env.HERDR_ENV = "1";
	$env.HERDR_SOCKET_PATH = socketPath;
	$env.HERDR_PANE_ID = "pane-42";
	bus = new EventBus();
	registry = new SessionObserverRegistry();
	registry.subscribeToEventBus(bus);
	reporter = undefined;
});

afterEach(async () => {
	await reporter?.dispose();
	reporter = undefined;
	registry.dispose();
	if (server) {
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
		server = undefined;
	}
	rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete $env[key];
		else $env[key] = value;
	}
	AgentRegistry.resetGlobalForTests();
});

describe("maybeCreateHerdrSubagentReporter", () => {
	it("returns undefined and sends nothing while the herdr env gate is not satisfied", async () => {
		delete $env.HERDR_ENV;
		expect(maybeCreateHerdrSubagentReporter(registry)).toBeUndefined();
		$env.HERDR_ENV = "0";
		expect(maybeCreateHerdrSubagentReporter(registry)).toBeUndefined();
		$env.HERDR_ENV = "1";
		delete $env.HERDR_SOCKET_PATH;
		expect(maybeCreateHerdrSubagentReporter(registry)).toBeUndefined();
		$env.HERDR_SOCKET_PATH = socketPath;
		delete $env.HERDR_PANE_ID;
		expect(maybeCreateHerdrSubagentReporter(registry)).toBeUndefined();
		$env.HERDR_PANE_ID = "pane-42";
		const gatedSeq = registerAgent("gated");
		emitLifecycle({ id: "gated", status: "started", index: 0 });
		reporter = maybeCreateHerdrSubagentReporter(registry);
		expect(reporter).toBeDefined();
		const fenceSeq = registerAgent("fence");
		emitLifecycle({ id: "fence", status: "started", index: 1 });
		await waitFrames(1);
		expect(frames.length).toBe(1);
		expect(frames[0].params.subagents).toEqual([
			{ id: "gated", agent: "task", status: "working", agent_seq: gatedSeq },
			{ id: "fence", agent: "task", status: "working", agent_seq: fenceSeq },
		]);
	});

	it("reports the full subagent list with mapped statuses and strictly increasing seq", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		expect(reporter).toBeDefined();
		const aSeq = registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0, agent: "explore", description: "scan the repo" });
		await waitFrames(1);
		const bSeq = registerAgent("b");
		emitLifecycle({ id: "b", status: "started", index: 1 });
		await waitFrames(2);
		emitLifecycle({ id: "a", status: "completed", index: 0, agent: "explore" });
		await waitFrames(3);
		emitLifecycle({ id: "b", status: "aborted", index: 1 });
		await waitFrames(4);

		expect(frames[0].method).toBe("pane.report_subagents");
		expect(frames[0].params.pane_id).toBe("pane-42");
		expect(frames[0].params.source).toBe("custom:omp-subagents");
		expect(frames[0].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "working", description: "scan the repo", agent_seq: aSeq },
		]);
		expect(frames[1].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "working", description: "scan the repo", agent_seq: aSeq },
			{ id: "b", agent: "task", status: "working", agent_seq: bSeq },
		]);
		expect(frames[2].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "done", description: "scan the repo", agent_seq: aSeq },
			{ id: "b", agent: "task", status: "working", agent_seq: bSeq },
		]);
		expect(frames[3].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "done", description: "scan the repo", agent_seq: aSeq },
			{ id: "b", agent: "task", status: "failed", agent_seq: bSeq },
		]);
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i].params.seq).toBeGreaterThan(frames[i - 1].params.seq);
		}
	});

	it("coalesces a burst of events into one trailing report", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		const aSeq = registerAgent("a");
		const bSeq = registerAgent("b");
		const cSeq = registerAgent("c");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		emitLifecycle({ id: "b", status: "started", index: 1 });
		emitLifecycle({ id: "c", status: "started", index: 2 });
		emitLifecycle({ id: "a", status: "completed", index: 0 });
		await waitFrames(1);
		registerAgent("d");
		emitLifecycle({ id: "d", status: "started", index: 3 });
		await waitFrames(2);
		expect(frames.length).toBe(2);
		expect(frames[0].params.subagents).toEqual([
			{ id: "a", agent: "task", status: "done", agent_seq: aSeq },
			{ id: "b", agent: "task", status: "working", agent_seq: bSeq },
			{ id: "c", agent: "task", status: "working", agent_seq: cSeq },
		]);
	});

	it("retains finished rows until a new wave starts, then clears them", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		const aSeq = registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		emitLifecycle({ id: "a", status: "failed", index: 0 });
		await waitFrames(2);
		expect(frames[1].params.subagents).toEqual([{ id: "a", agent: "task", status: "failed", agent_seq: aSeq }]);
		const bSeq = registerAgent("b");
		emitLifecycle({ id: "b", status: "started", index: 0 });
		await waitFrames(3);
		expect(frames[2].params.subagents).toEqual([{ id: "b", agent: "task", status: "working", agent_seq: bSeq }]);
	});

	it("reports agent_seq from AgentRegistry, independent of task-batch position", async () => {
		const agents = AgentRegistry.global();
		agents.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		const zedSeq = agents.register({
			id: "zed",
			displayName: "zed",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
		}).seq;
		agents.setStatus("zed", "aborted");
		const betaSeq = agents.register({
			id: "beta",
			displayName: "beta",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
		}).seq;
		const alphaSeq = agents.register({
			id: "alpha",
			displayName: "alpha",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
		}).seq;
		reporter = maybeCreateHerdrSubagentReporter(registry);
		emitLifecycle({ id: "alpha", status: "started", index: 0 });
		emitLifecycle({ id: "beta", status: "started", index: 1 });
		emitLifecycle({ id: "gamma", status: "started", index: 2 });
		await waitFrames(1);
		expect(frames[0].params.subagents).toEqual([
			{ id: "alpha", agent: "task", status: "working", agent_seq: alphaSeq },
			{ id: "beta", agent: "task", status: "working", agent_seq: betaSeq },
			{ id: "gamma", agent: "task", status: "working", agent_seq: 0 },
		]);
		expect(zedSeq).toBeLessThan(betaSeq);
		expect(betaSeq).toBeLessThan(alphaSeq);
	});

	it("resolves dispose only after the final empty-list frame is on the wire", async () => {
		const created = maybeCreateHerdrSubagentReporter(registry);
		if (!created) throw new Error("reporter not created");
		reporter = created;
		registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		let resolved = false;
		const disposePromise = created.dispose().then(() => {
			resolved = true;
		});
		await waitFrames(2);
		expect(resolved).toBe(false);
		await disposePromise;
		expect(frames[1].params.subagents).toEqual([]);
	});

	it("flushes an empty list on registry reset and on dispose, then stops reporting", async () => {
		const created = maybeCreateHerdrSubagentReporter(registry);
		if (!created) throw new Error("reporter not created");
		reporter = created;
		const aSeq = registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		registry.resetSessions();
		await waitFrames(2);
		expect(frames[1].params.subagents).toEqual([]);
		const bSeq = registerAgent("b");
		emitLifecycle({ id: "b", status: "started", index: 0 });
		await waitFrames(3);
		expect(frames[2].params.subagents).toEqual([{ id: "b", agent: "task", status: "working", agent_seq: bSeq }]);
		await created.dispose();
		expect(frames.length).toBe(4);
		expect(frames[3].params.subagents).toEqual([]);
		expect(aSeq).toBeLessThan(bSeq);
		registerAgent("c");
		emitLifecycle({ id: "c", status: "started", index: 0 });
		const { promise: settled, resolve: settledResolve } = Promise.withResolvers<void>();
		setTimeout(settledResolve, 250);
		await settled;
		expect(frames.length).toBe(4);
	});

	it("swallows socket failures and keeps accepting changes", async () => {
		$env.HERDR_SOCKET_PATH = join(dir, "missing.sock");
		const created = maybeCreateHerdrSubagentReporter(registry);
		if (!created) throw new Error("reporter not created");
		reporter = created;
		registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		const { promise: settled, resolve: settledResolve } = Promise.withResolvers<void>();
		setTimeout(settledResolve, 150);
		await settled;
		emitLifecycle({ id: "a", status: "completed", index: 0 });
		await created.dispose();
		expect(frames.length).toBe(0);
	});

	it("includes focused_agent_seq and session_title, flushing on focus/title changes alone", async () => {
		let focusedId: string | undefined;
		const focusListeners = new Set<() => void>();
		let sessionTitle: string | undefined;
		const titleListeners = new Set<() => void>();
		reporter = maybeCreateHerdrSubagentReporter(registry, {
			getFocusedAgentId: () => focusedId,
			onFocusChanged: cb => {
				focusListeners.add(cb);
				return () => focusListeners.delete(cb);
			},
			getSessionTitle: () => sessionTitle,
			onSessionTitleChanged: cb => {
				titleListeners.add(cb);
				return () => titleListeners.delete(cb);
			},
		});
		const aSeq = registerAgent("a");
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		expect(frames[0].params.focused_agent_seq).toBeUndefined();
		expect(frames[0].params.session_title).toBeUndefined();

		focusedId = "a";
		for (const cb of focusListeners) cb();
		await waitFrames(2);
		expect(frames[1].params.focused_agent_seq).toBe(aSeq);
		expect(frames[1].params.subagents).toEqual([{ id: "a", agent: "task", status: "working", agent_seq: aSeq }]);

		sessionTitle = "Fixing the parser";
		for (const cb of titleListeners) cb();
		await waitFrames(3);
		expect(frames[2].params.session_title).toBe("Fixing the parser");
		expect(frames[2].params.focused_agent_seq).toBe(aSeq);
	});
});
