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
	const pressKey = (key: string) => customKeyHandlers.get(key)?.();
	return { ctx, controller, feed, pressKey, focusAgentSession, unfocusSession, showStatus };
}

describe("subagent focus via deep-focus sequence and ctrl+k chord", () => {
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

	it("focuses the Nth non-aborted subagent when the deep-focus sequence arrives", () => {
		const { feed, focusAgentSession } = makeHarness();
		expect(feed("\x1b[>8365;1F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Anna");
		expect(feed("\x1b[>8365;2F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		expect(focusAgentSession).toHaveBeenCalledTimes(2);
	});

	it("shows a status message when the sequence ordinal has no subagent", () => {
		const { feed, focusAgentSession, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;7F")).toBe(true);
		expect(focusAgentSession).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("No subagent #7 to view");
	});

	it("deep-focus while focused unfocuses first and resolves against the main registry", async () => {
		const { ctx, feed, focusAgentSession, unfocusSession } = makeHarness();
		const focusable = ctx as unknown as { focusedAgentId: string | undefined };
		focusable.focusedAgentId = "Bob";
		expect(feed("\x1b[>8365;1F")).toBe(true);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(focusAgentSession).toHaveBeenCalledWith("Anna");
	});

	it("stops the Nth subagent when the stop sequence arrives", async () => {
		const { feed, focusAgentSession, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;1K")).toBe(true);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(AgentRegistry.global().get("Anna")).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Stopped agent Anna");
		expect(focusAgentSession).not.toHaveBeenCalled();
	});

	it("shows a status message when the stop ordinal has no subagent", () => {
		const { feed, showStatus } = makeHarness();
		expect(feed("\x1b[>8365;7K")).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("No subagent #7 to stop");
	});

	it("digits pass through when the chord window is not armed", () => {
		const { feed, focusAgentSession } = makeHarness();
		expect(feed("1")).toBe(false);
		expect(focusAgentSession).not.toHaveBeenCalled();
	});

	it("ctrl+k arms a one-shot digit chord that focuses the Nth subagent", () => {
		const { feed, pressKey, focusAgentSession } = makeHarness();
		pressKey("ctrl+k");
		expect(feed("2")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		expect(feed("1")).toBe(false);
		expect(focusAgentSession).toHaveBeenCalledTimes(1);
	});

	it("any non-digit input disarms the chord window", () => {
		const { feed, pressKey, focusAgentSession } = makeHarness();
		pressKey("ctrl+k");
		expect(feed("x")).toBe(false);
		expect(feed("1")).toBe(false);
		expect(focusAgentSession).not.toHaveBeenCalled();
	});

	it("the deep-focus sequence works without arming and needs no expansion toggle", () => {
		const { ctx, feed, focusAgentSession } = makeHarness();
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(feed("\x1b[>8365;2F")).toBe(true);
		expect(focusAgentSession).toHaveBeenCalledWith("Bob");
		expect(ctx.toolOutputExpanded).toBe(false);
	});

	it("the expansion toggle no longer arms the digit chord", () => {
		const { controller, feed, focusAgentSession } = makeHarness();
		controller.toggleToolOutputExpansion();
		expect(feed("1")).toBe(false);
		expect(focusAgentSession).not.toHaveBeenCalled();
	});
});
