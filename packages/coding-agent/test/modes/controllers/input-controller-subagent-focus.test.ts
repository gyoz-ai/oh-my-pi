import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

type Listener = (data: string) => { consume?: boolean } | undefined;

function makeHarness() {
	const listeners: Listener[] = [];
	const focusAgentSession = vi.fn(() => Promise.resolve());
	const unfocusSession = vi.fn(() => Promise.resolve());
	const showStatus = vi.fn();
	const customKeyHandlers = new Map<string, () => void>();
	const editor = {
		setActionKeys: vi.fn(),
		setCustomKeyHandler: (key: string, handler: () => void) => {
			customKeyHandlers.set(key, handler);
		},
		clearCustomKeyHandlers: () => customKeyHandlers.clear(),
		getText: () => "",
	};
	const ctx = {
		editor,
		keybindings: { getKeys: () => [] },
		session: { extensionRunner: undefined },
		chatContainer: { children: [] },
		focusedAgentId: undefined,
		toolOutputExpanded: false,
		focusAgentSession,
		unfocusSession,
		showStatus,
		renderSubagentList: vi.fn(),
		canBranchBtw: () => false,
		canCopyBtw: () => false,
		ui: {
			addInputListener: (listener: Listener) => {
				listeners.push(listener);
				return () => {};
			},
			addStartListener: vi.fn(),
			getFocused: () => editor,
			requestRender: vi.fn(),
			resetDisplay: vi.fn(),
			terminal: { write: vi.fn() },
		},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	const feed = (data: string) => listeners.some(listener => listener(data)?.consume === true);
	return { ctx, controller, feed, focusAgentSession, unfocusSession, showStatus };
}

describe("subagent focus via deep-focus sequence", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	beforeEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Anna", displayName: "Anna", kind: "sub", parentId: "Main", session: null });
		registry.register({
			id: "Carl",
			displayName: "Carl",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "aborted",
		});
		registry.register({ id: "Bob", displayName: "Bob", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Advisor", displayName: "Advisor", kind: "advisor", parentId: "Main", session: null });
		registry.register({ id: "Anna.Kid", displayName: "Anna.Kid", kind: "sub", parentId: "Anna", session: null });
	});

	it("focuses the subagent by seq when the deep-focus sequence arrives", () => {
		const { feed, focusAgentSession } = makeHarness();
		expect(feed("\x1b[>8365;2F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Anna");
		expect(feed("\x1b[>8365;4F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		expect(focusAgentSession).toHaveBeenCalledTimes(2);
	});

	it("shows a status message when the seq has no subagent", () => {
		const { feed, focusAgentSession, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;99F")).toBe(true);
		expect(focusAgentSession).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("No subagent #99 to view");
	});

	it("deep-focus while focused unfocuses first and resolves against the main registry", async () => {
		const { ctx, feed, focusAgentSession, unfocusSession } = makeHarness();
		const focusable = ctx as unknown as { focusedAgentId: string | undefined };
		focusable.focusedAgentId = "Bob";
		expect(feed("\x1b[>8365;2F")).toBe(true);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(focusAgentSession).toHaveBeenCalledWith("Anna");
	});

	it("stops the subagent by seq when the stop sequence arrives", async () => {
		const { feed, focusAgentSession, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;2K")).toBe(true);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(AgentRegistry.global().get("Anna")).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Stopped agent Anna");
		expect(focusAgentSession).not.toHaveBeenCalled();
	});

	it("shows a status message when the stop seq has no subagent", () => {
		const { feed, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;99K")).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("No subagent #99 to stop");
	});

	it("keeps a finished subagent's seq resolvable and never recycles it for a later registration", async () => {
		const registry = AgentRegistry.global();
		expect(registry.get("Bob")!.seq).toBe(4);
		registry.setStatus("Bob", "idle");
		const { feed, focusAgentSession } = makeHarness();
		expect(feed("\x1b[>8365;4F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		const zed = registry.register({ id: "Zed", displayName: "Zed", kind: "sub", parentId: "Main", session: null });
		expect(zed.seq).toBe(7);
		expect(feed(`\x1b[>8365;${zed.seq}F`)).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Zed");
	});

	it("parses a multi-digit seq from the CSI", () => {
		const { feed, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;12F")).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("No subagent #12 to view");
	});

	it("resolves a subagent whose seq is multi-digit via the CSI", () => {
		const registry = AgentRegistry.global();
		for (let i = 0; i < 5; i++) {
			registry.register({
				id: `filler-${i}`,
				displayName: `filler-${i}`,
				kind: "sub",
				parentId: "Main",
				session: null,
			});
		}
		const doubleDigit = registry.register({
			id: "DoubleDigit",
			displayName: "DoubleDigit",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		expect(doubleDigit.seq).toBe(12);
		const { feed, focusAgentSession } = makeHarness();
		expect(feed(`\x1b[>8365;${doubleDigit.seq}F`)).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("DoubleDigit");
	});

	it("the deep-focus sequence works without needing an expansion toggle", () => {
		const { ctx, feed, focusAgentSession } = makeHarness();
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(feed("\x1b[>8365;4F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		expect(ctx.toolOutputExpanded).toBe(false);
	});
});
