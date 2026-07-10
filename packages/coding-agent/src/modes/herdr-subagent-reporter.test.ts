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
		subagents: Array<{ id: string; agent: string; status: string; description?: string; index: number }>;
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
		emitLifecycle({ id: "gated", status: "started", index: 0 });
		reporter = maybeCreateHerdrSubagentReporter(registry);
		expect(reporter).toBeDefined();
		emitLifecycle({ id: "fence", status: "started", index: 1 });
		await waitFrames(1);
		expect(frames.length).toBe(1);
		expect(frames[0].params.subagents).toEqual([
			{ id: "gated", agent: "task", status: "working", index: 0 },
			{ id: "fence", agent: "task", status: "working", index: 1 },
		]);
	});

	it("reports the full subagent list with mapped statuses and strictly increasing seq", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		expect(reporter).toBeDefined();
		emitLifecycle({ id: "a", status: "started", index: 0, agent: "explore", description: "scan the repo" });
		await waitFrames(1);
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
			{ id: "a", agent: "explore", status: "working", description: "scan the repo", index: 0 },
		]);
		expect(frames[1].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "working", description: "scan the repo", index: 0 },
			{ id: "b", agent: "task", status: "working", index: 1 },
		]);
		expect(frames[2].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "done", description: "scan the repo", index: 0 },
			{ id: "b", agent: "task", status: "working", index: 1 },
		]);
		expect(frames[3].params.subagents).toEqual([
			{ id: "a", agent: "explore", status: "done", description: "scan the repo", index: 0 },
			{ id: "b", agent: "task", status: "failed", index: 1 },
		]);
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i].params.seq).toBeGreaterThan(frames[i - 1].params.seq);
		}
	});

	it("coalesces a burst of events into one trailing report", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		emitLifecycle({ id: "a", status: "started", index: 0 });
		emitLifecycle({ id: "b", status: "started", index: 1 });
		emitLifecycle({ id: "c", status: "started", index: 2 });
		emitLifecycle({ id: "a", status: "completed", index: 0 });
		await waitFrames(1);
		emitLifecycle({ id: "d", status: "started", index: 3 });
		await waitFrames(2);
		expect(frames.length).toBe(2);
		expect(frames[0].params.subagents).toEqual([
			{ id: "a", agent: "task", status: "done", index: 0 },
			{ id: "b", agent: "task", status: "working", index: 1 },
			{ id: "c", agent: "task", status: "working", index: 2 },
		]);
	});

	it("retains finished rows until a new wave starts, then clears them", async () => {
		reporter = maybeCreateHerdrSubagentReporter(registry);
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		emitLifecycle({ id: "a", status: "failed", index: 0 });
		await waitFrames(2);
		expect(frames[1].params.subagents).toEqual([{ id: "a", agent: "task", status: "failed", index: 0 }]);
		emitLifecycle({ id: "b", status: "started", index: 0 });
		await waitFrames(3);
		expect(frames[2].params.subagents).toEqual([{ id: "b", agent: "task", status: "working", index: 0 }]);
	});

	it("emits indexes from AgentRegistry registration order, not task-batch position", async () => {
		const agents = AgentRegistry.global();
		agents.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		agents.register({ id: "zed", displayName: "zed", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		agents.setStatus("zed", "aborted");
		agents.register({ id: "beta", displayName: "beta", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		agents.register({ id: "alpha", displayName: "alpha", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		reporter = maybeCreateHerdrSubagentReporter(registry);
		emitLifecycle({ id: "alpha", status: "started", index: 0 });
		emitLifecycle({ id: "beta", status: "started", index: 1 });
		emitLifecycle({ id: "gamma", status: "started", index: 2 });
		await waitFrames(1);
		expect(frames[0].params.subagents).toEqual([
			{ id: "alpha", agent: "task", status: "working", index: 1 },
			{ id: "beta", agent: "task", status: "working", index: 0 },
			{ id: "gamma", agent: "task", status: "working", index: 2 },
		]);
	});

	it("resolves dispose only after the final empty-list frame is on the wire", async () => {
		const created = maybeCreateHerdrSubagentReporter(registry);
		if (!created) throw new Error("reporter not created");
		reporter = created;
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
		emitLifecycle({ id: "a", status: "started", index: 0 });
		await waitFrames(1);
		registry.resetSessions();
		await waitFrames(2);
		expect(frames[1].params.subagents).toEqual([]);
		emitLifecycle({ id: "b", status: "started", index: 0 });
		await waitFrames(3);
		expect(frames[2].params.subagents).toEqual([{ id: "b", agent: "task", status: "working", index: 0 }]);
		await created.dispose();
		expect(frames.length).toBe(4);
		expect(frames[3].params.subagents).toEqual([]);
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
		emitLifecycle({ id: "a", status: "started", index: 0 });
		const { promise: settled, resolve: settledResolve } = Promise.withResolvers<void>();
		setTimeout(settledResolve, 150);
		await settled;
		emitLifecycle({ id: "a", status: "completed", index: 0 });
		await created.dispose();
		expect(frames.length).toBe(0);
	});
});
