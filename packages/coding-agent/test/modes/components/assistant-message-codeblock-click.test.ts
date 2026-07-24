import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol } from "@oh-my-pi/pi-tui";

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function leadingBlankRows(lines: readonly string[]): number {
	let leading = 0;
	while (leading < lines.length && !/\S/.test(lines[leading]!)) leading++;
	return leading;
}

function fenceRows(lines: readonly string[]): number[] {
	const rows: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trimStart().startsWith("```")) rows.push(i);
	}
	return rows;
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
});

describe("AssistantMessageComponent.codeBlockAtLocalRow", () => {
	it("maps a stripped-contribution row inside a fenced block to its source", () => {
		const code = "const a = 1;\nconst b = 2;";
		const component = new AssistantMessageComponent(
			createAssistantMessage(`Intro prose.\n\n\`\`\`ts\n${code}\n\`\`\``),
		);
		const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
		const leading = leadingBlankRows(lines);
		const fences = fenceRows(lines);

		expect(fences.length).toBe(2);
		const [open, close] = fences as [number, number];
		expect(component.codeBlockAtLocalRow(open - leading)).toBe(code);
		expect(component.codeBlockAtLocalRow(open + 1 - leading)).toBe(code);
		expect(component.codeBlockAtLocalRow(close - leading)).toBe(code);

		const proseRow = lines.findIndex(line => line.includes("Intro prose."));
		expect(component.codeBlockAtLocalRow(proseRow - leading)).toBeUndefined();
		expect(component.codeBlockAtLocalRow(lines.length)).toBeUndefined();
	});

	it("resolves each block when two blocks are present", () => {
		const first = "let x = 10;";
		const second = "print('hi')";
		const component = new AssistantMessageComponent(
			createAssistantMessage(`\`\`\`ts\n${first}\n\`\`\`\n\nbetween\n\n\`\`\`python\n${second}\n\`\`\``),
		);
		const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
		const leading = leadingBlankRows(lines);
		const firstBody = lines.findIndex(line => line.includes("let x = 10;"));
		const secondBody = lines.findIndex(line => line.includes("print('hi')"));

		expect(component.codeBlockAtLocalRow(firstBody - leading)).toBe(first);
		expect(component.codeBlockAtLocalRow(secondBody - leading)).toBe(second);
	});
});
