import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("AgentRegistry seq", () => {
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

	it("assigns a monotonically increasing seq in registration order", () => {
		const alpha = registerSub("alpha");
		const beta = registerSub("beta");
		const gamma = registerSub("gamma");
		expect([alpha.seq, beta.seq, gamma.seq]).toEqual([2, 3, 4]);
	});

	it("never recycles a finished agent's seq for a later registration", () => {
		const alpha = registerSub("alpha");
		const beta = registerSub("beta");
		registry.setStatus("beta", "idle");
		const gamma = registerSub("gamma");
		expect(gamma.seq).toBeGreaterThan(beta.seq);
		expect(gamma.seq).toBeGreaterThan(alpha.seq);
		expect(registry.get("beta")?.status).toBe("idle");
	});

	it("resolves any registered status by seq via getBySeq", () => {
		const alpha = registerSub("alpha");
		const beta = registerSub("beta", "parked");
		expect(registry.getBySeq(alpha.seq)?.id).toBe("alpha");
		expect(registry.getBySeq(beta.seq)?.id).toBe("beta");
	});

	it("returns undefined from getBySeq for an unassigned seq", () => {
		registerSub("alpha");
		expect(registry.getBySeq(999)).toBeUndefined();
	});
});
