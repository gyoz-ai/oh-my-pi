/**
 * Repro for #1701 — omp emits a `tool_choice` naming a function that is
 * absent from the same request's `tools` array, producing a self-inconsistent
 * request body. Spec-strict OpenAI-compatible endpoints reject it with
 * `400 invalid_parameter_error: The tool specified in tool_choice does not
 * match any of the specified tools`.
 *
 * The fix is symmetric to the `tool_choice: "none"` guard handling #1227: the
 * request builder drops a forced named `tool_choice` whenever its named
 * function is not in `params.tools`. The primary defense lives in the agent
 * loop (`refreshToolChoiceForActiveTools` now runs on the queued choice too,
 * not just `options.toolChoice`), but the request builder is the last line of
 * defense for any other caller of `streamOpenAICompletions` (raw SDK use,
 * external callers) emitting a mismatched pair.
 */
import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { normalizeCodexToolChoice } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import * as z from "zod/v4";

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function openaiCompletionsModel(): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		id: "glm-5.1",
		name: "GLM 5.1 (test)",
		provider: "alibaba-modelstudio",
		baseUrl: "https://example.test/v1",
	};
}

function openaiResponsesModel(): Model<"openai-responses"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-responses",
		id: "gpt-5.5",
		name: "GPT 5.5 (test)",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
	};
}

function openaiCodexResponsesModel(): Model<"openai-codex-responses"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-codex-responses",
		id: "gpt-5.5-codex",
		name: "GPT 5.5 Codex (test)",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
	};
}

async function captureCompletionsPayload(
	context: Context,
	opts: Parameters<typeof streamOpenAICompletions>[2],
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(openaiCompletionsModel(), context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

async function captureResponsesPayload(
	context: Context,
	opts: Parameters<typeof streamOpenAIResponses>[2],
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(openaiResponsesModel(), context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

const forkAgentTool: Tool = {
	name: "fork_agent",
	description: "Fork a subagent",
	parameters: z.object({ prompt: z.string() }),
};

const dataforseoSearchTool: Tool = {
	name: "dataforseo_search",
	description: "Search via DataForSEO",
	parameters: z.object({ query: z.string() }),
};

const todoWriteTool: Tool = {
	name: "todo_write",
	description: "Manage a phased task list",
	parameters: z.object({ ops: z.array(z.object({ op: z.string() })) }),
};

describe("issue #1701 — eager-todo forces tool_choice for a tool absent from tools", () => {
	it("drops forced tool_choice in OpenAI Completions when the named function is not in params.tools", async () => {
		// Reproduces the exact mismatch in the captured request body from the issue:
		// a restricted active tool set [fork_agent, dataforseo_search] paired with
		// a forced tool_choice naming todo_write. Without the guard, the wire body
		// is internally inconsistent and strict providers return 400.
		const body = await captureCompletionsPayload(
			{
				messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
				tools: [forkAgentTool, dataforseoSearchTool],
			},
			{ toolChoice: { type: "tool", name: "todo_write" } },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual([
			"fork_agent",
			"dataforseo_search",
		]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps forced tool_choice in OpenAI Completions when the named function is present in params.tools", async () => {
		// Sanity: when the named tool IS offered, the forced choice survives — the
		// guard only drops self-inconsistent pairs.
		const body = await captureCompletionsPayload(
			{
				messages: [{ role: "user", content: "list everything", timestamp: Date.now() }],
				tools: [forkAgentTool, todoWriteTool],
			},
			{ toolChoice: { type: "tool", name: "todo_write" } },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "todo_write" } });
	});

	it("drops forced tool_choice in OpenAI Completions when params.tools is empty", async () => {
		// Empty `tools` (e.g. /btw side channels with a stray forced choice) is the
		// degenerate case of the mismatch. Belt-and-suspenders coverage.
		const body = await captureCompletionsPayload(
			{
				messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
				tools: [],
			},
			{ toolChoice: { type: "tool", name: "todo_write" } },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("drops forced tool_choice in OpenAI Responses when the named function is not in params.tools", async () => {
		const body = await captureResponsesPayload(
			{
				messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
				tools: [forkAgentTool, dataforseoSearchTool],
			},
			{ toolChoice: { type: "tool", name: "todo_write" } },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as { name: string }[]).map(tool => tool.name)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps forced tool_choice in OpenAI Responses when the named function is present in params.tools", async () => {
		const body = await captureResponsesPayload(
			{
				messages: [{ role: "user", content: "list everything", timestamp: Date.now() }],
				tools: [forkAgentTool, todoWriteTool],
			},
			{ toolChoice: { type: "tool", name: "todo_write" } },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect(body.tool_choice).toMatchObject({ type: "function", name: "todo_write" });
	});

	it("drops forced tool_choice in OpenAI Codex Responses when the named function is not in params.tools", () => {
		expect(
			normalizeCodexToolChoice(
				{ type: "tool", name: "todo_write" },
				[forkAgentTool, dataforseoSearchTool],
				openaiCodexResponsesModel(),
			),
		).toBeUndefined();
	});

	it("keeps forced tool_choice in OpenAI Codex Responses when the named function is present in params.tools", () => {
		expect(
			normalizeCodexToolChoice(
				{ type: "tool", name: "todo_write" },
				[forkAgentTool, todoWriteTool],
				openaiCodexResponsesModel(),
			),
		).toEqual({ type: "function", name: "todo_write" });
	});
});
