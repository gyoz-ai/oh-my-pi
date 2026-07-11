import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "../../session/messages";
import { initTheme } from "../theme/theme";
import { assistantUsageIsBilled, buildAsyncResultBlock } from "./transcript-render-helpers";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

function asyncResultMessage(details: Record<string, unknown>): CustomMessage {
	return {
		role: "custom",
		customType: "async-result",
		content: "",
		display: true,
		details,
		timestamp: Date.now(),
	};
}

describe("buildAsyncResultBlock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("makes a task-typed row a click target and appends the click-here hint", () => {
		const block = buildAsyncResultBlock(asyncResultMessage({ jobId: "task-1", type: "task", label: "explore" }));
		expect(block.agentIdAtLocalRow(0)).toBe("task-1");
		const line = Bun.stripANSI((block.children[0] as Text).getText());
		expect(line).toContain("Background job completed");
		expect(line).toContain("(click here to see output)");
	});

	it("leaves a bash-typed row unclickable with no hint", () => {
		const block = buildAsyncResultBlock(asyncResultMessage({ jobId: "bash-1", type: "bash" }));
		expect(block.agentIdAtLocalRow(0)).toBeUndefined();
		const line = Bun.stripANSI((block.children[0] as Text).getText());
		expect(line).toContain("Background job completed");
		expect(line).not.toContain("click here");
	});

	it("resolves each row independently in a mixed batch", () => {
		const block = buildAsyncResultBlock(
			asyncResultMessage({
				jobs: [
					{ jobId: "task-1", type: "task" },
					{ jobId: "bash-1", type: "bash" },
				],
			}),
		);
		expect(block.agentIdAtLocalRow(0)).toBe("task-1");
		expect(block.agentIdAtLocalRow(1)).toBeUndefined();
		expect(Bun.stripANSI((block.children[0] as Text).getText())).toContain("(click here to see output)");
		expect(Bun.stripANSI((block.children[1] as Text).getText())).not.toContain("click here");
	});
});
