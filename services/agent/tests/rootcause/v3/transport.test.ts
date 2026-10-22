// A move is one kernel turn: its role, its schema, its searches as calls on the run's ledger, its answer checked and sent back to fix.
import { describe, expect, it } from "vitest";
import type { CallPayload } from "../../../contracts/events.js";
import { InProcessState } from "../../../core/state.js";
import { loadPlugin } from "../../../plugins/index.js";
import { defaultConfig } from "../../../plugins/rootcause/v3/config.js";
import type { V3Kinds } from "../../../plugins/rootcause/v3/ledger.js";
import { CORRECTIONS, KernelModelClient, KernelTurns, Refused, type TurnRequest } from "../../../plugins/rootcause/v3/model/client.js";
import { constraints, instructions, SYSTEM_PROMPT } from "../../../plugins/rootcause/v3/model/prompts.js";
import { correction, issued, neverRan, Registry, type EvidenceTool } from "../../../plugins/rootcause/v3/tools/registry.js";
import { rootCauseV3Projection } from "../../../plugins/rootcause/v3/projection.js";
import { MemoryTrace } from "../../../plugins/rootcause/v3/trace.js";
import { toolsFrom } from "../../../tools/remote.js";
import { SUBMIT_TOOL } from "../../../core/stream.js";
import { harnessOf, modelOf, specOf, splunk } from "../../support/v3-run.js";
import { strengthen } from "../../../plugins/rootcause/v3/handlers/strengthen.js";
import { scope, SCOPE_BATCH, SCOPE_SEARCHES } from "../../../plugins/rootcause/v3/scope.js";
import type { LoopContext } from "../../../plugins/rootcause/v3/types.js";
import { apply, node, seeded } from "./helpers.js";

const cfg = { ...defaultConfig };
const range: [string, string] = ["2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z"];

// An evidence tool that answers from a table: what the model's search comes back with.
const evidence = (answers: Record<string, string>): EvidenceTool => ({
  name: "splunk_query",
  description: "Search.",
  inputSchema: { type: "object", properties: { purpose: { type: "string" }, spl: { type: "string" } }, required: ["purpose", "spl"] },
  readOnly: true,
  run: async (input) => (input.spl in answers ? { ok: true, data: answers[input.spl]! } : { ok: false, error: `refused: no such search ${input.spl}` }),
});

const cand = (label: string, ids: string[]) => ({ label, domain: "edr", prior: 0.3, artifacts: [], nodeEvidence: [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: ids }], edgeEvidence: [] });

function setup(answer: Parameters<typeof modelOf>[0], table: Record<string, string> = {}, spec = specOf()) {
  const state = new InProcessState<V3Kinds>();
  const provider = modelOf(answer);
  const harness = harnessOf(spec, provider, splunk(), state);
  const turns = new KernelTurns(harness as never, { run_id: "r1", run_kind: "root_cause", spec, plugin: loadPlugin("rootcause").manifest, tools: toolsFrom(spec.tools) });
  const tools = new Registry().register(evidence(table));
  const client = new KernelModelClient({ cfg, tools, domains: ["edr"], survey: "## Survey\n- edr: 10 events", range }, turns);
  const trace = new MemoryTrace("r1");
  const request = (over: Partial<TurnRequest> = {}): TurnRequest => ({ move: "expand", correlationId: "N1", userContent: "Find the cause.", submitTool: "submit_causes", allowedDomains: ["edr"], trace: trace.forTurn(1, "expand", "N1"), ...over });
  const calls = async () => (await state.read("r1")).filter((e) => e.kind === "call").map((e) => e.payload as CallPayload);
  return { state, provider, tools, client, trace, request, calls };
}

const SEARCH = { purpose: "find the process on ws-7", spl: "index=lab sourcetype=edr host=ws-7 | stats count by process" };

describe("a move as a kernel turn", () => {
  it("runs under the move's role and schema with the evidence tool, journaling each search as a call the answer can cite", async () => {
    const t = setup(
      (request) => {
        if (request.emit !== undefined) return { emit: { candidates: [cand("curl wrote /tmp/x", ["r1"]), cand("ghost event", ["r9"])], reasoning: "r" } };
        return request.messages.some((m) => m.role === "tool") ? { content: "done" } : { calls: [{ tool: "splunk_query", args: SEARCH }] };
      },
      { [SEARCH.spl]: "3 events matched\ncurl wrote /tmp/x" },
    );
    t.client.addContext("## Environment\none source");
    const out = await t.client.runTurn(t.request());

    // The kernel's turn: system, the move's task, the evidence tool only, the move's schema for the emission.
    const [first, , emission] = t.provider.requests;
    expect(first!.messages[0]!.content).toContain(SYSTEM_PROMPT.slice(0, 80));
    expect(first!.messages[0]!.content).toContain("- edr: 10 events");
    expect(first!.messages[0]!.content).toContain("## Environment");
    expect(first!.messages.some((m) => m.content.includes("Find the cause."))).toBe(true);
    expect(first!.tools.map((x) => x.id)).toEqual(["splunk_query", SUBMIT_TOOL]);
    expect(Object.keys((emission!.emit!["properties"] ?? {}) as object)).toContain("candidates");
    expect(JSON.stringify(emission!.emit)).not.toContain("maxLength");

    // The search is a call on the run's ledger under the move's role, and the model was shown its ref.
    const calls = await t.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ref: "r1", role: "expand", tool: "splunk_query", ok: true });
    const shown = t.provider.requests[1]!.messages.find((m) => m.role === "tool")!.content;
    expect(shown).toContain('ref="r1"');
    expect(shown).toContain("curl wrote /tmp/x");
    expect(out.toolCalls).toMatchObject([{ id: "r1", ok: true, text: "3 events matched\ncurl wrote /tmp/x" }]);
    expect(t.tools.callCount).toBe(1);
    expect(t.tools.inputOf("r1")).toEqual(SEARCH);
    expect(t.tools.outputOf("r1")).toBe("3 events matched\ncurl wrote /tmp/x");
    expect(t.trace.chronological().filter((e) => e.type === "query").map((e) => (e.payload as { toolCallId: string }).toolCallId)).toEqual(["r1"]);

    // The emitted value is checked once: a ref the kernel never journaled fails the answer whole, as the reference.
    expect(out.submission).toBeNull();
    const rejected = t.trace.chronological().filter((e) => e.type === "rejected-submission");
    expect(rejected.some((e) => JSON.stringify(e.payload).includes("r9"))).toBe(true);
    expect(rejected.some((e) => "salvaged" in (e.payload as object))).toBe(false);
  });

  // The reference's two settings for Claude: the conversation cached to its last message, and thinking on open rounds.
  // The kernel asks; the wire sends them to Claude only, and never thinking on the forced round.
  it("asks every call of a move to cache its conversation and to think", async () => {
    const t = setup(
      (request) => (request.force === SUBMIT_TOOL ? { emit: { candidates: [cand("curl wrote /tmp/x", ["r1"])], reasoning: "r" } } : { calls: [{ tool: "splunk_query", args: SEARCH }] }),
      { [SEARCH.spl]: "3 events matched\ncurl wrote /tmp/x" },
    );
    await t.client.runTurn(t.request({ maxSearches: 1 }));
    expect(t.provider.requests.map((r) => [r.force, r.cache_conversation, r.think])).toEqual([
      [undefined, true, true],
      [SUBMIT_TOOL, true, true],
    ]);
  });

  // A move that searches to its cap one search a round gets every search, then answers on the forced round.
  it("takes a move's answer on the round after its last search, with no further call", async () => {
    const t = setup(
      (request) => (request.force === SUBMIT_TOOL ? { emit: { candidates: [cand("curl wrote /tmp/x", ["r1"])], reasoning: "r" } } : { calls: [{ tool: "splunk_query", args: SEARCH }] }),
      { [SEARCH.spl]: "3 events matched\ncurl wrote /tmp/x" },
    );
    const out = await t.client.runTurn(t.request({ maxSearches: 2 }));

    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, undefined, SUBMIT_TOOL]);
    expect(t.provider.requests.some((r) => r.emit !== undefined)).toBe(false);
    expect(out.toolCalls).toMatchObject([{ id: "r1", ok: true }, { id: "r2", ok: true }]);
    expect(out.toolCalls[1]!.text).toBe("3 events matched\ncurl wrote /tmp/x");
    expect(t.provider.requests[2]!.messages.filter((m) => m.role === "tool").at(-1)!.content).toContain(`No searches left this turn. Submit now with ${SUBMIT_TOOL}.`);
    expect((out.submission as { candidates: { label: string }[] }).candidates.map((c) => c.label)).toEqual(["curl wrote /tmp/x"]);
  });

  it("a move with no searches asks nothing of the tool, and a failed search comes back as a failed call", async () => {
    const t = setup(
      (request) => (request.emit !== undefined ? { emit: { candidates: [], reasoning: "r" } } : request.messages.some((m) => m.role === "tool") || !request.tools.some((x) => x.id === "splunk_query") ? { content: "done" } : { calls: [{ tool: "splunk_query", args: { ...SEARCH, spl: "index=lab nope" } }] }),
    );
    const searched = await t.client.runTurn(t.request());
    expect(searched.toolCalls).toMatchObject([{ id: "r1", ok: false }]);
    expect((await t.calls())[0]).toMatchObject({ ok: false, failure: "backend_error" });
    expect(t.tools.outputOf("r1")).toBe("");
    // It never ran: it keeps its number but is no evidence, and the next search is r2.
    expect(t.tools.callCount).toBe(1);
    expect(issued(t.tools, "r1")).toBe(false);
    expect(t.tools.coverage).toEqual({});

    const none = await t.client.runTurn(t.request({ move: "conclude", submitTool: "submit_conclusion", maxSearches: 0 }));
    expect(t.provider.requests.at(-1)!.tools).toEqual([]);
    expect(none.toolCalls).toEqual([]);
  });

  it("holds a search to the tool's schema: one without a purpose comes back as invalid_args and never reaches the backend", async () => {
    const t = setup(
      (request) => (request.emit !== undefined ? { emit: { candidates: [], reasoning: "r" } } : request.messages.some((m) => m.role === "tool") ? { content: "done" } : { calls: [{ tool: "splunk_query", args: { spl: SEARCH.spl } }] }),
      { [SEARCH.spl]: "3 events matched" },
    );
    const out = await t.client.runTurn(t.request());
    expect(out.toolCalls).toMatchObject([{ id: "r1", ok: false }]);
    expect((await t.calls())[0]).toMatchObject({ ok: false, failure: "invalid_args" });
    expect(out.toolCalls[0]!.text).toMatch(/^bad input: \/ must have required property 'purpose'/);
  });

  it("trims an over-long next.why instead of rejecting the submission", async () => {
    const t = setup((request) => (request.emit !== undefined ? { emit: { candidates: [], reasoning: "r", next: { move: "expand", why: "x".repeat(400) } } } : { content: "done" }));
    const out = await t.client.runTurn(t.request());
    const why = (out.submission as { next: { why: string } }).next.why;
    expect(why).toHaveLength(300);
    expect(why.endsWith("…")).toBe(true);
  });

  describe("an emission the kernel rejected", () => {
    const art = (kind: string) => ({ kind, value: "a@b.test" });
    const withArtifacts = (label: string, artifacts: unknown[]) => ({ ...cand(label, []), artifacts });
    const salvaged = (t: ReturnType<typeof setup>) => t.trace.chronological().some((e) => e.type === "rejected-submission" && /dropped 1 item/.test(JSON.stringify(e.payload)));

    it("drops the whole candidate holding an artifact that missed the enum, as the reference, and keeps the others", async () => {
      const bad = { candidates: [withArtifacts("good", [art("email-address")]), withArtifacts("has a bad artifact", [art("host"), art("email-sender")]), cand("also good", [])], reasoning: "r" };
      const t = setup((request) => (request.emit !== undefined ? { emit: bad } : { content: "done" }));
      const out = await t.client.runTurn(t.request());

      expect(t.provider.requests.filter((r) => r.emit !== undefined)).toHaveLength(2);
      const got = (out.submission as { candidates: { label: string; artifacts: unknown[] }[] }).candidates;
      expect(got.map((c) => c.label)).toEqual(["good", "also good"]);
      expect(salvaged(t)).toBe(true);
    });

    it("drops the whole candidate holding one bad identity signal, and keeps the others", async () => {
      const signal = (layer: string) => ({ layer, kind: "account", value: "svc", toolCallIds: [] });
      const bad = { candidates: [cand("good", []), { ...cand("has a bad signal", []), identitySignals: [signal("machine-facing"), signal("both")] }], reasoning: "r" };
      const t = setup((request) => (request.emit !== undefined ? { emit: bad } : { content: "done" }));
      const out = await t.client.runTurn(t.request());
      expect((out.submission as { candidates: { label: string }[] }).candidates.map((c) => c.label)).toEqual(["good"]);
      expect(salvaged(t)).toBe(true);
    });

    it("drops a top-level item, and returns null when that leaves a list under its schema minimum", async () => {
      const one = { evidence: [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: [] }], artifacts: [art("email-sender"), art("host")], reasoning: "r" };
      const t = setup((request) => (request.emit !== undefined ? { emit: one } : { content: "done" }));
      const out = await t.client.runTurn(t.request({ submitTool: "submit_assessment" }));
      expect((out.submission as { artifacts: unknown[] }).artifacts).toEqual([art("host")]);

      const theory = (id: string) => ({ id, story: "s", accountsFor: [], gaps: "g", predictions: [{ id: "P1", sourcetype: "edr", expect: "e", spl: "index=lab", separates: [] }] });
      const two = { theories: [theory("H1"), { ...theory("H2"), predictions: [{ id: "P2", sourcetype: "edr", expect: 7, spl: "x", separates: [] }] }], nextTests: ["P1"], reasoning: "r" };
      const u = setup((request) => (request.emit !== undefined ? { emit: two } : { content: "done" }));
      expect((await u.client.runTurn(u.request({ submitTool: "submit_theories" }))).submission).toBeNull();
    });

    // As the reference's zod parses it: a key the schema has no field for is dropped, at any depth, and is never an
    // error. Nothing is lifted from where it was put to where the schema has a field of that name.
    describe("a key the schema does not know", () => {
      const boundary = { targetDomain: "email", reason: "the mail gateway would record the sender", inDomainExhausted: true };
      const emit = async (submission: unknown, submitTool: TurnRequest["submitTool"] = "submit_causes") => {
        const t = setup((request) => (request.emit !== undefined ? { emit: submission } : { content: "done" }));
        const out = await t.client.runTurn(t.request({ submitTool }));
        const entry = (type: string) => t.trace.chronological().find((e) => e.type === type)?.payload as Record<string, unknown> | undefined;
        return { t, got: out.submission as { candidates: { label: string }[]; boundary?: unknown } | null, note: entry("rejected-submission"), taken: entry("submission"), emits: t.provider.requests.filter((r) => r.emit !== undefined).length };
      };

      it("is dropped from a candidate on the first emission, and a boundary in it is not lifted to the top level", async () => {
        const { got, note, taken, emits } = await emit({ candidates: [{ ...cand("phishing email delivered", []), boundary }, cand("also good", [])], reasoning: "r" });
        expect(emits).toBe(1);
        expect(got).toEqual({ candidates: [cand("phishing email delivered", []), cand("also good", [])], reasoning: "r" });
        expect(note).toBeUndefined();
        expect(taken!["stripped"]).toEqual(["candidates.0.boundary"]);
      });

      it("is dropped whatever it is called, from the candidate and from the submission itself", async () => {
        const inner = await emit({ candidates: [{ ...cand("kept", []), notes: "x", nodeEvidence: [{ ...cand("", []).nodeEvidence[0], edge: "E1" }] }], reasoning: "r" });
        expect(inner.got!.candidates).toEqual([cand("kept", [])]);
        expect(inner.taken!["stripped"]).toEqual(["candidates.0.nodeEvidence.0.edge", "candidates.0.notes"]);
        const root = await emit({ candidates: [cand("kept", [])], reasoning: "r", confidence: 0.9, source: "edr", why: "w" });
        expect(root.got).toEqual({ candidates: [cand("kept", [])], reasoning: "r" });
        expect(root.taken!["stripped"]).toEqual(["confidence", "source", "why"]);
        const entry = await emit({ candidates: [{ ...cand("kept", []), boundary }], reasoning: "r" }, "submit_entry_points");
        expect(entry.got).toEqual({ candidates: [cand("kept", [])], reasoning: "r" });
      });

      it("does not save a candidate with a real error: it is dropped whole, and the rest kept without their stray keys", async () => {
        const { label: _, ...unlabelled } = cand("", []);
        const { got, note, emits } = await emit({ candidates: [{ ...unlabelled, boundary }, { ...cand("kept", []), notes: "x" }], reasoning: "r" });
        expect(emits).toBe(2);
        expect(got).toEqual({ candidates: [cand("kept", [])], reasoning: "r" });
        expect(note!["salvaged"]).toBe("kept the rest, dropped 1 item(s)");
        expect(note!["error"]).not.toContain("boundary");
        expect(note!["stripped"]).toEqual(["candidates.0.boundary", "candidates.1.notes"]);
      });

      it("drops a candidate the check refuses, and only that one", async () => {
        const { got, note } = await emit({ candidates: [{ ...cand("token minted outside captured telemetry", []), boundary }, { ...cand("kept", []), notes: "x" }], reasoning: "r" });
        expect(got).toEqual({ candidates: [cand("kept", [])], reasoning: "r" });
        expect(note!["salvaged"]).toBe("kept the rest, dropped 1 item(s)");
      });

      it("does not fill a missing required field from an item: the submission still fails", async () => {
        const ev = [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: [] }];
        expect((await emit({ causes: [{ ...cand("upstream", []), evidence: ev }], reasoning: "r" }, "submit_assessment")).got).toBeNull();
      });

      it("does not save a submission citing a search never run, however sound the rest", async () => {
        const { got, note } = await emit({ candidates: [cand("cites a search never run", ["r9"]), { ...cand("kept", []), notes: "x" }], reasoning: "r" });
        expect(got).toBeNull();
        expect(note).not.toHaveProperty("salvaged");
      });
    });

    it("gets nothing from an emission that was not JSON", async () => {
      const t = setup((request) => (request.emit !== undefined ? { emit: "no json here" } : { content: "done" }));
      expect((await t.client.runTurn(t.request())).submission).toBeNull();
    });

    it("accepts an email address and a message id as artifacts", async () => {
      const ok = { candidates: [withArtifacts("mail sent", [art("email-address"), { kind: "message-id", value: "<abc@mail.test>" }])], reasoning: "r" };
      const t = setup((request) => (request.emit !== undefined ? { emit: ok } : { content: "done" }));
      const out = await t.client.runTurn(t.request());
      expect(t.provider.requests.filter((r) => r.emit !== undefined)).toHaveLength(1);
      expect((out.submission as { candidates: { artifacts: unknown[] }[] }).candidates[0]!.artifacts).toHaveLength(2);
    });
  });

  it("tells the model the cap is on searches", () => {
    expect(constraints(cfg, range, ["edr"], ["edr"])).toContain(`searches this turn: at most ${cfg.maxToolCallsPerTurn}\n`);
  });

  it("drops a citation of a refused call, live and as a resume rebuilds it", () => {
    const refused = { failure: "refused", result: "" };
    const guarded = { failure: "backend_error", result: '<vigil:tool_result tool="splunk_query" ref="r2">\nfailed: backend_error -- refused: name the index\n</vigil:tool_result>' };
    const ran = { failure: null, result: "<vigil:tool_result>\n1 row(s)\n</vigil:tool_result>" };
    const reg = new Registry();
    [refused, guarded, ran].forEach((c, i) => reg.note(`r${i + 1}`, { spl: "sourcetype=a" }, "", !neverRan(c)));
    expect(["r1", "r2", "r3"].map((id) => issued(reg, id))).toEqual([false, false, true]);
    expect(reg.callCount).toBe(3);
    expect(reg.coverage).toEqual({ a: 1 });
  });

  it("cites only refs as the ledger spells them", () => {
    expect(["r1", "r3", "r03", "r0", "r4", "tc_1"].map((id) => issued({ callCount: 3 }, id))).toEqual([true, true, false, false, false, false]);
  });

  it("is one attempt on its target when the model never emits a valid submission", async () => {
    const t = setup((request) => (request.emit !== undefined ? { emit: { nothing: true } } : { content: "done" }));
    const out = await t.client.runTurn(t.request());
    expect(out.submission).toBeNull();
    expect(t.trace.chronological().some((e) => e.type === "rejected-submission")).toBe(true);
  });

  it("reports a provider error on the emission or the tool turn as failed, apart from an emission the model got wrong", async () => {
    const down = () => { throw new Error("502 failed to execute HTTP request to provider API"); };
    for (const dies of ["emit", "tool"]) {
      const t = setup((request) => ((dies === "emit") === (request.emit !== undefined) ? down() : request.emit !== undefined ? { emit: { candidates: [], reasoning: "r" } } : { content: "done" }));
      const out = await t.client.runTurn(t.request());
      expect(out.submission).toBeNull();
      expect(out.failed).toContain("502");
      expect(t.trace.chronological().map((e) => e.type)).toContain("provider-failure");
      expect(t.trace.chronological().map((e) => e.type)).not.toContain("rejected-submission");
    }
    const bad = setup((request) => (request.emit !== undefined ? { emit: { nothing: true } } : { content: "done" }));
    expect((await bad.client.runTurn(bad.request())).failed).toBeUndefined();
  });

  it("ends the run when the pool refuses another call", async () => {
    const spec = specOf({ budgets: { max_calls: 0, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    const t = setup(() => ({}), {}, spec);
    await expect(t.client.runTurn(t.request())).rejects.toBeInstanceOf(Refused);
  });
});

describe("an answer that fails its check goes back to the model, twice at most", () => {
  const submit = (answer: unknown) => ({ calls: [{ tool: SUBMIT_TOOL, args: answer }] });
  const good = { candidates: [cand("curl wrote /tmp/x", ["r1"])], reasoning: "r" };
  const bad = { candidates: [cand("curl wrote /tmp/x", ["r1"]), cand("ghost event", ["r9"])], reasoning: "r" };
  const labels = (out: { submission: unknown }) => (out.submission as { candidates: { label: string }[] }).candidates.map((c) => c.label);
  const kinds = (t: ReturnType<typeof setup>) => t.trace.chronological().map((e) => e.type);

  it("takes the fixed answer after one correction, with nothing salvaged, and the correction is no search", async () => {
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : n === 2 ? submit(bad) : submit(good)), { [SEARCH.spl]: "3 events matched\ncurl wrote /tmp/x" });
    const out = await t.client.runTurn(t.request());

    expect(CORRECTIONS).toBe(2);
    expect(t.provider.requests).toHaveLength(3);
    // The answer citing this move's own search r1 passes the check inside the turn.
    expect(labels(out)).toEqual(["curl wrote /tmp/x"]);
    expect(kinds(t)).not.toContain("rejected-submission");
    // On the ledger: the search, then the answer sent back, under the move's role.
    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.tool, c.ok, c.failure, c.role])).toEqual([["r1", "splunk_query", true, null, "expand"], ["r2", SUBMIT_TOOL, false, "invalid_args", "expand"]]);
    expect(calls[1]!.result).toContain(`Invalid submission: toolCallIds never issued in this run: r9.`);
    expect(t.provider.requests[2]!.messages.filter((m) => m.role === "tool").at(-1)!.content).toContain(`Fix it and call ${SUBMIT_TOOL} again.`);
    // Not a search: not returned, not traced, not citable, not coverage, not in the projection; it keeps its number.
    expect(out.toolCalls.map((c) => c.id)).toEqual(["r1"]);
    expect(t.trace.chronological().filter((e) => e.type === "query").map((e) => (e.payload as { toolCallId: string }).toolCallId)).toEqual(["r1"]);
    expect(correction(calls[1]!)).toBe(true);
    expect(issued(t.tools, "r2")).toBe(false);
    expect(t.tools.callCount).toBe(2);
    expect(t.tools.coverage).toEqual({ edr: 1 });
    expect(rootCauseV3Projection("r1", (await t.state.read("r1")) as never).searches).toBe(1);
  });

  it("sends an answer its gate refuses back once, as a correction, and takes the next one whatever the gate says", async () => {
    const said = (n: number) => ({ conclusion: `answer ${n} names mallory`, chain: [], openQuestions: [], reasoning: "r" });
    const t = setup((request, n) => (request.force === SUBMIT_TOOL ? { emit: said(n) } : submit(said(n))));
    const gate = (a: unknown) => (/mallory/.test((a as { conclusion: string }).conclusion) ? "the conclusion names \"mallory\"" : null);
    const out = await t.client.runTurn(t.request({ move: "conclude", submitTool: "submit_conclusion", maxSearches: 0, gate }));

    expect(t.provider.requests).toHaveLength(2);
    const calls = await t.calls();
    expect(calls.map((c) => [c.tool, c.failure])).toEqual([[SUBMIT_TOOL, "invalid_args"]]);
    expect(calls[0]!.result).toContain("the conclusion names \"mallory\"");
    expect((out.submission as { conclusion: string }).conclusion).toBe("answer 2 names mallory");
    expect(t.trace.chronological().filter((e) => e.type === "reasoning").map((e) => e.payload)).toEqual([{ sentBack: "the conclusion names \"mallory\"" }]);
    expect(kinds(t)).not.toContain("rejected-submission");
  });

  it("salvages the last answer after two corrections", async () => {
    const unseen = { candidates: [cand("curl wrote /tmp/x", ["r1"]), cand("token minted outside captured telemetry", ["r1"])], reasoning: "r" };
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : submit(unseen)), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());

    expect(t.provider.requests).toHaveLength(4);
    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.tool, c.failure])).toEqual([["r1", "splunk_query", null], ["r2", SUBMIT_TOOL, "invalid_args"], ["r3", SUBMIT_TOOL, "invalid_args"]]);
    expect(labels(out)).toEqual(["curl wrote /tmp/x"]);
    const note = t.trace.chronological().filter((e) => e.type === "rejected-submission").map((e) => e.payload as Record<string, string>);
    expect(note).toHaveLength(1);
    expect(note[0]!["salvaged"]).toBe("kept the rest, dropped 1 item(s)");
    expect(out.toolCalls.map((c) => c.id)).toEqual(["r1"]);
    expect(out.failed).toBeUndefined();
  });

  it("salvages nothing after two corrections when the answer cites a search never run", async () => {
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : submit(bad)), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());
    expect(out.submission).toBeNull();
    const note = t.trace.chronological().filter((e) => e.type === "rejected-submission").map((e) => e.payload as Record<string, string>);
    expect(note).toHaveLength(1);
    expect(note[0]!["error"]).toContain("toolCallIds never issued in this run: r9.");
    expect(note[0]).not.toHaveProperty("salvaged");
  });

  it("spends none of the move's searches: both run, and the next ref follows the correction's", async () => {
    const two = { purpose: "the parent", spl: "index=lab sourcetype=edr host=ws-7 parent" };
    const t = setup(
      (request, n) => (request.force === SUBMIT_TOOL ? { emit: { candidates: [cand("curl wrote /tmp/x", ["r1", "r3"])], reasoning: "r" } } : n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : n === 2 ? submit(bad) : { calls: [{ tool: "splunk_query", args: two }] }),
      { [SEARCH.spl]: "3 events matched", [two.spl]: "1 event matched" },
    );
    const out = await t.client.runTurn(t.request({ maxSearches: 2 }));

    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, undefined, undefined, SUBMIT_TOOL]);
    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.tool, c.ok])).toEqual([["r1", "splunk_query", true], ["r2", SUBMIT_TOOL, false], ["r3", "splunk_query", true]]);
    expect(calls.filter((c) => neverRan(c))).toEqual([]);
    expect(out.toolCalls.map((c) => [c.id, c.text])).toEqual([["r1", "3 events matched"], ["r3", "1 event matched"]]);
    expect(labels(out)).toEqual(["curl wrote /tmp/x"]);
    expect(["r1", "r2", "r3"].map((id) => issued(t.tools, id))).toEqual([true, false, true]);
    // A search the code makes next takes r4, not the correction's number.
    expect((await t.tools.call("splunk_query", SEARCH, { allowedDomains: ["edr"], allDomains: ["edr"], timeoutMs: 1000, range })).toolCallId).toBe("r4");
  });

  // As the reference: a move with no searches opens on a round free to think, and once that round has answered,
  // its searches are spent, so the correction is forced.
  it("corrects a move with no searches too: its first round free, the correction forced", async () => {
    const fixed = { evidence: [{ summary: "s", strength: "direct", polarity: "supports", toolCallIds: [] }], reasoning: "r" };
    const t = setup((_, n) => (n === 1 ? submit({ evidence: [{ ...fixed.evidence[0], toolCallIds: ["r9"] }], reasoning: "r" }) : { emit: fixed }));
    const out = await t.client.runTurn(t.request({ move: "strengthen", submitTool: "submit_assessment", maxSearches: 0 }));
    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, SUBMIT_TOOL]);
    expect(t.provider.requests[0]!.tools.map((x) => x.id)).toEqual([SUBMIT_TOOL]);
    expect((await t.calls()).map((c) => [c.ref, c.tool])).toEqual([["r1", SUBMIT_TOOL]]);
    expect(out.submission).toEqual(fixed);
    expect(out.toolCalls).toEqual([]);
  });
});

describe("an answer that fails its schema goes back to the model like one that fails its check", () => {
  const submit = (answer: unknown) => ({ calls: [{ tool: SUBMIT_TOOL, args: answer }] });
  const good = { candidates: [cand("curl wrote /tmp/x", ["r1"]), cand("bash ran curl", ["r1"])], reasoning: "r" };
  // The live failures: a key the schema does not know inside a candidate, and the next move's fields flattened to the top.
  const stray = { candidates: [cand("curl wrote /tmp/x", ["r1"]), { ...cand("bash ran curl", ["r1"]), boundary: { source: "proxy" }, edge: "E1" }], reasoning: "r" };
  const labels = (out: { submission: unknown }) => (out.submission as { candidates: { label: string }[] }).candidates.map((c) => c.label);
  const taken = (t: ReturnType<typeof setup>) => t.trace.chronological().find((e) => e.type === "submission")?.payload as Record<string, unknown>;

  // As the reference's zod: a key the schema has no field for is dropped, not an error, so it costs no correction.
  it("takes an answer whose only fault is a key the schema does not know the first time, without that key", async () => {
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : submit(stray)), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());

    expect(t.provider.requests).toHaveLength(2);
    expect(out.submission).toEqual(good);
    expect((await t.calls()).map((c) => [c.ref, c.tool])).toEqual([["r1", "splunk_query"]]);
    expect(t.trace.chronological().map((e) => e.type)).not.toContain("rejected-submission");
    expect(taken(t)["stripped"]).toEqual(["candidates.1.boundary", "candidates.1.edge"]);
  });

  it("still corrects a next move sent as a string, dropping the next move's fields flattened beside it", async () => {
    const flat = { ...good, source: "edr", target: "N1", why: "the parent process", next: "expand" };
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : n === 2 ? submit(flat) : submit({ ...good, next: { move: "expand", target: "N1", why: "the parent process" } })), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());

    expect(t.provider.requests).toHaveLength(3);
    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.tool, c.failure])).toEqual([["r1", "splunk_query", null], ["r2", SUBMIT_TOOL, "invalid_args"]]);
    expect(calls[1]!.result).toContain(`Invalid submission: next: must be object. Fix it and call ${SUBMIT_TOOL} again.`);
    expect(calls[1]!.result).not.toContain("unrecognized key");
    expect(labels(out)).toEqual(["curl wrote /tmp/x", "bash ran curl"]);
    expect((out.submission as { next: unknown }).next).toEqual({ move: "expand", target: "N1", why: "the parent process" });
  });

  it("still corrects a value outside its enum, and says only that", async () => {
    const off = { candidates: [cand("curl wrote /tmp/x", ["r1"]), { ...cand("bash ran curl", ["r1"]), edge: "E1", nodeEvidence: [{ summary: "s", strength: "strong", polarity: "supports", toolCallIds: ["r1"] }] }], reasoning: "r" };
    const t = setup((_, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : n === 2 ? submit(off) : submit(good)), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());

    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.tool, c.failure])).toEqual([["r1", "splunk_query", null], ["r2", SUBMIT_TOOL, "invalid_args"]]);
    expect(calls[1]!.result).toContain("Invalid submission: candidates.1.nodeEvidence.0.strength: must be equal to one of the allowed values: direct, corroborating, circumstantial. Fix it");
    expect(calls[1]!.result).not.toContain("unrecognized key");
    expect(labels(out)).toEqual(["curl wrote /tmp/x", "bash ran curl"]);
  });

  it("salvages the last answer as before once both corrections are spent, without its stray keys", async () => {
    const off = { candidates: [{ ...cand("curl wrote /tmp/x", ["r1"]), edge: "E1" }, { ...cand("bash ran curl", ["r1"]), domain: 7 }], reasoning: "r", why: "w" };
    const t = setup((request, n) => (n === 1 ? { calls: [{ tool: "splunk_query", args: SEARCH }] } : request.emit !== undefined ? { emit: off } : submit(off)), { [SEARCH.spl]: "3 events matched" });
    const out = await t.client.runTurn(t.request());

    // Two sent back, the third to the emission turn and its retry, as a schema-invalid submit always went.
    expect(t.provider.requests.map((r) => r.emit !== undefined)).toEqual([false, false, false, false, true, true]);
    expect((await t.calls()).map((c) => [c.ref, c.tool])).toEqual([["r1", "splunk_query"], ["r2", SUBMIT_TOOL], ["r3", SUBMIT_TOOL]]);
    expect(out.submission).toEqual({ candidates: [cand("curl wrote /tmp/x", ["r1"])], reasoning: "r" });
    const note = t.trace.chronological().filter((e) => e.type === "rejected-submission").map((e) => e.payload as Record<string, unknown>);
    expect(note).toHaveLength(1);
    expect(note[0]!["salvaged"]).toBe("kept the rest, dropped 1 item(s)");
    expect(note[0]!["stripped"]).toEqual(["candidates.0.edge", "why"]);
    expect(out.failed).toBeUndefined();
  });
});

describe("a turn's search cap counts searches, not rounds", () => {
  const search = (i: number) => ({ purpose: `search ${i}`, spl: `index=lab sourcetype=edr q=${i}` });
  const table = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [search(i + 1).spl, `${i + 1} events matched`]));
  const refusedCalls = (calls: CallPayload[]) => calls.filter((c) => c.failure === "refused");
  const NO_MORE = `Not run: no searches left this turn. Submit now with ${SUBMIT_TOOL}.`;

  it("runs the first 3 of 5 searches one response asks for under a cap of 3 and refuses the other 2, uncitable", async () => {
    const t = setup(
      (request) => (request.emit !== undefined || request.force === SUBMIT_TOOL ? { emit: { candidates: [], reasoning: "r" } } : request.messages.some((m) => m.role === "tool") ? { content: "done" } : { calls: [1, 2, 3, 4, 5].map((i) => ({ tool: "splunk_query", args: search(i) })) }),
      table(5),
    );
    const out = await t.client.runTurn(t.request({ maxSearches: 3 }));
    // The cap spent in the first response, the second is the answer, forced.
    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, SUBMIT_TOOL]);

    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.ok])).toEqual([["r1", true], ["r2", true], ["r3", true], ["r4", false], ["r5", false]]);
    expect(refusedCalls(calls).map((c) => c.ref)).toEqual(["r4", "r5"]);
    for (const c of refusedCalls(calls)) expect(c.result).toContain(NO_MORE);
    expect(t.tools.inputOf("r3")).toEqual(search(3));
    expect(["r1", "r2", "r3", "r4", "r5"].map((id) => issued(t.tools, id))).toEqual([true, true, true, false, false]);
    expect(out.toolCalls.map((c) => c.text)).toEqual(["1 events matched", "2 events matched", "3 events matched", expect.stringContaining(NO_MORE), expect.stringContaining(NO_MORE)]);
    // The search that spent the cap says so, as the refusals do.
    const shown = t.provider.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(shown[2]).toContain(JSON.stringify(`3 events matched\nNo searches left this turn. Submit now with ${SUBMIT_TOOL}.`));
    expect(shown[1]).not.toContain("No searches left");
  });

  it("caps strengthen at 3 searches, however the model spreads them over rounds", async () => {
    const t = setup(
      (request, n) => (request.emit !== undefined || request.force === SUBMIT_TOOL ? { emit: { evidence: [], reasoning: "r" } } : n === 1 ? { calls: [1, 2].map((i) => ({ tool: "splunk_query", args: search(i) })) } : n === 2 ? { calls: [3, 4, 5].map((i) => ({ tool: "splunk_query", args: search(i) })) } : { content: "done" }),
      table(5),
    );
    const g = seeded();
    const symptom = Object.keys(g.nodes)[0]!;
    const ctx = { runId: "r1", turn: 1, cfg, model: t.client, tools: t.tools, trace: t.trace.forTurn(1, "strengthen", symptom), domains: ["edr"], range, index: "lab", signal: new AbortController().signal } as unknown as LoopContext;
    await strengthen({ move: "strengthen", targetId: symptom, why: "check it" } as never, g, ctx);

    expect(cfg.strengthenSearches).toBe(3);
    expect(t.provider.requests[0]!.messages.map((m) => m.content).join("\n")).toContain("searches this turn: at most 3\n");
    const calls = await t.calls();
    expect(calls.map((c) => [c.ref, c.ok])).toEqual([["r1", true], ["r2", true], ["r3", true], ["r4", false], ["r5", false]]);
    expect(refusedCalls(calls).map((c) => c.ref)).toEqual(["r4", "r5"]);
  });

  it("runs scope's 14 searches in batches of 7: the rest of a response waits for the results", async () => {
    const BATCH = `Not run: at most ${SCOPE_BATCH} searches per batch. Read these results first, then send the next batch (fix any search that returned nothing).`;
    const t = setup(
      (request, n) => (request.emit !== undefined || request.force === SUBMIT_TOOL ? { emit: { map: `**Systems**\n- ws-7 seen 12 times\n${"- host seen 10 times\n".repeat(12)}`, reasoning: "r" } }
        : n === 1 ? { calls: Array.from({ length: 9 }, (_, i) => ({ tool: "splunk_query", args: search(i + 1) })) }
        : n === 2 ? { calls: Array.from({ length: 8 }, (_, i) => ({ tool: "splunk_query", args: search(i + 8) })) }
        : { calls: [{ tool: "splunk_query", args: search(16) }] }),
      table(16),
    );
    const deps = { model: t.client, tools: t.tools, trace: t.trace, domains: ["edr"], sizes: { edr: 10 } } as never;
    const map = await scope(deps, cfg, range);

    expect([SCOPE_SEARCHES, SCOPE_BATCH]).toEqual([14, 7]);
    expect(map).toContain("ws-7 seen 12 times");
    const calls = await t.calls();
    const ran = calls.filter((c) => c.failure !== "refused").map((c) => JSON.parse(c.arguments).purpose);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => `search ${i}`));
    // First response: 7 run, 2 wait. Second: 7 run (the cap), the 8th is past the cap. Third: the answer, forced,
    // so the model is never free to ask for more.
    expect(refusedCalls(calls).map((c) => [JSON.parse(c.arguments).purpose, c.result.includes(BATCH), c.result.includes(NO_MORE)])).toEqual([
      ["search 8", true, false], ["search 9", true, false], ["search 15", false, true],
    ]);
    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, undefined, SUBMIT_TOOL]);
  });
});

// The reference forces the submit, with no thinking, from the round after the one that spent the move's searches, and
// keeps every round after it forced. The round count alone would leave those rounds free, and thinking.
describe("a move that has spent its searches answers on the next round, forced, as the reference", () => {
  const search = (i: number) => ({ purpose: `search ${i}`, spl: `index=lab sourcetype=edr q=${i}` });
  const table = Object.fromEntries([1, 2, 3, 4].map((i) => [search(i).spl, `${i} events matched`]));
  const good = { candidates: [cand("curl wrote /tmp/x", ["r1"])], reasoning: "r" };
  const bad = { candidates: [cand("curl wrote /tmp/x", ["r1"]), cand("ghost event", ["r9"])], reasoning: "r" };
  const pair = (a: number, b: number) => ({ calls: [a, b].map((i) => ({ tool: "splunk_query", args: search(i) })) });

  it("forces the round after the cap is reached mid-round, with rounds still left on the count", async () => {
    const t = setup((request, n) => (request.force === SUBMIT_TOOL ? { emit: good } : n === 1 ? pair(1, 2) : n === 2 ? pair(3, 4) : { calls: [{ tool: "splunk_query", args: search(5) }] }), table);
    const out = await t.client.runTurn(t.request({ maxSearches: 3 }));

    // Searches 1-3 run, the 4th is past the cap; the third round is the answer, though the count allows a fourth.
    expect((await t.calls()).map((c) => [c.ref, c.ok])).toEqual([["r1", true], ["r2", true], ["r3", true], ["r4", false]]);
    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, undefined, SUBMIT_TOOL]);
    // The kernel asks every round to think; the wire never sends thinking on a forced one (tests/core/claude-wire).
    expect(t.provider.requests.every((r) => r.think === true)).toBe(true);
    expect(out.submission).toEqual(good);
  });

  it("keeps a correction after a forced answer forced", async () => {
    const t = setup((request, n) => (request.force === SUBMIT_TOOL ? { emit: n === 2 ? bad : good } : { calls: [{ tool: "splunk_query", args: search(1) }] }), table);
    const out = await t.client.runTurn(t.request({ maxSearches: 1 }));

    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, SUBMIT_TOOL, SUBMIT_TOOL]);
    expect((await t.calls()).map((c) => [c.ref, c.tool])).toEqual([["r1", "splunk_query"], ["r2", SUBMIT_TOOL]]);
    expect(out.submission).toEqual(good);
  });

  it("leaves every round free while searches are left", async () => {
    const submit = { calls: [{ tool: SUBMIT_TOOL, args: good }] };
    const t = setup((_, n) => (n === 1 ? pair(1, 2) : submit), table);
    const out = await t.client.runTurn(t.request({ maxSearches: 6 }));

    expect(t.provider.requests.map((r) => r.force)).toEqual([undefined, undefined]);
    expect(out.submission).toEqual(good);
  });

  it("opens a move with no searches on a free round that offers only the submit, and answers there", async () => {
    const t = setup(() => ({ calls: [{ tool: SUBMIT_TOOL, args: { evidence: [], reasoning: "r" } }] }));
    const out = await t.client.runTurn(t.request({ move: "strengthen", submitTool: "submit_assessment", maxSearches: 0 }));

    expect(t.provider.requests.map((r) => [r.force, r.tools.map((x) => x.id)])).toEqual([[undefined, [SUBMIT_TOOL]]]);
    expect(out.submission).toEqual({ evidence: [], reasoning: "r" });
  });
});

describe("what a move's prompt tells the model to call", () => {
  // Every move's instructions, built on a graph that has the pieces each one names.
  const moves = (): Record<string, string> => {
    const g = seeded();
    apply(g, { addNodes: [node("m", { kind: "boundary-marker", originNodeId: "N1", targetDomain: "edr" }), node("leaf", { label: "leaf" })], addEdges: [{ tempId: "e", kind: "explains", source: "m", target: "N1", prior: 0.3, evidence: [] }] });
    const [leaf] = Object.keys(g.nodes).filter((id) => g.nodes[id]!.label === "leaf");
    g.theories = [{ id: "R1.H1", round: 1, story: "s", accountsFor: [], gaps: "", status: "live", support: 0, against: 0, predictions: [{ id: "R1.P1", sourcetype: "edr", expect: "x", spl: "x", separates: [], next: false, status: "open" }] }];
    return {
      strengthen: instructions.strengthen(g, "N1"), expand: instructions.expand(g, "N1"), fork: instructions.fork(g, "N1"), branch: instructions.branch(g, "N1"),
      pivotEntry: instructions.pivotEntry(g, "B1", range), pivotForward: instructions.pivotForward(g, "B1", leaf!), connect: instructions.connect(g, "N1", [leaf!]),
      scope: instructions.scope(), test: instructions.test(g, "R1.P1"), theorize: instructions.theorize(), choose: instructions.choose(), conclude: instructions.conclude("Enough."),
    };
  };

  it("names no submit tool: the answer is asked for in the kernel's emit step, which grants none", () => {
    for (const [move, text] of Object.entries({ ...moves(), system: SYSTEM_PROMPT })) expect(text, move).not.toMatch(/submit_/);
  });

  it("offers every tool the model is told to use: the evidence tool on a searching move, none on a move without searches", async () => {
    const t = setup((request) => (request.emit !== undefined ? { emit: { candidates: [], reasoning: "r" } } : { content: "done" }));
    const all = moves();
    await t.client.runTurn(t.request({ userContent: all.expand! }));
    await t.client.runTurn(t.request({ move: "conclude", submitTool: "submit_conclusion", maxSearches: 0, userContent: all.conclude! }));
    for (const [i, searches] of [[0, true], [2, false]] as const) {
      const sent = t.provider.requests[i]!;
      const text = sent.messages.map((m) => m.content).join("\n");
      expect(text).not.toMatch(/submit_/);
      expect(sent.tools.map((x) => x.id)).toEqual(searches ? ["splunk_query", SUBMIT_TOOL] : [SUBMIT_TOOL]);
    }
    expect(all.conclude).not.toContain("splunk_query");
  });
});

describe("a move's model: scope on the scope model, a refused move asked again as the reference does", () => {
  const MAP = { map: `**Systems**\n- ws-7 seen 12 times\n${"- host seen 10 times\n".repeat(12)}`, reasoning: "r" };
  const SNAPSHOT = "Find the cause.\n<graph_snapshot>\nN1 curl wrote /tmp/x\nSTORIES (competing explanations of the whole incident; latest round live)\nR1.H1 an attacker ran curl\n</graph_snapshot>";
  const sent = (request: { messages: readonly { content: string }[] }) => request.messages.map((m) => m.content).join("\n");
  const spends = async (state: InProcessState<V3Kinds>) => (await state.read("r1")).filter((e) => e.kind === "spend").map((e) => e.payload as { model_id: string; role: string });
  const refusals = (trace: MemoryTrace) => trace.chronological().filter((e) => e.type === "refusal").map((e) => e.payload);
  const answered = (request: Parameters<Parameters<typeof modelOf>[0]>[0]) => (request.emit !== undefined ? { emit: { candidates: [], reasoning: "r" } } : { content: "done" });

  it("runs scope's every call on cfg.scopeModel, and journals its spend as that model; a move without one runs on the run's", async () => {
    const t = setup((request) => (request.emit !== undefined || request.force === SUBMIT_TOOL ? { emit: MAP } : { content: "done" }));
    const deps = { model: t.client, tools: t.tools, trace: t.trace, domains: ["edr"], sizes: { edr: 10 } } as never;
    expect(cfg.scopeModel).toBe("claude-sonnet-5");
    expect(await scope(deps, cfg, range)).toContain("ws-7 seen 12 times");
    expect(t.provider.models.length).toBeGreaterThan(0);
    expect(new Set(t.provider.models)).toEqual(new Set(["claude-sonnet-5"]));
    expect(await spends(t.state)).toEqual(t.provider.models.map(() => expect.objectContaining({ model_id: "claude-sonnet-5", role: "scope" })));

    const before = t.provider.models.length;
    await t.client.runTurn(t.request());
    expect(new Set(t.provider.models.slice(before))).toEqual(new Set(["scripted/model"]));
  });

  it("asks a refused move again without the STORIES section, on the same model", async () => {
    const t = setup((request, n) => (n === 1 ? { refuse: true } : answered(request)));
    const out = await t.client.runTurn(t.request({ userContent: SNAPSHOT }));

    expect(out.submission).toEqual({ candidates: [], reasoning: "r" });
    expect(sent(t.provider.requests[0]!)).toContain("STORIES (competing");
    for (const r of t.provider.requests.slice(1)) {
      expect(sent(r)).not.toContain("STORIES");
      expect(sent(r)).toContain("N1 curl wrote /tmp/x\n</graph_snapshot>");
    }
    expect(new Set(t.provider.models)).toEqual(new Set(["scripted/model"]));
    expect(refusals(t.trace)).toEqual([{ attempt: 1, model: "scripted/model", retry: "without STORIES" }]);
    expect(t.trace.chronological().map((e) => e.type)).not.toContain("provider-failure");
  });

  it("refused again, asks it on cfg.refusalFallbackModel with the whole snapshot", async () => {
    const t = setup((request, _n, model) => (model !== cfg.refusalFallbackModel ? { refuse: true } : answered(request)));
    const out = await t.client.runTurn(t.request({ userContent: SNAPSHOT }));

    expect(out.submission).toEqual({ candidates: [], reasoning: "r" });
    expect(t.provider.models.slice(0, 2)).toEqual(["scripted/model", "scripted/model"]);
    expect(new Set(t.provider.models.slice(2))).toEqual(new Set(["claude-sonnet-5"]));
    expect(sent(t.provider.requests[2]!)).toContain("STORIES (competing");
    expect(refusals(t.trace)).toEqual([
      { attempt: 1, model: "scripted/model", retry: "without STORIES" },
      { attempt: 2, model: "scripted/model", retry: "fallback model claude-sonnet-5" },
    ]);
    expect((await spends(t.state)).slice(2).every((s) => s.model_id === "claude-sonnet-5" && s.role === "expand")).toBe(true);
  });

  it("refused a third time, gives up on the move: no submission, no searches, the run goes on", async () => {
    const t = setup(() => ({ refuse: true }));
    const out = await t.client.runTurn(t.request({ userContent: SNAPSHOT }));

    expect(out).toEqual({ submission: null, toolCalls: [] });
    expect(t.provider.models).toEqual(["scripted/model", "scripted/model", "claude-sonnet-5"]);
    expect(refusals(t.trace)).toEqual([
      { attempt: 1, model: "scripted/model", retry: "without STORIES" },
      { attempt: 2, model: "scripted/model", retry: "fallback model claude-sonnet-5" },
      { attempt: 3, gaveUp: true },
    ]);
    expect(t.trace.chronological().map((e) => e.type)).not.toContain("submission");
  });

  it("keeps the pool refusing a call apart: it ends the run, and no model is asked again", async () => {
    const spec = specOf({ budgets: { max_calls: 0, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    const t = setup(() => ({ refuse: true }), {}, spec);
    await expect(t.client.runTurn(t.request({ userContent: SNAPSHOT }))).rejects.toBeInstanceOf(Refused);
    expect(t.provider.requests).toHaveLength(0);
    expect(refusals(t.trace)).toEqual([]);
  });

  it("does not take a provider failure for a refusal: it is not asked again", async () => {
    const t = setup(() => { throw new Error("502 failed to execute HTTP request to provider API"); });
    const out = await t.client.runTurn(t.request({ userContent: SNAPSHOT }));
    expect(out.failed).toContain("502");
    expect(new Set(t.provider.models)).toEqual(new Set(["scripted/model"]));
    expect(refusals(t.trace)).toEqual([]);
  });
});
