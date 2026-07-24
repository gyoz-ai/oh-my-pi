import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

function fenceRows(lines: readonly string[]): number[] {
	const rows: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (stripVTControlCharacters(lines[i]!).trimStart().startsWith("```")) rows.push(i);
	}
	return rows;
}

describe("Markdown.codeBlockAtRow", () => {
	afterEach(() => {
		clearRenderCache();
	});

	it("maps fence, body, and closing rows of a single block to its exact source", () => {
		const code = "const a = 1;\nconst b = 2;";
		const markdown = new Markdown(`Here is prose.\n\n\`\`\`ts\n${code}\n\`\`\``, 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const fences = fenceRows(lines);

		expect(fences.length).toBe(2);
		const [open, close] = fences as [number, number];
		expect(markdown.codeBlockAtRow(open)).toBe(code);
		expect(markdown.codeBlockAtRow(open + 1)).toBe(code);
		expect(markdown.codeBlockAtRow(close)).toBe(code);
	});

	it("returns undefined for prose rows and rows past the block", () => {
		const code = "const a = 1;\nconst b = 2;";
		const markdown = new Markdown(`Here is prose.\n\n\`\`\`ts\n${code}\n\`\`\``, 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const proseRow = lines.findIndex(line => stripVTControlCharacters(line).includes("Here is prose."));

		expect(proseRow).toBeGreaterThanOrEqual(0);
		expect(markdown.codeBlockAtRow(proseRow)).toBeUndefined();
		expect(markdown.codeBlockAtRow(lines.length)).toBeUndefined();
		expect(markdown.codeBlockAtRow(-1)).toBeUndefined();
	});

	it("resolves the correct block when two blocks are present", () => {
		const first = "let x = 10;";
		const second = "print('hi')";
		const markdown = new Markdown(
			`\`\`\`ts\n${first}\n\`\`\`\n\ntext between\n\n\`\`\`python\n${second}\n\`\`\``,
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = markdown.render(80);
		const fences = fenceRows(lines);

		expect(fences.length).toBe(4);
		const firstBody = lines.findIndex(line => stripVTControlCharacters(line).includes("let x = 10;"));
		const secondBody = lines.findIndex(line => stripVTControlCharacters(line).includes("print('hi')"));

		expect(markdown.codeBlockAtRow(firstBody)).toBe(first);
		expect(markdown.codeBlockAtRow(secondBody)).toBe(second);
	});
});
