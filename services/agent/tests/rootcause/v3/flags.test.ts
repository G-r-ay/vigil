// The loop's behaviour switches: on by default, as the reference run had them; off is the reference loop's other path.
import { describe, expect, it } from "vitest";
import { buildAttributionPatch } from "../../../plugins/rootcause/v3/attribution.js";
import { defaultConfig, type AgentConfig } from "../../../plugins/rootcause/v3/config.js";
import { configFor } from "../../../plugins/rootcause/v3/engine.js";
import { applyPatch, createGraph, emptyPatch, sharedValue, type Graph, type GraphPatch } from "../../../plugins/rootcause/v3/graph.js";
import { check, type TurnRequest } from "../../../plugins/rootcause/v3/model/client.js";
import { run } from "../../../plugins/rootcause/v3/orchestrator.js";
import { Registry } from "../../../plugins/rootcause/v3/tools/registry.js";
import { MemoryTrace } from "../../../plugins/rootcause/v3/trace.js";
import type { Alert } from "../../../plugins/rootcause/v3/types.js";
import { cfg as base, ev, node, seeded } from "./helpers.js";

// The settings the reference loop (v3-temp) recorded for the run this port is measured against.
const REFERENCE = {
  model: "claude-opus-4-8", maxTurns: 1000000000, maxTotalTokens: 1000000000000, maxWallClockMinutes: 1000000000, maxUsd: 20,
  priceInPerM: 5, priceOutPerM: 25, maxToolCallsPerTurn: 6, scopeModel: "claude-sonnet-5", scopePriceScale: 0.6, refusalFallbackModel: "claude-sonnet-5",
  strengthenSearches: 3, rareSweep: true, maxTheorize: 8, theorizeEvery: 4, branchEvery: 6, rawOutputMaxChars: 20000, toolTimeoutMs: 90000,
  maxStrengthenAttempts: 3, maxExpandAttempts: 2, stallDelta: 0.05, maxForksPerNode: 3, maxForwardSteps: 3, lookbackDays: 14, stitchWindowMinutes: 30,
  linkNeedsSharedValue: true, inheritLegit: true, roleArnHandOff: true, wrapUpAt: 0.1, concludeAt: 0.03, loose: true, lead: true,
  thresholds: { confirm: 0.85, settled: 0.95, ruleOut: 0.1, expandMin: 0.6, altPathMin: 0.3, competitorMax: 0.15 },
  weights: { direct: 2, corroborating: 1, circumstantial: 0.4 }, priorRange: [0.1, 0.5], concurrency: 1, runsDir: "runs",
} as const;
// What the reference had that this config does not (yet): the pool holds turns, tokens, wall clock and prices, and the
// spec's model serves every role.
const NOT_HERE = ["model", "maxTurns", "maxTotalTokens", "maxWallClockMinutes", "priceInPerM", "priceOutPerM", "scopeModel", "scopePriceScale", "refusalFallbackModel", "concurrency", "runsDir"];

describe("config defaults are the reference run's", () => {
  it("every setting the loop has equals the reference run's value; the run's dollar ceiling comes from its spec", () => {
    const keys = Object.keys(defaultConfig) as (keyof AgentConfig)[];
    const ref = REFERENCE as unknown as Record<string, unknown>;
    expect(keys.filter((k) => !(k in ref))).toEqual([]);
    expect(Object.keys(ref).filter((k) => !keys.includes(k as keyof AgentConfig)).sort()).toEqual([...NOT_HERE].sort());
    const spec = { budgets: { max_cost_usd: 20 } } as Parameters<typeof configFor>[0];
    const cfg = configFor(spec) as unknown as Record<string, unknown>;
    for (const k of keys) expect([k, cfg[k]]).toEqual([k, ref[k]]);
  });
  it("names the switches, all on", () => {
    expect(defaultConfig).toMatchObject({ loose: true, lead: true, roleArnHandOff: true, inheritLegit: true, theorizeEvery: 4, branchEvery: 6 });
  });
});

describe("loose off: findings that fail a check are refused, not tagged", () => {
  const cand = (label: string) => ({ label, domain: "edr", prior: 0.3, artifacts: [], nodeEvidence: [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: ["r1"] }], edgeEvidence: [] });
  it("refuses a link with no shared value; loose keeps it as inferred", () => {
    const strict = { ...base, linkNeedsSharedValue: true, loose: false }, loose = { ...strict, loose: true };
    for (const [c, kept] of [[strict, false], [loose, true]] as const) {
      const g = seeded();
      const r = applyPatch(g, { ...emptyPatch(), addNodes: [node("a", { evidence: [ev("direct")] })], addEdges: [{ tempId: "e", kind: "explains", source: "a", target: "N1", prior: 0.3, evidence: [ev("direct", "supports", ["r9"])] }] }, 1, c);
      const e = Object.values(g.edges).find((x) => x.kind === "explains");
      expect(!!e).toBe(kept);
      if (e) expect(e.inferred && e.evidence.every((v) => v.strength === "circumstantial")).toBe(true);
      else {
        expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/^no shared value: N2 and N1/)]);
        expect(r.idMap.e).toBeUndefined();
      }
    }
  });
  it("a boundary joined with no shared value stays open", () => {
    const g = seeded();
    const strict = { ...base, linkNeedsSharedValue: true, loose: false };
    applyPatch(g, { ...emptyPatch(), addNodes: [node("m", { kind: "boundary-marker", originNodeId: "N1", targetDomain: "mail" }), node("c", { domain: "mail", evidence: [ev("direct")] })] }, 1, strict);
    applyPatch(g, { ...emptyPatch(), resolveBoundary: { markerId: "N2", nodeId: "N3", joinEvidence: [ev("direct", "supports", ["j1"])] } }, 2, strict);
    expect(g.nodes.N2!.resolvedTo).toBeUndefined();
  });
  it("refuses an accusing label with no baseline; loose tags it unverified", () => {
    const sub = { candidates: [cand("attacker runs xz on node-a")], reasoning: "r" };
    expect(check("submit_causes", sub, 5, { loose: false }).success).toBe(false);
    const r = check("submit_causes", sub, 5, { loose: true });
    expect(r.success).toBe(true);
    expect((r as any).data.candidates[0].unverified).toBe(true);
    expect(check("submit_causes", sub, 5).success).toBe(true); // unset is loose, the default
  });
  it("refuses a baseline that is not a whole-range search naming the account", () => {
    const range: [string, string] = ["2026-03-10T00:00:00Z", "2026-03-13T00:00:00Z"];
    const calls: Record<string, unknown> = {
      r1: { spl: "index=i sourcetype=github actor=dev-a | stats count by action", earliest: range[0], latest: range[1] },
      r2: { spl: "index=i sourcetype=github | stats count by actor", earliest: range[0], latest: range[1] },
      r3: { spl: "index=i sourcetype=github actor=dev-a | stats count", earliest: "2026-03-12T10:00:00Z", latest: range[1] },
    };
    const cx = { inputOf: (id: string) => calls[id], range, loose: false };
    const c = (ids: string[], unusual = true) => ({ effects: [{ label: "register_self_hosted_runner by dev-a", domain: "github", prior: 0.4, artifacts: [{ kind: "user", value: "dev-a" }], nodeEvidence: [], edgeEvidence: [], baseline: { summary: "s", unusual, toolCallIds: ids } }], reasoning: "r" });
    expect(check("submit_effects", c(["r1"]), 3, cx)).toMatchObject({ success: true });
    expect(check("submit_effects", c(["r2"]), 3, cx)).toMatchObject({ success: false, drop: [["effects", 0]] });
    expect(check("submit_effects", c(["r3"], false), 3, cx)).toMatchObject({ success: false });
  });
  it("a 'stolen credential' with no takeover record is refused either way", () => {
    const sub = { candidates: [{ ...cand("Attacker using stolen admin credential ran kubectl"), baseline: { summary: "s", unusual: true, toolCallIds: ["r1"] } }], reasoning: "r" };
    expect(check("submit_causes", sub, 5, { loose: true }).success).toBe(false);
    expect(check("submit_causes", sub, 5, { loose: false }).success).toBe(false);
  });

  const range: [string, string] = ["2026-03-11T00:00:00Z", "2026-03-14T00:00:00Z"];
  const ctxFor = (sub: unknown, loose: boolean): any => ({
    model: { runTurn: async () => ({ submission: sub, toolCalls: [] }) }, trace: new MemoryTrace("t").forTurn(5, "connect", "N2"),
    cfg: { ...base, loose }, range, domains: ["edr", "cloudtrail"], tools: { callCount: 3, coverage: {} }, sizes: {}, turn: 5,
  });
  // S <- N2 (chain top), and findings N3 and N4 not linked to it.
  function graph(): Graph {
    const g = seeded();
    const add = (p: Partial<GraphPatch>) => applyPatch(g, { ...emptyPatch(), ...p }, 1, base);
    add({ addNodes: [node("top", { prior: 0.5, observedAt: "2026-03-13T12:34:34Z", evidence: [ev("direct", "supports", ["t1"]), ev("direct", "supports", ["t2"])] })], addEdges: [{ tempId: "e", kind: "explains", source: "top", target: "N1", prior: 0.5, evidence: [ev("direct", "supports", ["t3"])] }] });
    add({ addNodes: [
      node("day1", { prior: 0.5, label: "role used a day before", domain: "cloudtrail", observedAt: "2026-03-12T12:46:00Z", evidence: [ev("direct", "supports", ["d1"]), ev("direct", "supports", ["d2"])] }),
      node("xz", { prior: 0.5, label: "implant loaded", observedAt: "2026-03-11T16:30:00Z", evidence: [ev("direct", "supports", ["x1"]), ev("direct", "supports", ["x2"])] }),
    ] });
    return g;
  }
  it("a legitimate step links into the attack only with direct evidence (connect)", async () => {
    const { connect } = await import("../../../plugins/rootcause/v3/handlers/connect.js");
    const g = graph();
    applyPatch(g, { ...emptyPatch(), setFlags: [{ nodeId: "N3", legitimate: true }] }, 1, base);
    const link = (strength: string) => ({ events: [], links: [{ from: "N3", to: "N2", prior: 0.4, evidence: [{ summary: "s", strength, polarity: "supports", toolCallIds: ["r1"] }] }], reasoning: "" });
    const d = { move: "connect" as const, targetId: "N2", turn: 5, reason: "" };
    expect((await connect(d, g, ctxFor(link("circumstantial"), false))).addEdges).toEqual([]);
    expect((await connect(d, g, ctxFor(link("direct"), false))).addEdges).toHaveLength(1);
    expect((await connect(d, g, ctxFor(link("circumstantial"), true))).addEdges).toMatchObject([{ inferred: true }]);
  });
  it("a legitimate cause candidate needs direct edge evidence (candidatePatch)", async () => {
    const { candidatePatch, Vetter } = await import("../../../plugins/rootcause/v3/handlers/common.js");
    const g = graph();
    const ctx = ctxFor(null, false);
    ctx.tools.outputOf = () => '{"first":"1773194400","last":"1773450800"}'; // spread over the range: routine
    const c = (strength: "direct" | "circumstantial") => ({ label: "dev registered a runner", domain: "edr", prior: 0.3, artifacts: [], nodeEvidence: [], identitySignals: [],
      edgeEvidence: [{ summary: "s", strength, polarity: "supports" as const, toolCallIds: ["r1"] }], legitimate: true, baseline: { summary: "b", unusual: false, toolCallIds: ["r2"] } });
    const v = new Vetter(ctx, []);
    expect((await candidatePatch(c("circumstantial"), v, g, ctx, "N2")).patch).toEqual({});
    expect((await candidatePatch(c("direct"), v, g, ctx, "N2")).patch.addEdges).toHaveLength(1);
  });
  it("an off-chain finding with no usable baseline is not added (withBaseline)", async () => {
    const { withBaseline, Vetter } = await import("../../../plugins/rootcause/v3/handlers/common.js");
    const fx = () => [{ label: "curl to 203.0.113.9", domain: "edr", prior: 0.4, artifacts: [], nodeEvidence: [], edgeEvidence: [] }, { label: "tar of /etc", domain: "edr", prior: 0.4, artifacts: [], nodeEvidence: [], edgeEvidence: [], baseline: { summary: "first time", unusual: true, toolCallIds: ["r1"] } }];
    const strict = ctxFor(null, false);
    const kept = withBaseline(fx(), new Vetter(strict, []), strict).kept;
    expect(kept.map((c) => c.label)).toEqual(["tar of /etc"]);
    const loose = ctxFor(null, true);
    const all = withBaseline(fx(), new Vetter(loose, []), loose).kept;
    expect(all.map((c) => [c.label, !!(c as { unverified?: boolean }).unverified])).toEqual([["curl to 203.0.113.9", true], ["tar of /etc", false]]);
  });
});

describe("roleArnHandOff off: a role ARN joins any two events that carry it", () => {
  it("two sessions of one role join without the hand-off rule, and not with it", () => {
    const role = { kind: "arn" as const, value: "arn:aws:iam::111122223333:role/admin" };
    const build = (roleArnHandOff: boolean) => {
      const c = { ...base, linkNeedsSharedValue: true, loose: false, roleArnHandOff };
      const g = createGraph("t");
      const add = (p: Partial<GraphPatch>) => applyPatch(g, { ...emptyPatch(), ...p }, 1, c);
      add({ addNodes: [
        node("dev", { label: "PutRule rule-a", domain: "cloudtrail", artifacts: [role, { kind: "ip", value: "198.51.100.67" }] }),
        node("run", { label: "fn-sync running as admin deleted the rule", domain: "cloudtrail", artifacts: [role] }),
      ] });
      const sig = (id: string, v: string) => buildAttributionPatch(id, [{ layer: "machine-facing", relation: "ran-as", kind: "iam-principal", value: v, resolvesTo: `aws:${v}`, toolCallIds: ["r1"] }], g, { turn: 1, domain: "cloudtrail", traceIds: () => [] });
      add(sig("N1", "arn:aws:sts::111122223333:assumed-role/admin/session-a"));
      add(sig("N2", "arn:aws:sts::111122223333:assumed-role/admin/fn-sync"));
      const r = add({ addEdges: [{ tempId: "x", kind: "explains", source: "N1", target: "N2", prior: 0.4, evidence: [ev("direct")] }] });
      return { g, r };
    };
    const on = build(true);
    expect(sharedValue(on.g, on.g.nodes.N1!, on.g.nodes.N2!, true)).toBeNull();
    expect(on.r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/no shared value: N1 and N2/)]);
    const off = build(false);
    expect(sharedValue(off.g, off.g.nodes.N1!, off.g.nodes.N2!, false)).toMatch(/role\/admin/);
    expect(off.r.rejected).toEqual([]);
    expect(Object.values(off.g.edges).some((e) => e.kind === "explains" && e.source === "N1" && e.target === "N2")).toBe(true);
  });
});

describe("inheritLegit off: a step causing its own account's legitimate step is left as it is", () => {
  it("marks the cause legitimate only with the rule on", () => {
    const build = (inheritLegit: boolean) => {
      const c = { ...base, inheritLegit };
      const g = createGraph("t");
      const add = (p: Partial<GraphPatch>) => applyPatch(g, { ...emptyPatch(), ...p }, 1, c);
      add({ addNodes: [
        node("pr", { label: "dev-a created pull request 7 from 198.51.100.67", domain: "github", artifacts: [{ kind: "user", value: "dev-a" }] }),
        node("merge", { label: "dev-a merged pull request 7", domain: "github", legitimate: true, artifacts: [{ kind: "user", value: "dev-a" }] }),
      ] });
      for (const id of ["N1", "N2"]) add(buildAttributionPatch(id, [{ layer: "machine-facing", relation: "ran-as", kind: "account", value: "dev-a", resolvesTo: "github:dev-a", toolCallIds: ["r1"] }], g, { turn: 1, domain: "github", traceIds: () => [] }));
      add({ addEdges: [{ tempId: "a", kind: "explains", source: "N1", target: "N2", prior: 0.6, evidence: [ev("direct")] }] });
      return g;
    };
    expect(build(true).nodes.N1!.legitimate).toBe(true);
    expect(build(false).nodes.N1!.legitimate).toBeFalsy();
  });
});

describe("lead off: the frontier picks every move", () => {
  const alert: Alert = { id: "a1", source: "edr", title: "Backup catalog deleted on HOST-7", observedAt: "2026-05-05T10:30:00Z", artifacts: [{ kind: "host", value: "HOST-7" }], raw: {} };
  // A model that answers nothing but the closing turn: every move is one spent attempt.
  async function runWith(lead: boolean) {
    const cfg: AgentConfig = { ...defaultConfig, maxUsd: 100, rareSweep: false, maxTheorize: 0, lead };
    const requests: TurnRequest[] = [];
    const model = {
      runTurn: async (req: TurnRequest) => {
        requests.push(req);
        if (req.move === "conclude") return { submission: { conclusion: "c", chain: [], openQuestions: [], reasoning: "r" }, toolCalls: [] };
        if (req.move === "choose") return { submission: { move: "strengthen", target: "N1", why: "unconfirmed" }, toolCalls: [] };
        return { submission: null, toolCalls: [] };
      },
    };
    const trace = new MemoryTrace("t", () => new Date(0));
    const lines: string[] = [];
    const r = await run(alert, cfg, { model, tools: new Registry(), trace, budget: { usd: 0 }, domains: ["edr"], clock: () => new Date(0) }, { runId: "t", range: ["2026-05-04T00:00:00Z", "2026-05-06T00:00:00Z"], index: "lab", log: (s) => lines.push(s) });
    return { r, requests, lines, decisions: trace.chronological().filter((e) => e.type === "decision").map((e) => e.payload as { move: string; targetId: string; priority?: number }) };
  }
  it("asks no choose turn, shows no list of moves, and each decision carries the bucket that picked it", async () => {
    const { r, requests, lines, decisions } = await runWith(false);
    expect(requests.some((q) => q.move === "choose")).toBe(false);
    expect(requests.some((q) => q.userContent.includes("<next_move>") || q.userContent.includes("<lead_note>"))).toBe(false);
    expect(requests.filter((q) => q.move !== "conclude").every((q) => q.userContent.includes("<budget>"))).toBe(true);
    expect(decisions[0]).toMatchObject({ move: "strengthen", targetId: "N1", priority: 0 });
    expect(decisions.slice(0, -1).every((d) => typeof d.priority === "number")).toBe(true);
    expect(decisions.at(-1)).toMatchObject({ move: "conclude" });
    expect(lines[0]).toMatch(/^turn 1 · P0 strengthen N1/);
    // The ladder ran out (the symptom stalled, its cause never found): the run ends inconclusive.
    expect(r.exit).toBe("inconclusive");
  });
  it("lead on asks the model: a choose turn first, the moves listed in every prompt", async () => {
    const { requests, lines, decisions } = await runWith(true);
    expect(requests[0]!.move).toBe("choose");
    expect(requests.filter((q) => q.move !== "conclude").every((q) => q.userContent.includes("<next_move>"))).toBe(true);
    expect(decisions.every((d) => d.priority === undefined)).toBe(true);
    expect(lines[0]).toMatch(/^turn 1 · choose N1/);
  });
});
