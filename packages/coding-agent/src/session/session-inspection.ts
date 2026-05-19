/**
 * Pure read-only computations over AgentSession message history and session state.
 *
 * Extracted from AgentSession because nothing in here depends on the live class
 * instance — only on data already exposed via the public AgentState / SessionManager
 * surface. Keeping these as free functions makes them independently testable and
 * keeps the AgentSession class focused on lifecycle and mutation.
 */

import type { AgentMessage, AgentState, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { calculateContextTokens, calculatePromptTokens, estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { exportSessionToHtml } from "../export/html";
import type { ContextUsage } from "../extensibility/extensions/types";
import { getCurrentThemeName } from "../modes/theme/theme";
import type { CompactionSummaryMessage, CustomMessage, FileMentionMessage } from "./messages";
import { formatSessionDumpText, type SessionDumpToolInfo } from "./session-dump-format";
import { getLatestCompactionEntry, type SessionEntry, type SessionManager } from "./session-manager";

/** Session statistics for `/session` and RPC clients. */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
}

interface ToolResultUsageDetails {
	usage?: Usage;
}

function isToolResultDetails(value: unknown): value is ToolResultUsageDetails {
	return value !== null && typeof value === "object";
}

function readTaskToolUsage(details: unknown): Usage | undefined {
	if (!isToolResultDetails(details)) return undefined;
	const usage = details.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage;
}

/** Aggregate per-message stats into the `/session` summary shape. */
export function calculateSessionStats(args: {
	messages: readonly AgentMessage[];
	sessionFile: string | undefined;
	sessionId: string;
}): SessionStats {
	const { messages, sessionFile, sessionId } = args;
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalPremiumRequests = 0;
	let totalCost = 0;

	for (const message of messages) {
		if (message.role === "user") userMessages++;
		if (message.role === "toolResult") toolResults++;

		if (message.role === "assistant") {
			assistantMessages++;
			const assistant = message as AssistantMessage;
			toolCalls += assistant.content.filter(c => c.type === "toolCall").length;
			totalInput += assistant.usage.input;
			totalOutput += assistant.usage.output;
			totalCacheRead += assistant.usage.cacheRead;
			totalCacheWrite += assistant.usage.cacheWrite;
			totalPremiumRequests += assistant.usage.premiumRequests ?? 0;
			totalCost += assistant.usage.cost.total;
		}

		if (message.role === "toolResult" && message.toolName === "task") {
			const usage = readTaskToolUsage(message.details);
			if (usage) {
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalPremiumRequests += usage.premiumRequests ?? 0;
				totalCost += usage.cost.total;
			}
		}
	}

	return {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
		premiumRequests: totalPremiumRequests,
	};
}

/**
 * Compute context usage for the current branch. Returns `undefined` when the
 * model is unknown or has no context window, `{ tokens: null }` when usage is
 * stale post-compaction, or a populated `{ tokens, percent }` otherwise.
 */
export function calculateSessionContextUsage(args: {
	model: Model | undefined;
	branchEntries: SessionEntry[];
	messages: readonly AgentMessage[];
}): ContextUsage | undefined {
	const { model, branchEntries, messages } = args;
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// Only trust usage from an assistant that responded after the latest compaction.
	const latestCompaction = getLatestCompactionEntry(branchEntries);
	if (latestCompaction) {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const assistant = entry.message;
			if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
				hasPostCompactionUsage = calculateContextTokens(assistant.usage) > 0;
				break;
			}
		}
		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const tokens = estimateContextTokens(messages);
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

function estimateContextTokens(messages: readonly AgentMessage[]): number {
	let lastUsageIndex: number | null = null;
	let lastUsage: Usage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.usage) {
			lastUsage = assistant.usage;
			lastUsageIndex = i;
			break;
		}
	}

	if (!lastUsage || lastUsageIndex === null) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return estimated;
	}

	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}
	return calculatePromptTokens(lastUsage) + trailingTokens;
}

function findCopyCandidateAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		// Skip aborted messages with no content — the user can't copy nothing.
		if (assistant.stopReason === "aborted" && assistant.content.length === 0) continue;
		return assistant;
	}
}

/** Text content of the most recent copy-eligible assistant message. */
export function getLastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	const lastAssistant = findCopyCandidateAssistant(messages);
	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of lastAssistant.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() || undefined;
}

/** Whether a copyable assistant message exists. Cheaper than building the text. */
export function hasCopyCandidateAssistantMessage(messages: readonly AgentMessage[]): boolean {
	return findCopyCandidateAssistant(messages) !== undefined;
}

/**
 * Text content of the most recent visible handoff custom message.
 *
 * Fresh handoff sessions store the handoff context as a custom message, not an
 * assistant message, so `/copy` callers fall back here when no assistant
 * response has arrived yet.
 */
export function getLastVisibleHandoffText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "custom") continue;

		const customMessage = message as CustomMessage;
		if (customMessage.customType !== "handoff" || !customMessage.display) continue;

		if (typeof customMessage.content === "string") {
			return customMessage.content.trim() || undefined;
		}

		let text = "";
		for (const content of customMessage.content) {
			if (content.type === "text") text += content.text;
		}
		return text.trim() || undefined;
	}
}

/**
 * Compact subagent-facing summary: only user/developer messages, assistant
 * text, file-mention markers, and compaction summaries. Tool calls, thinking
 * blocks, and tool results are intentionally dropped.
 */
export function formatCompactConversationContext(messages: readonly AgentMessage[]): string {
	const lines: string[] = [
		"# Conversation Context",
		"",
		"This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
		"",
	];

	for (const message of messages) {
		if (message.role === "user" || message.role === "developer") {
			lines.push(message.role === "developer" ? "## Developer" : "## User", "");
			if (typeof message.content === "string") {
				lines.push(message.content);
			} else {
				for (const content of message.content) {
					if (content.type === "text") lines.push(content.text);
					else if (content.type === "image") lines.push("[Image attached]");
				}
			}
			lines.push("");
		} else if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const textParts: string[] = [];
			for (const content of assistant.content) {
				if (content.type === "text" && content.text.trim()) textParts.push(content.text);
			}
			if (textParts.length > 0) lines.push("## Assistant", "", textParts.join("\n\n"), "");
		} else if (message.role === "fileMention") {
			const fileMessage = message as FileMentionMessage;
			lines.push(`[Files referenced: ${fileMessage.files.map(f => f.path).join(", ")}]`, "");
		} else if (message.role === "compactionSummary") {
			const summaryMessage = message as CompactionSummaryMessage;
			lines.push("## Earlier Context (Summarized)", "", summaryMessage.summary, "");
		}
		// Skipped: toolResult, bashExecution, pythonExecution, branchSummary, custom, hookMessage
	}

	return lines.join("\n").trim();
}

/** Full plain-text/markdown dump of the session (clipboard / `/dump` export). */
export function formatSessionText(args: {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
}): string {
	return formatSessionDumpText(args);
}

/** Render the session to a static HTML viewer at `outputPath` (defaults to the session directory). */
export async function exportSessionHtml(
	sessionManager: SessionManager,
	state: AgentState,
	outputPath?: string,
): Promise<string> {
	const themeName = getCurrentThemeName();
	return exportSessionToHtml(sessionManager, state, { outputPath, themeName });
}
