// The conclusion and the report name no one the alert's proven chain does not reach: the conclude move's answer goes
// back once while it does, and the report, the run summary and the console redact what is left, outside sentences
// that clear the name. Loose mode or strict.
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../contracts/events.js";
import { conclusionOf } from "../../../plugins/rootcause/v3/engine.js";
import { emptyPatch, type Graph, type GraphPatch } from "../../../plugins/rootcause/v3/graph.js";
import { conclude } from "../../../plugins/rootcause/v3/handlers/conclude.js";
import { fold, type V3Kinds } from "../../../plugins/rootcause/v3/ledger.js";
import { ScriptedModelClient, type ScriptEntry } from "../../../plugins/rootcause/v3/model/client.js";
import { rootCauseV3Projection } from "../../../plugins/rootcause/v3/projection.js";
import { renderReport } from "../../../plugins/rootcause/v3/report.js";
import { Registry } from "../../../plugins/rootcause/v3/tools/registry.js";
import { MemoryTrace, type TraceEntry } from "../../../plugins/rootcause/v3/trace.js";
import type { Alert } from "../../../plugins/rootcause/v3/types.js";
import { concludeNames, provenChain, unlinked } from "../../../plugins/rootcause/v3/unlinked.js";
import { apply, cfg, ev, node, seeded } from "./helpers.js";

const alert: Alert = { id: "a1", source: "edr", title: "Web shell on web-01", observedAt: "2026-05-05T10:00:00Z", artifacts: [], raw: {} };
const range: [string, string] = ["2026-05-05T00:00:00Z", "2026-05-06T00:00:00Z"];
const solid = (call: string) => [ev("direct", "supports", [call]), ev("direct", "supports", [`${call}b`])];

// N1 the alert <- N2 a logon as svc-deploy from 10.1.1.1 (confirmed, by a confirmed link) <- N3 a sign-in as mallory
// from 198.51.100.7 (suspected, by a suspected link): a side branch the proven chain does not reach.
const patch = (unverified = false): GraphPatch => ({
  ...emptyPatch(),
  addNodes: [
    node("logon", { label: "logon to web-01 as svc-deploy from 10.1.1.1", observedAt: "2026-05-05T09:00:00Z", artifacts: [{ kind: "user", value: "svc-deploy" }, { kind: "ip", value: "10.1.1.1" }], evidence: solid("r1") }),
    node("signin", { label: "sign-in as mallory from 198.51.100.7", observedAt: "2026-05-05T08:00:00Z", artifacts: [{ kind: "user", value: "mallory" }, { kind: "ip", value: "198.51.100.7" }], evidence: [ev("corroborating", "supports", ["r2"])], ...(unverified ? { unverified: true } : {}) }),
  ],
  addEdges: [
    { tempId: "e1", kind: "explains", source: "logon", target: "N1", prior: 0.3, evidence: solid("x1") },
    { tempId: "e2", kind: "explains", source: "signin", target: "logon", prior: 0.3, evidence: [ev("corroborating", "supports", ["x2"])] },
  ],
});
const graph = (unverified = false): Graph => { const g = seeded(); apply(g, patch(unverified)); return g; };

const NAMING = "mallory signed in from 198.51.100.7 (N3) and is the origin of the attack. svc-deploy ran the logon on web-01 from 10.1.1.1 (N2). mallory's earlier sign-ins were normal activity.";
const CLEAN = "The logon as svc-deploy from 10.1.1.1 (N2) explains the alert. Who signed in before it is not linked to the alert.";
const answer = (conclusion: string, rootCause?: string) => ({ conclusion, ...(rootCause ? { rootCause } : {}), chain: rootCause ? [rootCause, "N2", "N1"] : ["N2", "N1"], openQuestions: ["who is 198.51.100.7?"], reasoning: "r" });

async function concludeWith(g: Graph, script: unknown[], loose = false) {
  const entries: ScriptEntry[] = script.map((submission) => ({ move: "conclude", correlationId: "N1", toolCalls: [], submission }));
  const c = { ...cfg, loose };
  const model = new ScriptedModelClient({ cfg: c, tools: new Registry(), domains: ["edr"], survey: "", range }, entries);
  const trace = new MemoryTrace("t");
  const ctx: any = { cfg: c, range, domains: ["edr"], model, trace: trace.forTurn(9, "conclude", "N1"), turn: 9, tools: { callCount: 0, coverage: {} }, sizes: {} };
  const p = await conclude({ move: "conclude", targetId: "N1", turn: 9, reason: "budget nearly spent" }, g, ctx);
  apply(g, p, 9);
  return { g, trace, sentBack: trace.chronological().filter((e) => e.type === "reasoning" && (e.payload as { sentBack?: string }).sentBack).map((e) => (e.payload as { sentBack: string }).sentBack), left: model.remaining };
}

describe("the proven chain and who it reaches", () => {
  it("is the alert and what reaches it over confirmed links; a suspected side branch is not on it", () => {
    expect([...provenChain(graph())].sort()).toEqual(["N1", "N2"]);
  });
  it("finds the unreached names an answer gives outside clearing sentences, and in the events it names as root and chain", () => {
    const g = graph();
    expect(concludeNames(g, answer(NAMING)).sort()).toEqual(["198.51.100.7", "mallory"]);
    expect(concludeNames(g, answer("mallory's sign-in was legitimate. The logon as svc-deploy explains the alert (N2)."))).toEqual([]);
    expect(concludeNames(g, answer(CLEAN))).toEqual([]);
    expect(concludeNames(g, answer(CLEAN, "N3")).sort()).toEqual(["198.51.100.7", "mallory"]); // N3's label names them
  });
  it("replaces a whole address only, and an account by its last segment", () => {
    const g = graph();
    apply(g, { addNodes: [node("other", { artifacts: [{ kind: "user", value: "ad:CORP\\eve.smith" }] })] });
    const u = unlinked(g);
    expect(u.text("from 198.51.100.7, not 198.51.100.70; ran as eve.smith")).toBe("from [unlinked address], not 198.51.100.70; ran as [unlinked actor]");
    expect(u.text("eve.smith is not the attacker")).toBe("eve.smith is not the attacker");
    expect(u.count).toBe(2);
  });
});

describe("the conclude move's gate", () => {
  it("sends an answer naming an identity on an unconfirmed side branch back once, with the old loop's wording, and takes the fixed one", async () => {
    const { g, sentBack, left } = await concludeWith(graph(), [answer(NAMING, "N3"), answer(CLEAN)]);
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0]).toMatch(/the conclusion names "(mallory|198\.51\.100\.7)", "(mallory|198\.51\.100\.7)", which the alert's proven chain does not reach/);
    expect(sentBack[0]).toContain("Name someone as the attacker, the origin or an operator only through proven links; otherwise say they are unverified or leave them out. Facts you observed (destinations, hosts, files) can stay, marked as not linked.");
    expect(left).toBe(0);
    expect(g.conclusion!.text).toBe(CLEAN);
  });
  it("accepts a second answer that still names them; the report then redacts them", async () => {
    const { g, sentBack } = await concludeWith(graph(), [answer(NAMING, "N3"), answer(NAMING, "N3")]);
    expect(sentBack).toHaveLength(1);
    expect(g.conclusion!.text).toBe(NAMING);
    const md = renderReport(g, new MemoryTrace("t"), "inconclusive", alert);
    expect(md).toContain("[unlinked actor] signed in from [unlinked address] (N3) and is the origin of the attack.");
  });
  it("lets an answer through that names only the proven chain, or names others only to clear them", async () => {
    for (const text of [CLEAN, "mallory's sign-in from 198.51.100.7 was legitimate. svc-deploy's logon (N2) explains the alert."]) {
      const { sentBack, left, g } = await concludeWith(graph(), [answer(text), answer("unused")]);
      expect(sentBack).toEqual([]);
      expect(left).toBe(1);
      expect(g.conclusion!.text).toBe(text);
    }
  });
  it("is the same in loose mode and strict", async () => {
    for (const loose of [false, true]) {
      const { sentBack, g } = await concludeWith(graph(loose), [answer(NAMING), answer(CLEAN)], loose);
      expect(sentBack).toHaveLength(1);
      expect(g.conclusion!.text).toBe(CLEAN);
    }
  });
});

// The run on its ledger, as the engine journals it, with the conclusion that still names mallory.
function journal(unverified = false) {

  const events: AgentEvent<V3Kinds>[] = [];
  let id = 0;
  const push = (kind: string, payload: unknown) =>
    events.push({ run_id: "r1", run_kind: "root_cause", seq: events.length, ts: new Date().toISOString(), kind, payload: JSON.parse(JSON.stringify(payload)), schema_version: 1 } as AgentEvent<V3Kinds>);
  const entry = (turn: number, p: GraphPatch): TraceEntry => ({ id: `T${String(++id).padStart(6, "0")}`, ts: `2026-05-05T12:00:0${id}Z`, runId: "r1", turn, correlationId: "N1", relatedIds: [], type: "graph-patch", payload: { patch: p } });
  push("run", { run_kind: "root_cause", spec: { sections: { engine: "rootcause-v3" } } });
  push("rootcause_setup", { cfg: { ...cfg, loose: unverified }, alert, index: "lab", range, survey: { text: "", domains: [], sizes: {} }, environment: null });
  push("rootcause_turn", { turn: 1, entries: [entry(1, patch(unverified))] });
  const concluded: GraphPatch = { ...emptyPatch(), setConclusion: { text: NAMING, rootCause: "N3", chain: ["N3", "N2", "N1"], openQuestions: ["who is 198.51.100.7?"], turn: 2 } };
  push("rootcause_turn", { turn: 2, entries: [entry(2, concluded)] });
  const f = fold(events);
  const report = renderReport(f.graph!, new MemoryTrace("r1", () => new Date(), f.entries), "inconclusive", alert);
  push("rootcause_exit", { exit: "inconclusive", report, entries: [] });
  return { events, report };
}

describe("redaction at render", () => {
  for (const loose of [false, true]) describe(loose ? "loose" : "strict", () => {
    const { events, report: md } = journal(loose);
    const view = rootCauseV3Projection("r1", events as never);

    it("the report shows no unreached name outside clearing sentences, and says how many and why", () => {
      expect(md).toContain("**Unlinked names:** 2 identities were named without a proven link to the alert and are shown as [unlinked actor] (an address as [unlinked address]) or left out of the indicators.");
      const outside = md.split("## 5. Raw layer")[0]!.split("\n").filter((l) => !/normal activity/.test(l)).join("\n");
      expect(outside).not.toMatch(/mallory|198\.51\.100\.7/);
      // the clearing sentence keeps its name
      expect(md).toContain("mallory's earlier sign-ins were normal activity.");
      // conclusion, root cause, chain, timeline, narrative, open questions
      expect(md).toContain("[unlinked actor] signed in from [unlinked address] (N3) and is the origin of the attack.");
      expect(md).toMatch(/Root cause the investigator named, unconfirmed: \*\*N3\*\* sign-in as \[unlinked actor\] from \[unlinked address\]/);
      expect(md).toMatch(/\*\*N3\*\* sign-in as \[unlinked actor\] from \[unlinked address\][^\n]* ← link/);
      expect(md).toMatch(/- 2026-05-05T08:00:00Z · \*\*N3\*\* sign-in as \[unlinked actor\] from \[unlinked address\]/);
      expect(md).toContain("### N3 sign-in as [unlinked actor] from [unlinked address]");
      expect(md).toContain("- who is [unlinked address]?");
    });
    it("keeps the proven chain's names, and lists only its accounts and addresses as indicators", () => {
      expect(md).toContain("svc-deploy ran the logon on web-01 from 10.1.1.1 (N2).");
      expect(md).toMatch(/\*\*N2\*\* logon to web-01 as svc-deploy from 10\.1\.1\.1/);
      const iocs = md.split("## Indicators")[1]!.split("## ")[0]!;
      expect(iocs).toContain("10.1.1.1");
      expect(iocs).not.toMatch(/198\.51\.100\.7|mallory|unlinked/);
    });
    it("the run summary is redacted the same", () => {
      const summary = conclusionOf(md);
      expect(summary).toContain("[unlinked actor] signed in from [unlinked address] (N3)");
      expect(summary).toContain("svc-deploy ran the logon");
      expect(summary).not.toMatch(/198\.51\.100\.7/);
    });
    it("the console projection is redacted the same", () => {
      const a = view.account!;
      expect(a.conclusion!.text).toContain("[unlinked actor] signed in from [unlinked address] (N3) and is the origin of the attack.");
      expect(a.conclusion!.text).toContain("mallory's earlier sign-ins were normal activity.");
      const n3 = view.chain!.events.find((e) => e.id === "N3")!;
      expect(n3.label).toMatch(/^sign-in as \[unlinked actor\] from \[unlinked address\]/);
      expect(n3.artifacts).toEqual([{ kind: "user", value: "[unlinked actor]" }, { kind: "ip", value: "[unlinked address]" }]);
      expect(view.chain!.events.find((e) => e.id === "N2")!.label).toBe("logon to web-01 as svc-deploy from 10.1.1.1");
      expect(view.timeline.events.find((e) => e.id === "N3")!.label).toMatch(/^sign-in as \[unlinked actor\] from \[unlinked address\]/);
      expect(view.steps.find((s) => s.step_id === "N3")!).toMatchObject({ event: expect.stringMatching(/^sign-in as \[unlinked actor\] from \[unlinked address\]/), artifact: "user:[unlinked actor]" });
      expect(view.open_questions.find((q) => q.kind === "model")!.text).toBe("who is [unlinked address]?");
      const rest = JSON.stringify({ ...view, report: null, moves: null, account: { ...a, conclusion: null } });
      expect(rest).not.toMatch(/mallory|198\.51\.100\.7/);
    });
  });
});
