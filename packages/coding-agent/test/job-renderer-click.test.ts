import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentRowTarget } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { hubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { Component } from "@oh-my-pi/pi-tui";

interface TestJob {
	id: string;
	type: "task" | "bash";
	status: "completed" | "failed" | "cancelled" | "running";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

function renderJobs(jobs: TestJob[]) {
	const result = { content: [{ type: "text", text: "" }], details: { op: "wait" as const, jobs } };
	const component = hubToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
		theme,
	) as Component & AgentRowTarget;
	const lines = component.render(120) as readonly string[];
	return { lines: lines.map(l => Bun.stripANSI(l)), component };
}

describe("job renderer settled-row click targets", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("resolves a settled task row to its agent id at the exact local row", () => {
		const { lines, component } = renderJobs([
			{
				id: "TaskAgent1",
				type: "task",
				status: "completed",
				label: "TaskAgent1",
				durationMs: 1_200,
			},
			{
				id: "bash-1",
				type: "bash",
				status: "completed",
				label: "echo hi",
				durationMs: 500,
			},
		]);

		expect(lines[1]).toContain("TaskAgent1");
		expect(lines[2]).toContain("echo hi");
		expect(component.agentIdAtLocalRow(0)).toBeUndefined();
		expect(component.agentIdAtLocalRow(1)).toBe("TaskAgent1");
		expect(component.agentIdAtLocalRow(2)).toBeUndefined();
	});

	it("resolves every row of a bash-only settled block to undefined", () => {
		const { component } = renderJobs([
			{ id: "bash-1", type: "bash", status: "completed", label: "echo hi", durationMs: 500 },
			{ id: "bash-2", type: "bash", status: "failed", label: "false", durationMs: 300 },
		]);

		expect(component.agentIdAtLocalRow(0)).toBeUndefined();
		expect(component.agentIdAtLocalRow(1)).toBeUndefined();
		expect(component.agentIdAtLocalRow(2)).toBeUndefined();
	});

	it("maps every wrapped label/preview row of a settled task job to the same agent id", () => {
		const { lines, component } = renderJobs([
			{
				id: "MultiLineAgent",
				type: "task",
				status: "completed",
				label: "MultiLineAgent",
				durationMs: 4_000,
				resultText: "line one of output\nline two of output",
			},
		]);

		expect(lines.length).toBeGreaterThan(2);
		for (let row = 1; row < lines.length; row++) {
			expect(component.agentIdAtLocalRow(row)).toBe("MultiLineAgent");
		}
	});
});
