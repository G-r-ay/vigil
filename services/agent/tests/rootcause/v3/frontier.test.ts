import { describe, expect, it } from "vitest";
import { createGraph, type Theory } from "../../../plugins/rootcause/v3/graph.js";
import { isStalled, selectFrontier } from "../../../plugins/rootcause/v3/frontier.js";
import { options } from "../../../plugins/rootcause/v3/lead.js";
import { apply, cfg, ev, node, seeded } from "./helpers.js";

const link = (tempId: string, source: string, target: string, evidence = [ev("direct", "supports", [`r${tempId}`])]) =>
  ({ tempId, kind: "explains" as const, source, target, prior: 0.3, evidence });
const solid = (tempId: string, over = {}) => node(tempId, { evidence: [ev("direct", "supports", [`r${tempId}`]), ev("corroborating", "supports", [`r${tempId}b`])], ...over });

// Which moves are open on which targets: the model picks among them, code only says what is available.
describe("options", () => {
  it("a lone symptom: strengthen and expand it, fork nothing (no cause to rival), branch nothing", () => {
    const g = createGraph("t");
    apply(g, { addNodes: [node("S", { isSymptom: true })] });
    expect(options(g, cfg)).toEqual({ expand: ["N1"], strengthen: ["N1"] });
  });
  it("an open boundary offers a pivot; an exhausted one does not", () => {
    const g = seeded();
    apply(g, { addNodes: [node("m", { kind: "boundary-marker", originNodeId: "N1", targetDomain: "email" })], addEdges: [{ ...link("e", "m", "N1"), evidence: [] }] });
    expect(options(g, cfg).pivot).toEqual(["B1"]);
    apply(g, { updateMarkers: [{ markerId: "B1", pivotSteps: cfg.maxForwardSteps }] });
    expect(options(g, cfg).pivot).toBeUndefined();
  });
  it("links, events and attributions are strengthen targets while unsettled; a boundary's placeholder link is not", () => {
    const g = seeded();
    apply(g, { addNodes: [node("a1", { kind: "actor", label: "x" }), solid("c"), node("m", { kind: "boundary-marker", originNodeId: "N2", targetDomain: "email" })],
      addEdges: [{ tempId: "x", kind: "attributed-to", source: "a1", target: "N1", prior: 0.3, evidence: [] }, link("e", "c", "N1", []), { ...link("me", "m", "N2"), evidence: [] }] });
    const s = options(g, cfg).strengthen!;
    expect(s).toEqual(expect.arrayContaining(["N1", "N2", "E1", "E2"]));
    expect(s).not.toContain("E3");
  });
  it("fork needs a cause to rival and a fork left", () => {
    const g = seeded();
    expect(options(g, cfg).fork).toBeUndefined();
    apply(g, { addNodes: [solid("c")], addEdges: [link("e", "c", "N1", [])] });
    expect(options(g, cfg).fork).toEqual(["N1"]);
    apply(g, { incrementForks: ["N1", "N1", "N1"] });
    expect(options(g, cfg).fork).toBeUndefined();
  });
  it("a stalled link leaves strengthen", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("c")], addEdges: [link("e", "c", "N1", [])] });
    for (let t = 2; t <= 4; t++) apply(g, { incrementAttempts: ["E1"] }, t);
    expect(isStalled(g.edges.E1!, cfg)).toBe(true);
    expect(options(g, cfg).strengthen).not.toContain("E1");
  });
  it("stall by small movement over the last two attempts", () => {
    const g = seeded();
    apply(g, { addNodes: [node("c")] });
    apply(g, { incrementAttempts: ["N2"] }, 2);
    apply(g, { incrementAttempts: ["N2"] }, 3);
    expect(isStalled(g.nodes.N2!, cfg)).toBe(true);
    expect(options(g, cfg).strengthen).not.toContain("N2");
  });
  it("expand is capped per event, and a root is not expanded", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("root", { isRoot: true })], addEdges: [link("e", "root", "N1", [])] });
    expect(options(g, cfg).expand).toEqual(["N1"]);
    for (let t = 2; t <= cfg.maxExpandAttempts + 2; t++) apply(g, { incrementExpand: ["N1"] }, t);
    expect(options(g, cfg).expand).toBeUndefined();
  });
  it("nothing is open once the graph is spent", () => {
    const g = seeded();
    apply(g, { setFlags: [{ nodeId: "N1", isRoot: true }], incrementExpand: ["N1", "N1", "N1"] });
    for (let t = 2; t <= 4; t++) apply(g, { incrementAttempts: ["N1"] }, t);
    expect(options(g, cfg)).toEqual({});
  });
});

// The code's own pick (selectFrontier): the priority ladder P0-P12, first rung with a candidate wins.
describe("selectFrontier", () => {
  it("P0: strengthen an unconfirmed symptom", () => {
    const g = createGraph("t");
    apply(g, { addNodes: [node("S", { isSymptom: true })] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", targetId: "N1", priority: 0 });
  });
  it("P6: expand a confirmed top with no cause", () => {
    expect(selectFrontier(seeded(), cfg, 2)).toMatchObject({ move: "expand", targetId: "N1", priority: 6 });
  });
  it("P1: pivot on an open marker", () => {
    const g = seeded();
    apply(g, { addNodes: [node("m", { kind: "boundary-marker", originNodeId: "N1", targetDomain: "email" })], addEdges: [{ ...link("e", "m", "N1"), evidence: [] }] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "pivot", targetId: "B1", priority: 1 });
  });
  it("P2: disputed attribution first", () => {
    const g = seeded();
    apply(g, { addNodes: [node("a1", { kind: "actor", label: "x" }), node("a2", { kind: "actor", label: "y" })],
      addEdges: [{ tempId: "x", kind: "attributed-to", source: "a1", target: "N1", prior: 0.3, evidence: [] }, { tempId: "y", kind: "attributed-to", source: "a2", target: "N1", prior: 0.3, evidence: [] }] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", priority: 2, targetId: "E1" });
  });
  it("undisputed unconfirmed attribution waits for P4, behind the causal chain", () => {
    const g = seeded();
    apply(g, { addNodes: [node("a1", { kind: "actor", label: "x" }), solid("c")],
      addEdges: [{ tempId: "x", kind: "attributed-to", source: "a1", target: "N1", prior: 0.3, evidence: [] }, link("e", "c", "N1", [])] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", targetId: "E2", priority: 3 });
    apply(g, { addEvidence: [{ targetId: "E2", evidence: ev("direct", "supports", ["q"]) }, { targetId: "E2", evidence: ev("corroborating", "supports", ["r"]) }] });
    expect(selectFrontier(g, cfg, 3)).toMatchObject({ move: "strengthen", targetId: "E1", priority: 4 });
  });
  it("P3: weakest suspected link", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("c")], addEdges: [link("e", "c", "N1", [])] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", targetId: "E1", priority: 3 });
  });
  it("P4: suspected node on the path", () => {
    const g = seeded();
    apply(g, { addNodes: [node("c")], addEdges: [link("e", "c", "N1", [ev("direct", "supports", ["a"]), ev("corroborating", "supports", ["b"])])] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", targetId: "N2", priority: 4 });
  });
  it("P5: fork when a link stalls", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("c")], addEdges: [link("e", "c", "N1", [])] });
    for (let t = 2; t <= 4; t++) apply(g, { incrementAttempts: ["E1"] }, t);
    expect(isStalled(g.edges.E1!, cfg)).toBe(true);
    expect(selectFrontier(g, cfg, 5)).toMatchObject({ move: "fork", targetId: "N1", priority: 5 });
  });
  it("P7: alternative path when the best is done", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("root", { isRoot: true }), solid("alt")], addEdges: [
      link("e1", "root", "N1", [ev("direct", "supports", ["a"]), ev("corroborating", "supports", ["b"])]), link("e2", "alt", "N1", [ev("corroborating", "supports", ["c"])])] });
    const d = selectFrontier(g, cfg, 2)!;
    expect(d.priority).toBe(7);
    expect(d.targetId).toBe("E2");
  });
  it("null when nothing qualifies", () => {
    const g = seeded();
    apply(g, { setFlags: [{ nodeId: "N1", isRoot: true }] });
    expect(selectFrontier(g, cfg, 2)).toBeNull();
  });
  it("tie-break: lower confidence first", () => {
    const g = seeded();
    apply(g, { addNodes: [solid("a"), node("b", { evidence: [ev("corroborating", "supports", ["q"]), ev("direct", "supports", ["r"])] }), solid("c")],
      addEdges: [link("e1", "a", "N1", []), link("e2", "b", "N2", [ev("circumstantial", "supports", ["z"])]), link("e3", "c", "N3", [])] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ priority: 3 });
  });
});

describe("selectFrontier: stories", () => {
  const scfg = { ...cfg, maxTheorize: 2, theorizeEvery: 3 };
  const theory = (id: string, preds: { id: string; next: boolean }[]): Theory => ({
    id, round: 1, story: `story ${id}`, accountsFor: [], gaps: "", status: "live", support: 0, against: 0,
    predictions: preds.map((p) => ({ ...p, sourcetype: "github", expect: `record ${p.id}`, spl: "index=x sourcetype=github", separates: [], status: "open" as const })),
  });
  it("theorize once the symptom is settled, then test the chosen predictions in order", () => {
    const g = seeded();
    apply(g, { incrementAttempts: ["N1"] }); apply(g, { incrementAttempts: ["N1"] }); apply(g, { incrementAttempts: ["N1"] });
    expect(selectFrontier(g, scfg, 4)).toMatchObject({ move: "theorize", targetId: "N1" });
    apply(g, { setTheories: [theory("R1.H1", [{ id: "R1.P1", next: true }, { id: "R1.P2", next: false }]), theory("R1.H2", [{ id: "R1.P3", next: true }])] }, 4);
    // The chain top's cause was never searched: that goes before the tests.
    expect(selectFrontier(g, scfg, 5)).toMatchObject({ move: "expand", targetId: "N1", priority: 1 });
    apply(g, { incrementExpand: ["N1"] }, 5);
    expect(selectFrontier(g, scfg, 5)).toMatchObject({ move: "test", targetId: "R1.P1" });
    apply(g, { predictionResult: { id: "R1.P1", status: "absent", result: "nothing", toolCallIds: ["r1"], supports: ["R1.H2"], weakens: ["R1.H1"] } }, 5);
    expect(selectFrontier(g, scfg, 6)).toMatchObject({ move: "test", targetId: "R1.P3" });
  });
  it("a new round waits for other moves, unless the plan is out of moves; rounds are capped", () => {
    const g = seeded();
    apply(g, { incrementExpand: ["N1"] }, 1);
    apply(g, { setTheories: [theory("R1.H1", [{ id: "R1.P1", next: true }])] }, 1);
    apply(g, { predictionResult: { id: "R1.P1", status: "found", result: "x", toolCallIds: [], supports: [], weakens: [] } }, 2);
    expect(selectFrontier(g, scfg, 3)?.move).not.toBe("theorize");
    expect(selectFrontier(g, scfg, 5)).toMatchObject({ move: "theorize" });
    apply(g, { setTheories: [] }, 5); // a failed round still counts
    expect(selectFrontier(g, scfg, 20)?.move).not.toBe("theorize");
  });
  it("records the turn of the first round and of the last branch", () => {
    const g = seeded();
    apply(g, { setTheories: [] }, 3);
    apply(g, { setTheories: [] }, 7);
    expect(g.storiesSince).toBe(3);
    expect(g.branchedTurn).toBeUndefined();
    apply(g, { incrementBranch: ["N1"] }, 9);
    expect(g.branchedTurn).toBe(9);
  });
});

describe("selectFrontier: connect, legitimate steps and the branch cadence", () => {
  const ccfg = { ...cfg, maxTheorize: 2 };
  const theory: Theory = { id: "R1.H1", round: 1, story: "s", accountsFor: [], gaps: "", status: "live", support: 0, against: 0,
    predictions: [{ id: "R1.P1", sourcetype: "edr", expect: "e", spl: "index=x", separates: [], next: true, status: "open" }] };
  // S <- N2 (chain top), plus two unlinked findings N3 (earlier) and N4 (later); a weak one N5 does not count.
  function graph() {
    const g = seeded();
    apply(g, { addNodes: [node("top", { prior: 0.5, observedAt: "2026-03-13T12:34:34Z", evidence: [ev("direct", "supports", ["t1"]), ev("direct", "supports", ["t2"])] })], addEdges: [{ tempId: "e", kind: "explains", source: "top", target: "N1", prior: 0.5, evidence: [ev("direct", "supports", ["t3"])] }] });
    apply(g, { addNodes: [
      node("xz", { prior: 0.5, label: "implant loaded", observedAt: "2026-03-11T16:30:00Z", evidence: [ev("direct", "supports", ["r1"]), ev("direct", "supports", ["r2"])] }),
      node("day1", { prior: 0.5, label: "role used a day before", domain: "cloudtrail", observedAt: "2026-03-12T12:46:00Z", evidence: [ev("direct", "supports", ["d1"]), ev("direct", "supports", ["d2"])] }),
      node("weak", { prior: 0.2, label: "maybe something" }),
    ] });
    g.theories = [structuredClone(theory)]; g.theorizeCount = 1; g.theorizedTurn = 5;
    return g;
  }
  it("connect comes before the stories' tests, once per finding", () => {
    const g = graph();
    expect(selectFrontier(g, ccfg, 5)).toMatchObject({ move: "connect", targetId: "N2", priority: 1 });
    apply(g, { incrementConnect: ["N3", "N4"] }, 5);
    expect(selectFrontier(g, ccfg, 6)?.move).not.toBe("connect");
  });
  it("no pivot from a legitimate step; the stories' tests go before pivots", async () => {
    const { boundaryPatch } = await import("../../../plugins/rootcause/v3/handlers/common.js");
    const g = graph();
    apply(g, { incrementConnect: ["N3", "N4"], incrementExpand: ["N2"] });
    const ctx: any = { cfg: ccfg, turn: 5, domains: ["edr", "cloudtrail"], tools: { callCount: 3, coverage: {} }, sizes: {} };
    apply(g, boundaryPatch({ targetDomain: "cloudtrail", reason: "r", inDomainExhausted: true }, "N2", g, ctx) as any);
    expect(selectFrontier(g, ccfg, 6)).toMatchObject({ move: "test", targetId: "R1.P1" });
    apply(g, { predictionResult: { id: "R1.P1", status: "found", result: "x", toolCallIds: [], supports: [], weakens: [] } }, 6);
    expect(selectFrontier(g, ccfg, 7)).toMatchObject({ move: "pivot" });
    apply(g, { setFlags: [{ nodeId: "N2", legitimate: true }] });
    expect(selectFrontier(g, ccfg, 7)?.move).not.toBe("pivot");
  });
  it("branches from the chain event nearest the alert every branchEvery turns once the stories run", () => {
    const g = graph(); // S <- N2 (top), stories since turn 5
    g.storiesSince = 5;
    apply(g, { incrementConnect: ["N3", "N4"], incrementExpand: ["N2"] });
    expect(selectFrontier(g, { ...ccfg, branchEvery: 6 }, 8)?.move).toBe("test");
    expect(selectFrontier(g, { ...ccfg, branchEvery: 6 }, 11)).toMatchObject({ move: "branch", targetId: "N2" });
    apply(g, { incrementBranch: ["N2"] }, 11);
    expect(selectFrontier(g, { ...ccfg, branchEvery: 6 }, 12)?.move).toBe("test");
  });
});

describe("selectFrontier: after the chain", () => {
  const strong = (a: string, b: string) => [ev("direct", "supports", [a]), ev("corroborating", "supports", [b])];
  it("branches from the root first once the chain is settled", () => {
    const g = seeded();
    apply(g, { addNodes: [node("mid", { evidence: strong("d1", "d2") }), node("root", { isRoot: true, evidence: strong("r1", "r2") })],
      addEdges: [{ tempId: "e1", kind: "explains", source: "mid", target: "N1", prior: 0.3, evidence: strong("x1", "x2") },
        { tempId: "e2", kind: "explains", source: "root", target: "mid", prior: 0.3, evidence: strong("y1", "y2") }] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "branch", targetId: "N3", priority: 9 });
    apply(g, { incrementBranch: ["N3"] }, 2);
    expect(selectFrontier(g, cfg, 3)).toMatchObject({ move: "branch", targetId: "N2" });
  });
  it("branches first from events in the sourcetype searched least", () => {
    const g = seeded();
    apply(g, { addNodes: [node("mid", { evidence: strong("d1", "d2") }), node("root", { isRoot: true, domain: "k8s", evidence: strong("r1", "r2") })],
      addEdges: [{ tempId: "e1", kind: "explains", source: "mid", target: "N1", prior: 0.3, evidence: strong("x1", "x2") },
        { tempId: "e2", kind: "explains", source: "root", target: "mid", prior: 0.3, evidence: strong("y1", "y2") }] });
    const mid = g.nodes.N2!.domain;
    expect(selectFrontier(g, cfg, 2, { [mid]: 1, k8s: 30 })).toMatchObject({ move: "branch", targetId: "N2" });
  });
  it("does not fork on a strong link that stalled", () => {
    const g = seeded();
    apply(g, { addNodes: [node("c", { evidence: [ev("direct", "supports", ["c1"])] })], addEdges: [{ tempId: "e", kind: "explains", source: "c", target: "N1", prior: 0.5, evidence: [ev("corroborating", "supports", ["k1"])] }] });
    for (let t = 2; t <= 4; t++) apply(g, { incrementAttempts: ["E1"] }, t);
    expect(g.edges.E1!.confidence).toBeGreaterThan(0.6);
    expect(selectFrontier(g, cfg, 5)?.move).not.toBe("fork");
  });
  it("a chain link is settled once two checks do not move it, or once it is near-certain", () => {
    const g = seeded();
    apply(g, { addNodes: [node("root", { isRoot: true, evidence: strong("r1", "r2") })], addEdges: [{ tempId: "e", kind: "explains", source: "root", target: "N1", prior: 0.5, evidence: [ev("corroborating", "supports", ["k1"])] }] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "strengthen", targetId: "E1" });
    apply(g, { incrementAttempts: ["E1"] }, 2); // one check found nothing new: it gets another
    expect(selectFrontier(g, cfg, 3)).toMatchObject({ move: "strengthen", targetId: "E1" });
    apply(g, { incrementAttempts: ["E1"] }, 3); // two unmoved checks: settled
    expect(selectFrontier(g, cfg, 4)?.targetId).not.toBe("E1");
    const g2 = seeded();
    apply(g2, { addNodes: [node("root", { isRoot: true, evidence: strong("r1", "r2") })], addEdges: [{ tempId: "e", kind: "explains", source: "root", target: "N1", prior: 0.5, evidence: [ev("corroborating", "supports", ["k1"]), ...["a", "b", "c", "d", "e", "f"].map((x) => ev("circumstantial", "supports", [x], `timing ${x}`))] }] });
    expect(g2.edges.E1!.status).toBe("suspected");
    expect(g2.edges.E1!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(selectFrontier(g2, cfg, 2)?.targetId).not.toBe("E1");
  });
  it("off-chain events get one check, and only plausible ones", () => {
    const g = seeded();
    apply(g, { setFlags: [{ nodeId: "N1", isRoot: true }], incrementBranch: ["N1"] });
    apply(g, { addNodes: [node("weak", { prior: 0.3 }), node("plausible", { prior: 0.5, evidence: [ev("corroborating", "supports", ["p1"])] })] });
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "branch" });
    apply(g, { incrementBranch: ["N3"] }, 2);
    expect(selectFrontier(g, cfg, 3)).toMatchObject({ move: "strengthen", targetId: "N3", priority: 10 });
    apply(g, { incrementAttempts: ["N3"] }, 3);
    expect(selectFrontier(g, cfg, 4)).toBeNull();
  });
  it("dead-end events get no branch move", () => {
    const g = seeded();
    apply(g, { setFlags: [{ nodeId: "N1", isRoot: true }], incrementBranch: ["N1"] });
    apply(g, { addNodes: [node("wipe", { deadEnd: true, prior: 0.5, evidence: [ev("direct", "supports", ["w1"])] })] });
    expect(selectFrontier(g, cfg, 2)).toBeNull();
  });
  it("a boundary's placeholder link is never strengthened", () => {
    const g = seeded();
    apply(g, { addNodes: [node("m", { kind: "boundary-marker", originNodeId: "N1", targetDomain: "mail" })], addEdges: [{ tempId: "e", kind: "explains", source: "m", target: "N1", prior: 0.3, evidence: [] }] });
    apply(g, { updateMarkers: [{ markerId: "B1", pivotSteps: cfg.maxForwardSteps }] });
    expect(selectFrontier(g, cfg, 2)?.targetId).not.toBe("E1");
  });
});

describe("selectFrontier: attribution and legitimate steps", () => {
  it("disputed attribution gets at most 2 checks per action", () => {
    const g = seeded();
    apply(g, { addNodes: [node("a1", { kind: "actor", label: "ad:x" }), node("a2", { kind: "actor", label: "ad:y" })],
      addEdges: [{ tempId: "x", kind: "attributed-to", source: "a1", target: "N1", prior: 0.3, evidence: [] }, { tempId: "y", kind: "attributed-to", source: "a2", target: "N1", prior: 0.3, evidence: [] }] });
    apply(g, { incrementAttempts: ["E1"] }, 2);
    apply(g, { incrementAttempts: ["E2"] }, 3);
    expect(selectFrontier(g, cfg, 4)?.priority).not.toBe(2);
  });
  it("undisputed attribution gets one check", () => {
    const g = seeded();
    apply(g, { addNodes: [node("a1", { kind: "actor", label: "ad:x" })], addEdges: [{ tempId: "x", kind: "attributed-to", source: "a1", target: "N1", prior: 0.3, evidence: [] }] });
    apply(g, { incrementAttempts: ["E1"] }, 2);
    expect(selectFrontier(g, cfg, 3)?.targetId).not.toBe("E1");
  });
  it("a legitimate step is never the root and keeps the chain open upstream", () => {
    const g = seeded();
    apply(g, { addNodes: [node("dev", { label: "admin applied a Function resource from 6.6.6.6", legitimate: true, isRoot: true, evidence: [ev("direct", "supports", ["d1"]), ev("corroborating", "supports", ["d2"])] })],
      addEdges: [{ tempId: "e", kind: "explains", source: "dev", target: "N1", prior: 0.5, evidence: [ev("direct", "supports", ["x1"]), ev("corroborating", "supports", ["x2"])] }] });
    expect(g.nodes.N2!.isRoot).toBeUndefined();
    expect(selectFrontier(g, cfg, 2)).toMatchObject({ move: "expand", targetId: "N2" });
  });
});
