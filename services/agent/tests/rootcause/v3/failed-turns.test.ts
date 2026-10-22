// Failed model turns, as the reference loop handles them: a network error runs the same move again, any other
// failure is one attempt on the move's target, three in a row stop the moves, and the run still closes with its
// conclude turn.
import { describe, expect, it } from "vitest";
import type { TurnRequest, TurnResult } from "../../../plugins/rootcause/v3/model/client.js";
import { run, type RunOpts } from "../../../plugins/rootcause/v3/orchestrator.js";
import { Registry } from "../../../plugins/rootcause/v3/tools/registry.js";
import { MemoryTrace } from "../../../plugins/rootcause/v3/trace.js";
import { cfg } from "./helpers.js";

const alert = { id: "a", source: "edr", title: "alert", observedAt: "2026-01-01T00:00:00Z", artifacts: [], raw: {} };
const conclusion = { conclusion: "The mail did it.", chain: [], openQuestions: [], reasoning: "" };
const BAD_GATEWAY = "502 failed to execute HTTP request to provider API";

class Cut extends Error {}

// answer: the model's reply to the n-th call, a failure's text in `failed`, or a throw.
const drive = async (answer: (req: TurnRequest, n: number, budget: { usd: number }) => Partial<TurnResult> | unknown, opts: Partial<RunOpts> = {}) => {
  const reqs: TurnRequest[] = [];
  const budget = { usd: 0 };
  const model = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      const said = answer(req, reqs.length, budget) as { failed?: string } | null;
      if (said && typeof said === "object" && "failed" in said) return { submission: null, toolCalls: [], failed: said.failed };
      return { submission: said ?? null, toolCalls: [] };
    },
  };
  const trace = new MemoryTrace("t");
  const r = await run(alert, { ...cfg, rareSweep: false, maxUsd: 100 }, { model, tools: new Registry(), trace, budget, domains: ["edr"], clock: () => new Date() }, { runId: "t", range: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"], index: "x", retryWaitMs: 0, ...opts });
  const entries = trace.chronological();
  const decisions = entries.filter((e) => e.type === "decision").map((e) => ({ turn: e.turn, ...(e.payload as { move: string; targetId: string; reason: string }) }));
  return { reqs, r, entries, decisions };
};

describe("a move lost to the network", () => {
  it("runs again in the same turn after the wait, and the run goes on", async () => {
    const { reqs, r, entries, decisions } = await drive((req, n, budget) => {
      if (req.move === "conclude") return conclusion;
      if (n === 1) return { failed: BAD_GATEWAY };
      if (n === 3) budget.usd = 1e6;
      return { evidence: [], reasoning: "r" };
    });
    expect(reqs.map((x) => x.move)).toEqual(["strengthen", "strengthen", "strengthen", "conclude"]);
    // One decision for the retried turn: the retry is the same move, not a new one.
    expect(decisions.filter((d) => d.turn === 1)).toHaveLength(1);
    expect(entries.filter((e) => e.type === "rejected-submission").map((e) => e.payload)).toEqual([{ networkRetry: 1, error: BAD_GATEWAY }]);
    expect(r).toMatchObject({ exit: "budget-exhausted" });
    expect(r.failed).toBeUndefined();
    expect(r.report).toContain("## Investigator's conclusion");
  });

  it("is retried up to 20 times, then is a failed turn: one attempt on its target", async () => {
    const { reqs, r, entries } = await drive((req, n, budget) => {
      if (req.move === "conclude") return conclusion;
      if (n <= 21) return { failed: "Connection error." };
      budget.usd = 1e6;
      return { evidence: [], reasoning: "r" };
    });
    expect(reqs.slice(0, 21).every((x) => x.move === "strengthen" && x.correlationId === "N1")).toBe(true);
    const turn1 = entries.filter((e) => e.turn === 1);
    expect(turn1.filter((e) => (e.payload as { networkRetry?: number }).networkRetry !== undefined)).toHaveLength(20);
    expect(turn1.find((e) => e.type === "rejected-submission" && !("networkRetry" in (e.payload as object)))!.payload).toEqual({ error: "Connection error." });
    expect(turn1.find((e) => e.type === "graph-patch")!.payload).toMatchObject({ patch: { incrementAttempts: ["N1"] } });
    // The next move's prompt says the lost turn cost an attempt.
    expect(reqs[21]!.userContent).toContain("Your last turn, on strengthen N1, gave no valid submission: it counted as one attempt");
    expect(r.failed).toBeUndefined();
  });

  it("waits out an operator's stop rather than the whole wait", async () => {
    const stop = new AbortController();
    const started = Date.now();
    await expect(drive((req) => {
      if (req.move === "conclude") return conclusion;
      setTimeout(() => stop.abort(new Error("stopped")), 10);
      return { failed: BAD_GATEWAY };
    }, { retryWaitMs: 60_000, signal: stop.signal })).rejects.toThrow("stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("failed turns", () => {
  it("three in a row stop the moves; the closing turn still runs and the report has its conclusion", async () => {
    const { reqs, r, entries, decisions } = await drive((req) => (req.move === "conclude" ? conclusion : { failed: "400 the request was not valid" }));
    // Each failed turn was an attempt on its target, as the reference's bump patch counts it, so the frontier moved on.
    expect(reqs.map((x) => x.move)).toEqual(["strengthen", "strengthen", "expand", "conclude"]);
    const patches = entries.filter((e) => e.type === "graph-patch" && e.turn <= 3).map((e) => (e.payload as { patch: object }).patch);
    expect(patches[0]).toMatchObject({ incrementAttempts: ["N1"] });
    expect(patches[2]).toMatchObject({ incrementAttempts: ["N1"], incrementExpand: ["N1"] });
    expect(decisions.at(-1)).toMatchObject({ move: "conclude", reason: "the run ends: 3 turns in a row failed, the last with: 400 the request was not valid" });
    expect(r.exit).toBeNull();
    expect(r.failed).toBe("400 the request was not valid");
    expect(r.concludeFailed).toBeUndefined();
    expect(r.report).toContain("## Investigator's conclusion");
    expect(r.report).toContain("The mail did it.");
  });

  it("are counted in a row: a turn that answers starts the count again", async () => {
    const { reqs, r } = await drive((req, n, budget) => {
      if (req.move === "conclude") return conclusion;
      if ([1, 2, 4, 5].includes(n)) return { failed: "400 the request was not valid" };
      if (n === 6) budget.usd = 1e6;
      return { evidence: [], reasoning: "r" };
    });
    // Four failed turns, never three in a row: the moves ran until the graph's own exit.
    expect(reqs.length).toBeGreaterThan(5);
    expect(reqs.at(-1)!.move).toBe("conclude");
    expect(r.failed).toBeUndefined();
    expect(r.exit).not.toBeNull();
  });

  it("a closing turn that fails leaves the report as it was, and the result says why", async () => {
    const { reqs, r } = await drive((req, n, budget) => {
      if (req.move === "conclude") return { failed: "400 the request was not valid" };
      if (n === 1) budget.usd = 1e6;
      return { evidence: [], reasoning: "r" };
    });
    expect(reqs.map((x) => x.move)).toEqual(["strengthen", "conclude"]);
    expect(r.exit).toBe("budget-exhausted");
    expect(r.concludeFailed).toBe("400 the request was not valid");
    expect(r.report).not.toContain("## Investigator's conclusion");
  });

  it("three failed turns then a failed closing turn: no conclusion, both said", async () => {
    const { reqs, r } = await drive(() => ({ failed: "400 the request was not valid" }));
    expect(reqs.map((x) => x.move)).toEqual(["strengthen", "strengthen", "expand", "conclude"]);
    expect(r).toMatchObject({ exit: null, failed: "400 the request was not valid", concludeFailed: "400 the request was not valid" });
    expect(r.report).not.toContain("## Investigator's conclusion");
  });
});

describe("a cutoff", () => {
  it("ends the moves at once, neither retried nor counted, and the closing turn still runs", async () => {
    const { reqs, r, entries } = await drive((req, n) => {
      if (req.move === "conclude") return conclusion;
      if (n === 2) throw new Cut("the budget refused another iteration: calls_exhausted (network)");
      return { evidence: [], reasoning: "r" };
    }, { cutoff: (e) => e instanceof Cut });
    expect(reqs.map((x) => x.move)).toEqual(["strengthen", "strengthen", "conclude"]);
    expect(entries.some((e) => "networkRetry" in (e.payload as object))).toBe(false);
    expect(r).toMatchObject({ exit: "budget-exhausted", cut: "the budget refused another iteration: calls_exhausted (network)" });
    expect(r.failed).toBeUndefined();
    expect(r.report).toContain("The mail did it.");
  });
});
