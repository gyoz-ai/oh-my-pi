import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	AgentRegistry,
	listMainSubagentOrdinals,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("listMainSubagentOrdinals", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function registerSub(id: string, status: "running" | "idle" | "parked" | "aborted" = "running") {
		return registry.register({ id, displayName: id, kind: "sub", parentId: MAIN_AGENT_ID, session: null, status });
	}

	it("assigns compact 1-based ordinals to running MAIN subagents in registration order", () => {
		registerSub("alpha");
		registerSub("beta");
		registerSub("gamma");

		expect(listMainSubagentOrdinals().map(ref => ref.id)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("excludes idle, parked, and aborted agents from the ordinal source", () => {
		registerSub("alpha", "idle");
		registerSub("beta");
		registerSub("gamma", "parked");
		registerSub("delta", "aborted");
		registerSub("epsilon");

		expect(listMainSubagentOrdinals().map(ref => ref.id)).toEqual(["beta", "epsilon"]);
	});

	it("excludes the main agent and subagents parented to a non-MAIN agent", () => {
		registerSub("alpha");
		registry.register({
			id: "nested-parent",
			displayName: "nested-parent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
		});
		registry.register({
			id: "nested-child",
			displayName: "nested-child",
			kind: "sub",
			parentId: "nested-parent",
			session: null,
		});

		expect(listMainSubagentOrdinals().map(ref => ref.id)).toEqual(["alpha", "nested-parent"]);
	});

	it("recycles a finished agent's digit and compacts the remaining ordinals down, while it stays reachable by id", () => {
		registerSub("alpha");
		registerSub("beta");
		registerSub("gamma");
		expect(listMainSubagentOrdinals().map(ref => ref.id)).toEqual(["alpha", "beta", "gamma"]);

		registry.setStatus("beta", "idle");

		const ordinals = listMainSubagentOrdinals();
		expect(ordinals.map(ref => ref.id)).toEqual(["alpha", "gamma"]);
		expect(ordinals.findIndex(ref => ref.id === "gamma") + 1).toBe(2);
		expect(registry.get("beta")?.status).toBe("idle");
	});
});
