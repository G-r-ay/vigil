import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../../plugins/rootcause/v3/config.js";
import { check } from "../../../plugins/rootcause/v3/model/client.js";
import { cfg, ev, node, seeded } from "./helpers.js";
import { applyPatch, emptyPatch } from "../../../plugins/rootcause/v3/graph.js";
import { candidatePatch, Vetter, withBaseline } from "../../../plugins/rootcause/v3/handlers/common.js";
import { fold } from "../../../plugins/rootcause/v3/ledger.js";
import { MemoryTrace } from "../../../plugins/rootcause/v3/trace.js";

const cand = (label: string) => ({ label, domain: "edr", prior: 0.3, artifacts: [], nodeEvidence: [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: ["r1"] }], edgeEvidence: [] });

describe("loose intake", () => {
  it("is off by default: a finding that fails a check is refused", () => {
    expect(defaultConfig.loose).toBe(false);
  });
  it("keeps a link with no shared value as inferred (circumstantial) instead of refusing it", () => {
    const strict = { ...cfg, linkNeedsSharedValue: true }, loose = { ...strict, loose: true };
    for (const [c, kept] of [[strict, false], [loose, true]] as const) {
      const g = seeded();
      const r = applyPatch(g, { ...emptyPatch(), addNodes: [node("a", { evidence: [ev("direct")] })], addEdges: [{ tempId: "e", kind: "explains", source: "a", target: "N1", prior: 0.3, evidence: [ev("direct", "supports", ["r9"])] }] }, 1, c);
      const e = Object.values(g.edges).find((x) => x.kind === "explains");
      expect(!!e).toBe(kept);
      if (e) expect(e.inferred && e.evidence.every((v) => v.strength === "circumstantial")).toBe(true);
      else expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/^no shared value: N2 and N1/)]);
    }
  });
  it("tags an accusing label with no baseline unverified instead of refusing the submission", () => {
    const sub = { candidates: [cand("attacker runs xz on node-a")], reasoning: "r" };
    expect(check("submit_causes", sub, 5)).toMatchObject({ success: false, drop: [["candidates", 0]], msg: expect.stringMatching(/the label calls this activity malicious or the attacker's but there is no baseline/) });
    const r = check("submit_causes", sub, 5, { loose: true });
    expect(r.success).toBe(true);
    expect((r as any).data.candidates[0].unverified).toBe(true);
  });
  it("drops an off-chain finding with no baseline instead of keeping it unverified", () => {
    for (const [loose, kept] of [[false, 0], [true, 1]] as const) {
      const ctx: any = { cfg: { ...cfg, loose }, trace: new MemoryTrace("t").forTurn(1, "branch", "N1"), range: ["2026-03-11T00:00:00Z", "2026-03-14T00:00:00Z"], domains: ["edr"], tools: { callCount: 3, coverage: {} }, turn: 1 };
      const r = withBaseline([{ ...cand("curl wrote /tmp/job.yaml on node-a"), identitySignals: [] } as any], new Vetter(ctx, []), ctx);
      expect(r.kept).toHaveLength(kept);
      if (kept) expect(r.kept[0].unverified).toBe(true);
    }
  });
  it("a legitimate step's cause link without direct evidence: not added (strict) or kept inferred (loose)", async () => {
    for (const loose of [false, true]) {
      const g = seeded();
      const ctx: any = { cfg: { ...cfg, loose }, trace: new MemoryTrace("t").forTurn(1, "expand", "N1"), range: ["2026-03-11T00:00:00Z", "2026-03-14T00:00:00Z"], domains: ["edr"], tools: { callCount: 3, coverage: {}, outputOf: () => '{"first":"1773194400","last":"1773450800"}' }, turn: 1 };
      const c = { ...cand("dev registered a runner"), identitySignals: [], edgeEvidence: [{ summary: "s", strength: "circumstantial" as const, polarity: "supports" as const, toolCallIds: ["r1"] }], legitimate: true, baseline: { summary: "b", unusual: false, toolCallIds: ["r2"] } } as any;
      const { patch } = await candidatePatch(c, new Vetter(ctx, []), g, ctx, "N1");
      if (loose) expect(patch.addEdges).toMatchObject([{ inferred: true }]);
      else expect(patch).toEqual({});
    }
  });
  it("a ledger written before loose was a setting folds as loose, the way it ran", () => {
    const { loose: _, ...old } = cfg;
    const setup = (c: object) => ({ run_id: "r1", run_kind: "root_cause", seq: 0, ts: "2026-03-11T00:00:00Z", kind: "rootcause_setup", schema_version: 1,
      payload: { cfg: c, alert: { id: "a", source: "edr", title: "a", observedAt: "2026-03-11T10:00:00Z", artifacts: [] }, index: "lab", range: ["2026-03-11T00:00:00Z", "2026-03-14T00:00:00Z"], survey: { text: "", domains: [], sizes: {} }, environment: null } });
    expect(fold([setup(old)] as never).setup!.cfg.loose).toBe(true);
    expect(fold([setup(cfg)] as never).setup!.cfg.loose).toBe(false);
  });
});
