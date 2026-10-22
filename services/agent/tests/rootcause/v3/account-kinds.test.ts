// An email address is an account (the reference reported one as user); a message id links the events about one
// email but never makes two of them one event or a direct stitch.
import { describe, expect, it } from "vitest";
import { buildAttributionPatch } from "../../../plugins/rootcause/v3/attribution.js";
import { baselineProblem } from "../../../plugins/rootcause/v3/baseline.js";
import { applyPatch, createGraph, emptyPatch, sharedValue, type Graph } from "../../../plugins/rootcause/v3/graph.js";
import { renderReport } from "../../../plugins/rootcause/v3/report.js";
import { matchBoundary, sameEvent } from "../../../plugins/rootcause/v3/stitch.js";
import { sweepValues } from "../../../plugins/rootcause/v3/sweep.js";
import { MemoryTrace } from "../../../plugins/rootcause/v3/trace.js";
import { alert } from "./fixtures/report-fixture.js";
import { cfg, ev, node, seeded } from "./helpers.js";

const on = { ...cfg, linkNeedsSharedValue: true };
const art = (kind: string, value: string) => ({ kind: kind as any, value });
const add = (g: Graph, p: any) => applyPatch(g, { ...emptyPatch(), ...p }, 1, on);
const ranAs = (g: Graph, id: string, v: string) => add(g, buildAttributionPatch(id, [{ layer: "machine-facing", relation: "ran-as", kind: "account", value: v, resolvesTo: `ad:${v}`, toolCallIds: ["r1"] }], g, { turn: 1, domain: "o365", traceIds: () => [] }));

// Two mailbox events naming one account value, run as `a` and `b`; then a link N1 -> N2.
function twoEvents(kind: string, value: string, a: string, b: string) {
  const g = createGraph("t");
  add(g, { addNodes: [
    node("rule", { label: "inbox rule created", domain: "o365", artifacts: [art(kind, value)] }),
    node("send", { label: "mail sent", domain: "o365", artifacts: [art(kind, value)] }),
  ] });
  ranAs(g, "N1", a); ranAs(g, "N2", b);
  const join = sharedValue(g, g.nodes.N1!, g.nodes.N2!);
  add(g, { addEdges: [{ tempId: "x", kind: "explains", source: "N1", target: "N2", prior: 0.4, evidence: [ev("direct")] }] });
  const e = Object.values(g.edges).find((x) => x.kind === "explains")!;
  return { join, inferred: e.inferred === true };
}

describe("an email address joins events the way a user does", () => {
  it("across different accounts it is no join: the link is kept inferred, as for a user", () => {
    const email = twoEvents("email-address", "alice@corp.example", "alice", "mallory");
    expect(email).toEqual({ join: null, inferred: true });
    expect(email).toEqual(twoEvents("user", "alice@corp.example", "alice", "mallory"));
  });
  it("under one account it is a join, as for a user", () => {
    const email = twoEvents("email-address", "alice@corp.example", "alice", "alice");
    expect(email).toEqual({ join: "email-address=alice@corp.example", inferred: false });
    expect(twoEvents("user", "alice@corp.example", "alice", "alice")).toEqual({ join: "user=alice@corp.example", inferred: false });
  });
  it("a shared email address neither stitches a boundary nor pins one event, as a user does not", () => {
    const origin = { label: "mail sent", observedAt: "2026-04-02T10:00:00Z", artifacts: [art("email-address", "alice@corp.example")] };
    const cand = { label: "login", domain: "o365", observedAt: "2026-04-01T09:00:00Z", artifacts: [art("email-address", "alice@corp.example")] };
    expect(matchBoundary(cand, { id: "B1" }, origin, cfg, 1).kind).toBe("none");
    const at = (kind: string) => ({ domain: "o365", observedAt: "2026-04-02T10:00:00Z", artifacts: [art(kind, "alice@corp.example"), art("ip", "198.51.100.9")] });
    expect(sameEvent(at("email-address"), at("email-address"))).toBe(false);
    expect(sameEvent(at("email-address"), at("email-address"))).toBe(sameEvent(at("user"), at("user")));
  });
  it("a baseline must name it, as it must name a user", () => {
    const range: [string, string] = ["2026-04-01T00:00:00Z", "2026-04-04T00:00:00Z"];
    const c = (kind: string) => ({ label: "mail sent", artifacts: [art(kind, "alice@corp.example")], baseline: { unusual: true, toolCallIds: ["r1"] } }) as any;
    const search = (spl: string) => () => ({ spl, earliest: range[0], latest: range[1] });
    for (const kind of ["email-address", "user"]) {
      expect(baselineProblem(c(kind), search('search sourcetype=o365 "alice@corp.example"'), range)).toBeNull();
      expect(baselineProblem(c(kind), search("search sourcetype=o365 | stats count by user"), range)).toMatch(/alice@corp\.example/);
    }
  });
  it("is swept like a user", () => {
    const g = createGraph("t");
    expect(sweepValues(g, { id: "N1", artifacts: [art("email-address", "alice@corp.example")] })).toEqual(sweepValues(g, { id: "N1", artifacts: [art("user", "alice@corp.example")] }));
  });
  it("an unlinked finding's email address is left out of the indicators, as its user is", () => {
    const g = seeded();
    applyPatch(g, { ...emptyPatch(), addNodes: [node("x", { label: "mail forwarded out", prior: 0.6, evidence: [ev("direct", "supports", ["a1"]), ev("direct", "supports", ["a2"])], artifacts: [art("email-address", "mallory@corp.example"), art("user", "mallory"), art("file-hash", "ab12cd34")] })] }, 1, cfg);
    expect(g.nodes.N2!.confidence).toBeGreaterThanOrEqual(0.5);
    const md = renderReport(g, new MemoryTrace("t"), null, alert);
    const iocs = md.split("## Indicators")[1]!.split("\n## ")[0]!;
    expect(iocs).toMatch(/file-hash: ab12cd34/);
    expect(iocs).not.toMatch(/mallory/);
  });
  it("a linked finding's email address is listed, as its user is", () => {
    const g = seeded();
    const strong = { prior: 0.6, evidence: [ev("direct", "supports", ["a1"]), ev("direct", "supports", ["a2"])] };
    applyPatch(g, { ...emptyPatch(), addNodes: [node("x", { label: "mail forwarded out", ...strong, artifacts: [art("email-address", "mallory@corp.example"), art("user", "mallory")] })],
      addEdges: [{ tempId: "e", kind: "explains", source: "x", target: "N1", prior: 0.6, evidence: [ev("direct", "supports", ["l1"]), ev("direct", "supports", ["l2"])] }] }, 1, cfg);
    expect(Object.values(g.edges).find((e) => e.kind === "explains")!.confidence).toBeGreaterThanOrEqual(0.5);
    const iocs = renderReport(g, new MemoryTrace("t"), null, alert).split("## Indicators")[1]!.split("\n## ")[0]!;
    expect(iocs).toMatch(/- user: mallory/);
    expect(iocs).toMatch(/- email-address: mallory@corp\.example/);
  });
});

describe("a message id links the events about one email, never as one event", () => {
  const mid = art("message-id", "<88231.invoice@mail.example>");
  it("two events with the same message id stay two nodes; the same event-id merges them", () => {
    const g = createGraph("t");
    add(g, { addNodes: [node("delivered", { label: "mail delivered", domain: "email", artifacts: [mid] })] });
    add(g, { addNodes: [node("clicked", { label: "link in the mail clicked", domain: "email", artifacts: [mid] })] });
    expect(Object.keys(g.nodes)).toHaveLength(2);
    const h = createGraph("t");
    add(h, { addNodes: [node("delivered", { label: "mail delivered", domain: "email", artifacts: [art("event-id", "88231")] })] });
    add(h, { addNodes: [node("delivered again", { label: "mail delivered", domain: "email", artifacts: [art("event-id", "88231")] })] });
    expect(Object.keys(h.nodes)).toHaveLength(1);
  });
  it("is a shared value for a link", () => {
    const g = createGraph("t");
    add(g, { addNodes: [node("delivered", { label: "mail delivered", domain: "email", artifacts: [mid] }), node("clicked", { label: "link clicked", domain: "proxy", artifacts: [mid] })] });
    expect(sharedValue(g, g.nodes.N1!, g.nodes.N2!)).toBe("message-id=<88231.invoice@mail.example>");
  });
  it("does not stitch a boundary as direct", () => {
    const origin = { label: "attachment opened", observedAt: "2026-04-02T10:00:00Z", artifacts: [mid] };
    const m = matchBoundary({ label: "mail delivered", domain: "email", observedAt: "2026-04-01T09:00:00Z", artifacts: [mid] }, { id: "B1" }, origin, cfg, 1);
    expect(m.kind).not.toBe("auto");
    expect(m.joinEvidence.some((e) => e.strength === "direct")).toBe(false);
  });
});
