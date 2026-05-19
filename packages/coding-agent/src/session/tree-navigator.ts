/**
 * Owns branch-creation and in-file tree-navigation extracted from AgentSession.
 *
 * Responsibilities:
 *  - Encapsulates the `branch()` operation that forks the session into a new
 *    file rooted at a chosen user-message entry.
 *  - Encapsulates `navigateTree()` — switching the leaf within the current
 *    session file, optionally with an LLM-generated branch summary.
 *  - Owns the abort controller for branch summarization (`abortBranchSummary`).
 *  - Provides `getUserMessagesForBranching()` for the branch selector UI.
 *
 * AgentSession provides the narrow `TreeNavigatorHost` surface so this module
 * never reaches into private session state. The host wires its own internal
 * sync callbacks (`prepareBranch`, `onBranchSessionCreated`,
 * `afterHistoryRewrite`) that this navigator invokes at well-defined points.
 */

import type { Agent } from "@oh-my-pi/pi-agent-core";
import { resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { collectEntriesForBranchSummary, generateBranchSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type {
	ExtensionRunner,
	SessionBeforeBranchResult,
	SessionBeforeTreeResult,
	TreePreparation,
} from "../extensibility/extensions";
import { deobfuscateSessionContext, type SecretObfuscator } from "../secrets/obfuscator";
import { convertToLlm } from "./messages";
import type { BranchSummaryEntry, SessionContext, SessionEntry, SessionManager } from "./session-manager";

/**
 * Live-read AgentSession state plus narrow callbacks the navigator needs.
 *
 * The three lifecycle methods are non-trivial:
 *  - `prepareBranch` flushes pending writes, clears in-flight messages, and
 *    cancels owned async jobs before a branch is created.
 *  - `onBranchSessionCreated` syncs private session state that depends on the
 *    new session id: todo phases, agent session id, hindsight memory rekey,
 *    conversation tracking reset.
 *  - `afterHistoryRewrite` runs the post-rewrite restore: MCP selections,
 *    optional message replacement, optional todo sync, and conditional Codex
 *    provider session cleanup.
 */
export interface TreeNavigatorHost {
	readonly sessionManager: SessionManager;
	readonly model: Model | undefined;
	readonly sessionId: string;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly obfuscator: SecretObfuscator | undefined;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly agent: Agent;
	prepareBranch(): Promise<void>;
	onBranchSessionCreated(): void;
	afterHistoryRewrite(context: SessionContext, opts: { replaceMessages: boolean; syncTodos: boolean }): Promise<void>;
}

export interface BranchResult {
	selectedText: string;
	cancelled: boolean;
}

export interface NavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
}

export interface NavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
	/** Raw session context built during navigation; pass to renderInitialMessages to skip a second O(N) walk. */
	sessionContext?: SessionContext;
}

interface MessageContentBlock {
	type: string;
	text?: string;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	if (value === null || typeof value !== "object") return false;
	const block = value as MessageContentBlock;
	return block.type === "text" && typeof block.text === "string";
}

/**
 * Extract plain text from a message content field (string or typed content
 * array). Tolerates malformed/legacy entries — non-string non-array content
 * returns `""` rather than throwing, mirroring the historical behavior session
 * logs depend on.
 */
export function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map(block => block.text)
		.join("");
}

export class TreeNavigator {
	readonly #host: TreeNavigatorHost;
	#branchSummaryAbortController: AbortController | undefined;

	constructor(host: TreeNavigatorHost) {
		this.#host = host;
	}

	/**
	 * Create a branch from `entryId` (must be a user-message entry), producing
	 * a new session file containing the conversation history up to (but not
	 * including) that message.
	 */
	async branch(entryId: string): Promise<BranchResult> {
		const previousSessionFile = this.#host.sessionManager.getSessionFile();
		const selectedEntry = this.#host.sessionManager.getEntry(entryId);
		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = extractMessageText(selectedEntry.message.content);
		let skipConversationRestore = false;
		const runner = this.#host.extensionRunner;
		if (runner?.hasHandlers("session_before_branch")) {
			const result = (await runner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;
			if (result?.cancel) return { selectedText, cancelled: true };
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		await this.#host.prepareBranch();
		if (!selectedEntry.parentId) {
			await this.#host.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.#host.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#host.onBranchSessionCreated();

		const sessionContext = deobfuscateSessionContext(
			this.#host.sessionManager.buildSessionContext(),
			this.#host.obfuscator,
		);
		if (runner) {
			await runner.emit({ type: "session_branch", previousSessionFile });
		}
		await this.#host.afterHistoryRewrite(sessionContext, {
			replaceMessages: !skipConversationRestore,
			// onBranchSessionCreated already synced todos for the new session.
			syncTodos: false,
		});
		return { selectedText, cancelled: false };
	}

	/**
	 * Navigate to a different leaf within the current session file. Unlike
	 * `branch()` this does not create a new session — it only switches the
	 * leaf pointer (optionally inserting a branch summary first).
	 */
	async navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		const oldLeafId = this.#host.sessionManager.getLeafId();
		if (targetId === oldLeafId) return { cancelled: false };
		if (options.summarize && !this.#host.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.#host.sessionManager.getEntry(targetId);
		if (!targetEntry) throw new Error(`Entry ${targetId} not found`);

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.#host.sessionManager,
			oldLeafId,
			targetId,
		);
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		this.#branchSummaryAbortController = new AbortController();
		const runner = this.#host.extensionRunner;
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		if (runner?.hasHandlers("session_before_tree")) {
			const result = (await runner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;
			if (result?.cancel) return { cancelled: true };
			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const summarizerResult = await this.#runDefaultSummarizer(
				entriesToSummarize,
				options.customInstructions,
				this.#branchSummaryAbortController.signal,
			);
			this.#branchSummaryAbortController = undefined;
			if (summarizerResult.aborted) return { cancelled: true, aborted: true };
			summaryText = summarizerResult.summary;
			summaryDetails = summarizerResult.details;
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		const { newLeafId, editorText } = resolveNavigationTarget(targetId, targetEntry);

		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			const summaryId = this.#host.sessionManager.branchWithSummary(
				newLeafId,
				summaryText,
				summaryDetails,
				fromExtension,
			);
			summaryEntry = this.#host.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			this.#host.sessionManager.resetLeaf();
		} else {
			this.#host.sessionManager.branch(newLeafId);
		}

		// Build the raw context now (before any session_tree extension hook can
		// mutate entries) and deobfuscate it for the history-rewrite phase.
		const stateContext = this.#host.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#host.obfuscator);

		await this.#host.afterHistoryRewrite(displayContext, { replaceMessages: true, syncTodos: true });
		this.#branchSummaryAbortController = undefined;

		// Skip the session_tree emit + raw-context rebuild when no handlers are
		// registered — handlers are the only thing that can mutate entries.
		if (!runner?.hasHandlers("session_tree")) {
			return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
		}
		await runner.emit({
			type: "session_tree",
			newLeafId: this.#host.sessionManager.getLeafId(),
			oldLeafId,
			summaryEntry,
			fromExtension: summaryText ? fromExtension : undefined,
		});
		return {
			editorText,
			cancelled: false,
			summaryEntry,
			sessionContext: this.#host.sessionManager.buildSessionContext(),
		};
	}

	/** All user-message entries in the current branch (for the branch selector). */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const result: Array<{ entryId: string; text: string }> = [];
		for (const entry of this.#host.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = extractMessageText(entry.message.content);
			if (text) result.push({ entryId: entry.id, text });
		}
		return result;
	}

	/** Cancel any in-progress branch summarization. */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	async #runDefaultSummarizer(
		entriesToSummarize: TreePreparation["entriesToSummarize"],
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<{ summary?: string; details?: unknown; aborted?: boolean }> {
		const model = this.#host.model;
		if (!model) throw new Error("No model available for summarization");
		const apiKey = await this.#host.modelRegistry.getApiKey(model, this.#host.sessionId);
		if (!apiKey) throw new Error(`No API key for ${model.provider}`);
		const branchSummarySettings = this.#host.settings.getGroup("branchSummary");
		const result = await generateBranchSummary(entriesToSummarize, {
			model,
			apiKey,
			signal,
			customInstructions,
			reserveTokens: branchSummarySettings.reserveTokens,
			metadata: this.#host.agent.metadataForProvider(model.provider),
			convertToLlm,
			telemetry: resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId),
		});
		if (result.aborted) return { aborted: true };
		if (result.error) throw new Error(result.error);
		return {
			summary: result.summary,
			details: {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			},
		};
	}
}

interface NavigationTarget {
	newLeafId: string | null;
	editorText: string | undefined;
}

function resolveNavigationTarget(targetId: string, targetEntry: SessionEntry): NavigationTarget {
	if (targetEntry.type === "message" && targetEntry.message.role === "user") {
		// Land on the parent so the user can edit the message they originally sent.
		return {
			newLeafId: targetEntry.parentId,
			editorText: extractMessageText(targetEntry.message.content),
		};
	}
	if (targetEntry.type === "custom_message") {
		return {
			newLeafId: targetEntry.parentId,
			editorText:
				typeof targetEntry.content === "string" ? targetEntry.content : extractMessageText(targetEntry.content),
		};
	}
	return { newLeafId: targetId, editorText: undefined };
}
