// The v3 loop as a worker run: what it journals and how it ends, on the real kernel with a scripted model.
import { describe, expect, it } from "vitest";
import type { AgentEvent, CallPayload } from "../../../contracts/events.js";
import type { ToolResult } from "../../../contracts/tool.js";
import type { ToolDispatch } from "../../../core/seams.js";
import { seedFrom } from "../../../core/budget.js";
import { InProcessState } from "../../../core/state.js";
import { conclusionOf, rangeOf, runRootCauseV3 } from "../../../plugins/rootcause/v3/engine.js";
import { engineOf, type SetupPayload, type V3Kinds } from "../../../plugins/rootcause/v3/ledger.js";
import { rootCauseV3Projection, rootCauseV3Replay } from "../../../plugins/rootcause/v3/projection.js";
import { SUBMIT_TOOL } from "../../../core/stream.js";
import { framed, harnessOf, modelOf, properties, specOf, splunk, telemetry } from "../../support/v3-run.js";

// The ledger without the model's streamed text, which is journaled as it arrives.
const kinds = (events: readonly AgentEvent<V3Kinds>[]) => events.map((e) => e.kind).filter((kind) => kind !== "content");
const fail = () => { throw new Error("the model was not meant to be called"); };

describe("runRootCauseV3", () => {
  it("opens its own ledger, stamped so every reader knows which engine wrote it", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf({ tools: [] });
    await runRootCauseV3(harnessOf(spec, modelOf(fail), splunk(), state), { run_id: "r1", spec });
    const events = await state.read("r1");
    expect(events[0]!.kind).toBe("run");
    expect(engineOf(events)).toBe("rootcause-v3");
  });

  it("refuses a run bound to telemetry no adapter reads, naming the binding", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf({ tools: [{ ...telemetry, id: "elastic_elastic_search_logs" }] });
    const done = await runRootCauseV3(harnessOf(spec, modelOf(fail), splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("failed");
    expect(await state.terminal("r1")).toMatchObject({ outcome: "failed", reason: expect.stringContaining("elastic_elastic_search_logs") });
  });

  it("refuses a brief that says when nothing happened, rather than search blind; the framing turn is journaled and billed", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const model = modelOf(() => ({ emit: framed({ observed_at: null }) }));
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("failed");
    expect((await state.terminal("r1"))!.reason).toMatch(/no point in time/);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((tool) => tool.id)).toEqual([SUBMIT_TOOL]);
    expect(properties(model.requests[0]!)).toContain("observed_at");
    expect(model.requests[0]!.messages.map((m) => m.content).join("\n")).toContain("lab");
    expect(kinds(await state.read("r1"))).toEqual(["run", "frame", "spend", "terminal"]);
  });

  it("refuses when neither the brief nor the settings name an index", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const done = await runRootCauseV3(harnessOf(spec, modelOf(() => ({ emit: framed({ index: null }) })), splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("failed");
    expect((await state.terminal("r1"))!.reason).toMatch(/which of the indexes .*lab.*root_cause_index/);
  });

  it("ends budget_exhausted when the pool refuses the first model call", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf({ budgets: { max_calls: 0, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    const done = await runRootCauseV3(harnessOf(spec, modelOf(fail), splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("budget_exhausted");
    expect((await state.read("r1")).some((e) => e.kind === "spend")).toBe(false);
  });

  it("writes no terminal when the lease is already gone: the run is someone else's to resume", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const lease = new AbortController();
    lease.abort(new Error("lost the lease"));
    const done = await runRootCauseV3(harnessOf(spec, modelOf(fail), splunk(), state), { run_id: "r1", spec, signal: lease.signal });
    expect(done.status).toBe("lost");
    expect(await state.terminal("r1")).toBeNull();
  });

  it("writes no terminal when the lease goes mid-run", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const lease = new AbortController();
    const model = modelOf((request) => {
      if (properties(request).includes("observed_at")) { lease.abort(new Error("lost the lease")); return { emit: framed() }; }
      return {};
    });
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, signal: lease.signal });
    expect(done.status).toBe("lost");
    expect(await state.terminal("r1")).toBeNull();
  });

  it("an operator's stop ends the run aborted with the report so far, its searches journaled as calls", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    let searched = false;
    const model = modelOf((request) => {
      if (properties(request).includes("observed_at")) return { emit: framed() };
      if (properties(request).includes("map")) return { emit: { map: "One source, edr.", reasoning: "mapped" } };
      // The frontier names the first move; the move runs one search and answers. The stop arrives while the model writes it.
      if (request.emit !== undefined) { searched = true; return { emit: { evidence: [], reasoning: "nothing found" }, wait: 1_500 }; }
      const moving = request.messages.some((m) => m.content.includes("<graph_snapshot>"));
      const searchedAlready = request.messages.some((m) => m.role === "tool");
      return moving && !searchedAlready
        ? { calls: [{ tool: "splunk_query", args: { purpose: "look for the process on ws-7", spl: "index=lab sourcetype=edr host=ws-7 | stats count by process" } }] }
        : { content: "done" };
    });
    const stop = async () => (searched ? { directive_id: "d1", actor: "ana", kind: "abort", text: "enough", created_at: "2026-01-05T00:00:00Z" } : null);
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, stop });
    expect(done).toMatchObject({ status: "aborted", reason: "an operator stopped the run: enough" });

    const events = await state.read("r1");
    expect(await state.terminal("r1")).toMatchObject({ outcome: "aborted", summary: expect.any(String) });
    expect(kinds(events)).toEqual(expect.arrayContaining(["rootcause_setup", "rootcause_turn", "rootcause_exit", "directive", "terminal"]));
    const exit = events.find((e) => e.kind === "rootcause_exit")!.payload as { exit: unknown; report: string };
    expect(exit.exit).toBeNull();
    expect(exit.report).toContain("# RCA report");

    // With no move named, the first turn is the frontier's pick, journaled as a decision with its rung: no choose turn.
    const decisions = events.filter((e) => e.kind === "rootcause_turn").flatMap((e) => (e.payload as { entries: { type: string; payload: unknown }[] }).entries).filter((x) => x.type === "decision").map((x) => x.payload);
    expect(decisions[0]).toMatchObject({ move: "strengthen", targetId: "N1", priority: 0, reason: expect.stringMatching(/^frontier P0: /) });

    // The model's search is a call on the run's ledger, under the move's role, with the kernel's ref.
    const calls = events.filter((e) => e.kind === "call").map((e) => e.payload as CallPayload);
    const mine = calls.filter((c) => c.tool === "splunk_query" && c.role === "strengthen");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ref: expect.stringMatching(/^r\d+$/), ok: true });
    expect(new Set(calls.map((c) => c.ref)).size).toBe(calls.length);

    // Both readers pick v3's shape off the engine stamp.
    const view = rootCauseV3Projection("r1", events as never);
    expect(view).toMatchObject({ engine: "rootcause-v3", outcome: "aborted" });
    // History counts the model's searches that ran; the code's own are counted apart.
    expect(view.searches).toBe(calls.filter((c) => c.role !== "code" && c.failure !== "refused").length);
    expect(view.code_searches).toBe(calls.filter((c) => c.role === "code").length);
    expect(rootCauseV3Replay("r1", events as never)).toMatchObject({ engine: "rootcause-v3" });
  }, 20_000);
});

describe("a run the pool cuts off mid-move", () => {
  it("records budget-exhausted, not null, in the ledger, the report and the projection", async () => {
    const state = new InProcessState<V3Kinds>();
    // Setup and the first move fit; a later move's own call is refused.
    const spec = specOf({ budgets: { max_calls: 4, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    const model = modelOf((request) => {
      if (properties(request).includes("observed_at")) return { emit: framed() };
      if (properties(request).includes("map")) return { emit: { map: "One source, edr.", reasoning: "mapped" } };
      return { emit: { evidence: [], reasoning: "nothing found" } };
    });
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("budget_exhausted");
    const events = await state.read("r1");
    const exit = events.find((e) => e.kind === "rootcause_exit")!.payload as { exit: unknown; report: string };
    expect(exit.exit).toBe("budget-exhausted");
    expect(exit.report).toContain("exit **budget-exhausted**");
    expect(rootCauseV3Projection("r1", events as never)).toMatchObject({ exit: "budget-exhausted", outcome: "budget_exhausted" });
  }, 20_000);
});

describe("failed model turns, on the real kernel with a failing provider", () => {
  const BAD_GATEWAY = "502 failed to execute HTTP request to provider API";
  const providerError = (message: string, status: number) => Object.assign(new Error(message), { status });
  const said = { conclusion: "The beacon is all there is.", chain: [], openQuestions: [], reasoning: "the graph" };
  type Request = Parameters<Parameters<typeof modelOf>[0]>[0];
  // Framed and mapped as usual; every move and the closing turn answered by `move` and `conclude`.
  const modelWith = (move: (request: Request) => ReturnType<Parameters<typeof modelOf>[0]>, conclude: () => ReturnType<Parameters<typeof modelOf>[0]> = () => ({ emit: said })) => modelOf((request) => {
    if (properties(request).includes("observed_at")) return { emit: framed() };
    if (properties(request).includes("map")) return { emit: { map: "One source, edr.", reasoning: "mapped" } };
    if (properties(request).includes("conclusion")) return conclude();
    // Scope's own search rounds come before any move.
    return request.messages.some((m) => m.content.includes("<graph_snapshot>")) ? move(request) : { content: "done" };
  });
  const exitOf = (events: readonly AgentEvent<V3Kinds>[]) => events.find((e) => e.kind === "rootcause_exit")!.payload as { exit: unknown; report: string; failed?: string; conclude_failed?: string };
  const turnEntries = (events: readonly AgentEvent<V3Kinds>[], turn: number) => events.filter((e) => e.kind === "rootcause_turn" && (e.payload as { turn: number }).turn === turn).flatMap((e) => (e.payload as { entries: { type: string; payload: unknown }[] }).entries);

  it("a transient 502 runs the same move again, and the run goes on", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf({ budgets: { max_calls: 12, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    let broke = false;
    const model = modelWith(() => {
      if (!broke) { broke = true; throw providerError(BAD_GATEWAY, 502); }
      return { emit: { evidence: [], reasoning: "nothing found" } };
    });
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, retryWaitMs: 0 });
    expect(done.status).not.toBe("failed");
    const events = await state.read("r1");
    const first = turnEntries(events, 1);
    expect(first.filter((x) => x.type === "decision")).toHaveLength(1);
    expect(first.find((x) => x.type === "provider-failure")!.payload).toEqual({ reason: BAD_GATEWAY });
    expect(first.find((x) => x.type === "rejected-submission")!.payload).toEqual({ networkRetry: 1, error: BAD_GATEWAY });
    // The retry answered: the turn's patch is the move's own, not a failed turn's bump.
    expect(first.filter((x) => x.type === "rejected-submission")).toHaveLength(1);
    expect(exitOf(events).failed).toBeUndefined();
  }, 20_000);

  it("three failed turns stop the moves, the closing turn still runs, and the run ends failed with its conclusion", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const model = modelWith(() => { throw providerError("400 the request was not valid", 400); });
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, retryWaitMs: 0 });
    expect(done).toMatchObject({ status: "failed", reason: expect.stringMatching(/^three turns in a row failed: 400 the request was not valid/) });
    const events = await state.read("r1");
    const exit = exitOf(events);
    expect(exit).toMatchObject({ exit: null, failed: expect.stringContaining("400") });
    expect(exit.conclude_failed).toBeUndefined();
    expect(exit.report).toContain("## Investigator's conclusion");
    expect(await state.terminal("r1")).toMatchObject({ outcome: "failed", summary: "The beacon is all there is." });
    const decisions = events.filter((e) => e.kind === "rootcause_turn").flatMap((e) => (e.payload as { entries: { type: string; payload: unknown }[] }).entries).filter((x) => x.type === "decision").map((x) => x.payload as { move: string; reason: string });
    expect(decisions.map((d) => d.move)).toHaveLength(4);
    expect(decisions.at(-1)!.move).toBe("conclude");
    expect(decisions.at(-1)!.reason).toMatch(/^the run ends: 3 turns in a row failed/);
  }, 20_000);

  it("a closing turn that fails too leaves today's report and summary, and the exit says so", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const down = () => { throw providerError("400 the request was not valid", 400); };
    const model = modelWith(down, down);
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, retryWaitMs: 0 });
    expect(done.status).toBe("failed");
    const exit = exitOf(await state.read("r1"));
    expect(exit).toMatchObject({ exit: null, failed: expect.stringContaining("400"), conclude_failed: expect.stringContaining("400") });
    expect(exit.report).not.toContain("## Investigator's conclusion");
    // With no conclusion the summary is the report's opening, as before.
    expect((await state.terminal("r1"))!.summary).toBe(conclusionOf(exit.report));
    expect((await state.terminal("r1"))!.summary).toMatch(/^# RCA report/);
  }, 20_000);

  it("a pool cutoff still tries the closing turn; refused too, the exit says so", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf({ budgets: { max_calls: 4, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 } });
    const model = modelWith(() => ({ emit: { evidence: [], reasoning: "nothing found" } }));
    const done = await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, retryWaitMs: 0 });
    expect(done).toMatchObject({ status: "budget_exhausted", reason: expect.stringContaining("calls_exhausted") });
    const exit = exitOf(await state.read("r1"));
    expect(exit).toMatchObject({ exit: "budget-exhausted", conclude_failed: expect.stringContaining("calls_exhausted") });
    expect(exit.failed).toBeUndefined();
  }, 20_000);
});

describe("a resumed run", () => {
  it("continues at the turn after the last journaled one, with its setup, spend and calls as they were", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    const answer = (stop: () => void) => (request: Parameters<Parameters<typeof modelOf>[0]>[0]) => {
      if (properties(request).includes("observed_at")) return { emit: framed() };
      if (properties(request).includes("map")) return { emit: { map: "One source, edr.", reasoning: "mapped" } };
      if (request.emit !== undefined) { stop(); return { emit: { evidence: [], reasoning: "nothing found" }, wait: 1_500 }; }
      return { content: "done" };
    };

    // The first worker loses its lease while the first move is being answered.
    const lease = new AbortController();
    const first = modelOf(answer(() => lease.abort(new Error("lost the lease"))));
    expect((await runRootCauseV3(harnessOf(spec, first, splunk(), state), { run_id: "r1", spec, signal: lease.signal })).status).toBe("lost");
    expect(await state.terminal("r1")).toBeNull();
    const before = await state.read("r1");
    expect(kinds(before)).toEqual(expect.arrayContaining(["rootcause_setup", "rootcause_turn"]));
    const turnsOf = (events: typeof before) => events.filter((e) => e.kind === "rootcause_turn").map((e) => (e.payload as { turn: number }).turn);

    // The second picks it up: no framing, no mapping, and the next move starts where the first stopped.
    let stopped = false;
    const second = modelOf(answer(() => { stopped = true; }));
    const stop = async () => (stopped ? { directive_id: "d1", actor: "ana", kind: "abort", text: "", created_at: "2026-01-05T00:00:00Z" } : null);
    const done = await runRootCauseV3(harnessOf(spec, second, splunk(), state, seedFrom(before)), { run_id: "r1", spec, stop });
    expect(done.status).toBe("aborted");
    expect(second.requests.some((r) => properties(r).includes("observed_at") || properties(r).includes("map"))).toBe(false);
    const after = await state.read("r1");
    expect(after.filter((e) => e.kind === "rootcause_setup")).toHaveLength(1);
    expect(after.filter((e) => e.kind === "run")).toHaveLength(1);
    // Turns 0 and 1 were the first worker's; the second journals turn 2 and no turn twice.
    expect(turnsOf(before)).toEqual([0, 1]);
    expect(turnsOf(after)).toEqual([0, 1, 2]);
    const refs = after.filter((e) => e.kind === "call").map((e) => (e.payload as CallPayload).ref);
    expect(new Set(refs).size).toBe(refs.length);
  }, 20_000);
});

describe("the run's range", () => {
  // Framed and mapped, then stopped: the setup is journaled and nothing more is searched.
  const setupOf = async (dispatch: ToolDispatch): Promise<SetupPayload> => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    let mapped = false;
    const model = modelOf((request) => {
      if (properties(request).includes("observed_at")) return { emit: framed() };
      if (properties(request).includes("map")) { mapped = true; return { emit: { map: "One source, edr.", reasoning: "mapped" } }; }
      return { content: "done" };
    });
    const stop = async () => (mapped ? { directive_id: "d1", actor: "ana", kind: "abort", text: "", created_at: "2026-01-05T00:00:00Z" } : null);
    await runRootCauseV3(harnessOf(spec, model, dispatch, state), { run_id: "r1", spec, stop });
    return (await state.read("r1")).find((e) => e.kind === "rootcause_setup")!.payload as SetupPayload;
  };

  it("is the data's own span in whole days, measured over all time, and the survey reads that range", async () => {
    const asked: Record<string, unknown>[] = [];
    // The fake index holds 2026-01-05T00:00 to 2026-01-06T00:00; the alert is at 2026-01-05T10:00.
    const setup = await setupOf(splunk(asked));
    expect(setup).toMatchObject({
      range: ["2026-01-05T00:00:00.000Z", "2026-01-07T00:00:00.000Z"],
      range_source: "data",
      data_span: ["2026-01-05T00:00:00.000Z", "2026-01-06T00:00:00.000Z"],
      span_query: "| tstats min(_time) as first max(_time) as last where index=lab",
    });
    const span = asked.find((a) => a["spl_query"] === setup.span_query)!;
    expect(span).toMatchObject({ earliest: "0", latest: "2000000000" });
    const survey = asked.find((a) => String(a["spl_query"]).includes("by sourcetype"))!;
    expect(survey).toMatchObject({ earliest: String(Date.parse(setup.range[0]) / 1000), latest: String(Date.parse(setup.range[1]) / 1000) });
  }, 20_000);

  it("falls back to the alert's window when the span search fails, and says so", async () => {
    const base = splunk();
    const failing: ToolDispatch = {
      invoke: async (tool, args, signal): Promise<ToolResult> =>
        String(args["spl_query"] ?? "").includes("where index=lab") && !String(args["spl_query"]).includes("by sourcetype")
          ? { ok: false, failure: { kind: "backend_error", detail: "Splunk: tstats is not allowed" } }
          : base.invoke(tool, args, signal),
    };
    const setup = await setupOf(failing);
    expect(setup).toMatchObject({ range: ["2025-12-22T10:00:00.000Z", "2026-01-06T10:00:00.000Z"], range_source: "alert-window", data_span: null });
    expect(setup.range_note).toMatch(/tstats is not allowed.*alert's window: 14 days before it to a day after/);
  }, 20_000);
});

describe("the alert's title", () => {
  // Framed and mapped, then stopped, as above.
  const setupOf = async (frames: Record<string, unknown>[]): Promise<SetupPayload> => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    let mapped = false;
    const model = modelOf((request) => {
      if (properties(request).includes("observed_at")) return { emit: frames.length > 1 ? frames.shift() : frames[0] };
      if (properties(request).includes("map")) { mapped = true; return { emit: { map: "One source, edr.", reasoning: "mapped" } }; }
      return { content: "done" };
    });
    const stop = async () => (mapped ? { directive_id: "d1", actor: "ana", kind: "abort", text: "", created_at: "2026-01-05T00:00:00Z" } : null);
    await runRootCauseV3(harnessOf(spec, model, splunk(), state), { run_id: "r1", spec, stop });
    return (await state.read("r1")).find((e) => e.kind === "rootcause_setup")!.payload as SetupPayload;
  };

  it("one that judges the event is asked again, and the setup says so", async () => {
    const setup = await setupOf([framed({ title: "Malicious beacon from ws-7" }), framed({ title: "beacon from ws-7" })]);
    expect(setup.alert.title).toBe("beacon from ws-7");
    expect(setup.frame_note).toMatch(/"Malicious beacon from ws-7" judged the event \("malicious"\); asked again with the rule, it named it neutrally/);
  }, 20_000);

  it("one that still does is named in code, and the setup says so", async () => {
    const setup = await setupOf([framed({ title: "Attacker beacon", action: "beacon", target: "ws-7" })]);
    expect(setup.alert.title).toBe("beacon on ws-7");
    expect(setup.frame_note).toMatch(/still did \("attacker"\), so the title was named in code from the framed parts: "beacon on ws-7"/);
  }, 20_000);

  it("a neutral one leaves no note", async () => {
    const setup = await setupOf([framed()]);
    expect(setup.alert.title).toBe("beacon");
    expect(setup).not.toHaveProperty("frame_note");
  }, 20_000);
});

describe("rangeOf", () => {
  const span = { query: "q", first: "2026-08-11T03:12:00.000Z", last: "2026-08-13T21:40:00.000Z" };

  it("rounds the data's span out to the midnights around it, as the reference's scenarios do", () => {
    expect(rangeOf("2026-08-12T12:34:40Z", span, 14, "")).toMatchObject({ range: ["2026-08-11T00:00:00.000Z", "2026-08-14T00:00:00.000Z"], range_source: "data" });
  });

  it("keeps a last event at midnight inside the range: Splunk's latest is exclusive", () => {
    expect(rangeOf("2026-08-12T00:00:00Z", { ...span, last: "2026-08-13T00:00:00.000Z" }, 14, "").range[1]).toBe("2026-08-14T00:00:00.000Z");
  });

  it("widens the range to an alert after the data's last event, or before its first", () => {
    const after = rangeOf("2026-08-15T08:00:00Z", span, 14, "");
    expect(after.range).toEqual(["2026-08-11T00:00:00.000Z", "2026-08-16T00:00:00.000Z"]);
    expect(after.range_note).toMatch(/after the data's last event/);
    const before = rangeOf("2026-08-09T23:00:00Z", span, 14, "");
    expect(before.range).toEqual(["2026-08-09T00:00:00.000Z", "2026-08-14T00:00:00.000Z"]);
    expect(before.range_note).toMatch(/before the data's first event/);
  });

  it("is the alert's window when the index holds nothing", () => {
    expect(rangeOf("2026-08-12T12:34:40Z", null, 14, "the index holds no events")).toMatchObject({
      range: ["2026-07-29T12:34:40.000Z", "2026-08-13T12:34:40.000Z"], range_source: "alert-window", data_span: null, range_note: expect.stringContaining("holds no events"),
    });
  });
});

describe("a ledger the engine did not open", () => {
  it("is failed, not continued: v3 would write its events onto the kernel plugin's run", async () => {
    const state = new InProcessState<V3Kinds>();
    const spec = specOf();
    await state.append("r1", [{ run_id: "r1", run_kind: "root_cause", kind: "run", payload: { run_kind: "root_cause", spec, budgets: spec.budgets, seed: "r1", tenant_id: null, started_by: "x" } } as never]);
    const done = await runRootCauseV3(harnessOf(spec, modelOf(fail), splunk(), state), { run_id: "r1", spec });
    expect(done.status).toBe("failed");
    expect(kinds(await state.read("r1"))).toEqual(["run", "terminal"]);
  });
});

describe("conclusionOf", () => {
  it("is the investigator's conclusion section, else the report's opening", () => {
    expect(conclusionOf("# Report\n\n## Investigator's conclusion\n\nA mail did it.\n\n## 1. Verdict\n\nTP")).toBe("A mail did it.");
    expect(conclusionOf("# Report\n\nno conclusion")).toBe("# Report\n\nno conclusion");
  });
});
