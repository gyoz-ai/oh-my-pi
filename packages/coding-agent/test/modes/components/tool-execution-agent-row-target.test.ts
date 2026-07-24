import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import type { AgentRowTarget } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TUI } from "@oh-my-pi/pi-tui";

function buildSettledJobBlock(jobs: Array<Record<string, unknown>>) {
	const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
	const component = new ToolExecutionComponent("hub", { op: "wait" }, {}, undefined, uiStub, process.cwd());
	component.updateResult({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs } }, false);
	const container = new TranscriptContainer();
	container.addChild(component);
	container.render(120);
	return container;
}

describe("settled job block click targets through the transcript hit-map", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("resolves a settled task row to its agent id and a bash row to undefined at the exact frame rows", () => {
		AgentRegistry.global().register({ id: "TaskAgent1", displayName: "TaskAgent1", kind: "sub", session: null });
		const container = buildSettledJobBlock([
			{ id: "TaskAgent1", type: "task", status: "completed", label: "TaskAgent1", durationMs: 1_200 },
			{ id: "bash-1", type: "bash", status: "completed", label: "echo hi", durationMs: 500 },
		]);

		const headerHit = container.hitTestBlock(0);
		expect(headerHit).toBeDefined();
		const headerTarget = headerHit!.component as Partial<AgentRowTarget>;
		expect(headerTarget.agentIdAtLocalRow?.(headerHit!.localRow)).toBeUndefined();

		const taskHit = container.hitTestBlock(1);
		expect(taskHit).toBeDefined();
		const taskTarget = taskHit!.component as Partial<AgentRowTarget>;
		expect(taskTarget.agentIdAtLocalRow?.(taskHit!.localRow)).toBe("TaskAgent1");

		const bashHit = container.hitTestBlock(2);
		expect(bashHit).toBeDefined();
		const bashTarget = bashHit!.component as Partial<AgentRowTarget>;
		expect(bashTarget.agentIdAtLocalRow?.(bashHit!.localRow)).toBeUndefined();
	});

	it("resolves undefined at every row of a bash-only settled block", () => {
		const container = buildSettledJobBlock([
			{ id: "bash-1", type: "bash", status: "completed", label: "echo hi", durationMs: 500 },
		]);

		const hit = container.hitTestBlock(1);
		expect(hit).toBeDefined();
		const target = hit!.component as Partial<AgentRowTarget>;
		expect(target.agentIdAtLocalRow?.(hit!.localRow)).toBeUndefined();
	});
});
