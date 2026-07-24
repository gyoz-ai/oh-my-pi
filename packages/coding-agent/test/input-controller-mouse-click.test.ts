import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TUI } from "@oh-my-pi/pi-tui";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

type FakeEditor = {
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onHistorySearch?: () => void;
	onPasteImage?: () => Promise<boolean>;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onRetry?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	onLeftAtStart?: () => void;
	onSpaceHoldStart?: () => void;
	onSpaceHoldEnd?: () => void;
	sttHoldEnabled?: () => boolean;
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pasteText(text: string): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(historyText?: string): void;
};

function dispatchInput(listeners: InputListener[], data: string): InputListenerResult {
	for (const listener of listeners) {
		const result = listener(data);
		if (result?.consume) return result;
	}
	return undefined;
}

function registeredInputListeners(addInputListener: Mock<(listener: InputListener) => void>): InputListener[] {
	return addInputListener.mock.calls.map(call => call[0]);
}

function sgrPress(col: number, row: number): string {
	return `\x1b[<0;${col};${row}M`;
}

function sgrWheelUp(col: number, row: number): string {
	return `\x1b[<64;${col};${row}M`;
}

function createContext() {
	let editorText = "";
	let focused: unknown;
	const customHandlers = new Map<string, () => void>();
	const setCustomKeyHandler = vi.fn((key: string, handler: () => void) => {
		customHandlers.set(key, handler);
	});
	const addInputListener = vi.fn((_listener: InputListener) => () => {});
	const hitTestScreenRow = vi.fn<(row: number) => { component: unknown; localRow: number } | undefined>(
		() => undefined,
	);
	const hasOverlay = vi.fn(() => false);
	const chatContainerHitTestBlock = vi.fn<(row: number) => { component: unknown; localRow: number } | undefined>(
		() => undefined,
	);
	const chatContainer = { hitTestBlock: chatContainerHitTestBlock };
	const subagentContainer = {};
	const subagentHudAgentIdAtRow = vi.fn<(row: number) => string | undefined>(() => undefined);
	const focusAgentSession = vi.fn(async (_id: string) => {});
	const unfocusSession = vi.fn(async () => {});
	const showStatus = vi.fn();
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		prompt: vi.fn(async () => {}),
		queuedMessageCount: 0,
		abort: vi.fn(async () => {}),
		retry: vi.fn(async () => true),
	};
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pasteText(text: string) {
			editorText += text;
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler,
		clearCustomKeyHandlers: vi.fn(() => customHandlers.clear()),
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	focused = editor;
	const ctxImpl = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender: vi.fn(),
			resetDisplay: vi.fn(),
			addInputListener,
			addStartListener: vi.fn(),
			getFocused: vi.fn(() => focused),
			hitTestScreenRow,
			hasOverlay,
			terminal: { write: vi.fn() },
		} as unknown as InteractiveModeContext["ui"],
		chatContainer: chatContainer as unknown as InteractiveModeContext["chatContainer"],
		subagentContainer: subagentContainer as unknown as InteractiveModeContext["subagentContainer"],
		subagentHudAgentIdAtRow,
		focusedAgentId: undefined as string | undefined,
		focusAgentSession,
		unfocusSession,
		session: session as unknown as InteractiveModeContext["session"],
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings: { getKeys: () => [] } as unknown as InteractiveModeContext["keybindings"],
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		updatePendingMessagesDisplay: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		hasActiveBtw: vi.fn(() => false),
		handleBtwBranchKey: vi.fn(async () => true),
		canBranchBtw: vi.fn(() => false),
		canCopyBtw: vi.fn(() => false),
		handleBtwCopyKey: vi.fn(async () => true),
		showAgentHub: vi.fn(),
		showError: vi.fn(),
		showStatus,
	};
	const ctx = ctxImpl as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		setFocused(target: unknown) {
			focused = target;
		},
		setFocusedAgentId(id: string | undefined) {
			ctxImpl.focusedAgentId = id;
		},
		spies: {
			addInputListener,
			hitTestScreenRow,
			hasOverlay,
			chatContainerHitTestBlock,
			subagentHudAgentIdAtRow,
			focusAgentSession,
			unfocusSession,
			showStatus,
		},
	};
}

describe("InputController main-screen mouse click", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("decodes and consumes SGR mouse bytes without leaking them into the editor", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		const result = dispatchInput(listeners, sgrPress(5, 3));

		expect(result).toEqual({ consume: true });
		expect(editor.getText()).toBe("");
	});

	it("ignores-and-consumes wheel events instead of resolving a click target", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		const result = dispatchInput(listeners, sgrWheelUp(5, 3));

		expect(result).toEqual({ consume: true });
		expect(spies.hitTestScreenRow).not.toHaveBeenCalled();
	});

	it("does not intercept mouse bytes while an overlay is visible", async () => {
		const { ctx, spies } = createContext();
		spies.hasOverlay.mockReturnValue(true);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		const result = dispatchInput(listeners, sgrPress(5, 3));

		expect(result).toBeUndefined();
		expect(spies.hitTestScreenRow).not.toHaveBeenCalled();
	});

	it("clicking a chatContainer async-result row focuses that row's agent", async () => {
		const { ctx, spies } = createContext();
		spies.hitTestScreenRow.mockReturnValue({ component: ctx.chatContainer, localRow: 4 });
		spies.chatContainerHitTestBlock.mockReturnValue({
			component: { agentIdAtLocalRow: (row: number) => (row === 1 ? "Worker" : undefined) },
			localRow: 1,
		});
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		dispatchInput(listeners, sgrPress(3, 5));
		await Promise.resolve();
		await Promise.resolve();

		expect(spies.focusAgentSession).toHaveBeenCalledWith("Worker");
		expect(spies.unfocusSession).not.toHaveBeenCalled();
	});

	it("clicking a subagent HUD row focuses that row's agent, unfocusing the current one first", async () => {
		const { ctx, spies, setFocusedAgentId } = createContext();
		setFocusedAgentId("OtherAgent");
		spies.hitTestScreenRow.mockReturnValue({ component: ctx.subagentContainer, localRow: 2 });
		spies.subagentHudAgentIdAtRow.mockReturnValue("HudWorker");
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		dispatchInput(listeners, sgrPress(3, 5));
		await Promise.resolve();
		await Promise.resolve();

		expect(spies.subagentHudAgentIdAtRow).toHaveBeenCalledWith(2);
		expect(spies.unfocusSession).toHaveBeenCalledTimes(1);
		expect(spies.focusAgentSession).toHaveBeenCalledWith("HudWorker");
	});

	it("clicking a row with no resolvable agent is a silent no-op", async () => {
		const { ctx, spies } = createContext();
		spies.hitTestScreenRow.mockReturnValue({ component: {}, localRow: 2 });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		dispatchInput(listeners, sgrPress(3, 5));
		await Promise.resolve();

		expect(spies.focusAgentSession).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("clicking a settled task row in a job poll block focuses that job's agent", async () => {
		const { ctx, spies } = createContext();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const jobBlock = new ToolExecutionComponent("hub", { op: "wait" }, {}, undefined, uiStub, process.cwd());
		jobBlock.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					jobs: [
						{ id: "TaskAgent1", type: "task", status: "completed", label: "TaskAgent1", durationMs: 1_200 },
						{ id: "bash-1", type: "bash", status: "completed", label: "echo hi", durationMs: 500 },
					],
				},
			},
			false,
		);
		jobBlock.render(120);
		spies.hitTestScreenRow.mockReturnValue({ component: ctx.chatContainer, localRow: 6 });
		spies.chatContainerHitTestBlock.mockReturnValue({ component: jobBlock, localRow: 1 });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		dispatchInput(listeners, sgrPress(3, 5));
		await Promise.resolve();
		await Promise.resolve();

		expect(spies.focusAgentSession).toHaveBeenCalledWith("TaskAgent1");
	});

	it("clicking a settled bash row in a job poll block is a silent no-op", async () => {
		const { ctx, spies } = createContext();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const jobBlock = new ToolExecutionComponent("hub", { op: "wait" }, {}, undefined, uiStub, process.cwd());
		jobBlock.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					jobs: [
						{ id: "TaskAgent1", type: "task", status: "completed", label: "TaskAgent1", durationMs: 1_200 },
						{ id: "bash-1", type: "bash", status: "completed", label: "echo hi", durationMs: 500 },
					],
				},
			},
			false,
		);
		jobBlock.render(120);
		spies.hitTestScreenRow.mockReturnValue({ component: ctx.chatContainer, localRow: 6 });
		spies.chatContainerHitTestBlock.mockReturnValue({ component: jobBlock, localRow: 2 });
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const listeners = registeredInputListeners(spies.addInputListener);
		dispatchInput(listeners, sgrPress(3, 5));
		await Promise.resolve();

		expect(spies.focusAgentSession).not.toHaveBeenCalled();
	});
});
