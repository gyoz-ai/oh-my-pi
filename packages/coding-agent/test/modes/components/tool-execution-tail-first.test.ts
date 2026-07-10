import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function makeComponent(outputLineCount: number) {
	const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
	const component = new ToolExecutionComponent("some_generic_tool", { probe: true }, {}, undefined, ui);
	const text = Array.from({ length: outputLineCount }, (_, index) => `output line ${index + 1}`).join("\n");
	component.updateResult({ content: [{ type: "text", text }] }, false);
	return component;
}

describe("generic tool output expansion", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
	});

	it("collapsed keeps the head-first 4-line preview with a more-lines footer", () => {
		const component = makeComponent(150);
		const out = stripVTControlCharacters(component.render(120).join("\n"));
		expect(out).toContain("output line 1");
		expect(out).toContain("output line 4");
		expect(out).not.toContain("output line 5\n");
		expect(out).toContain("… 146 more lines");
		expect(out).not.toContain("earlier lines");
	});

	it("expanded shows the tail with an earlier-lines header up to 100 lines", () => {
		const component = makeComponent(150);
		component.setExpanded(true);
		const out = stripVTControlCharacters(component.render(120).join("\n"));
		expect(out).toContain("… 50 earlier lines");
		expect(out).toContain("output line 51");
		expect(out).toContain("output line 150");
		expect(out).not.toContain("output line 50\n");
		expect(out).not.toContain("more lines");
	});

	it("expanded output within the cap renders whole with no elision markers", () => {
		const component = makeComponent(30);
		component.setExpanded(true);
		const out = stripVTControlCharacters(component.render(120).join("\n"));
		expect(out).toContain("output line 1");
		expect(out).toContain("output line 30");
		expect(out).not.toContain("earlier lines");
		expect(out).not.toContain("more lines");
	});
});
