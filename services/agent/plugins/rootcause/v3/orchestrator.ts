// The loop (spec §8): the model names each move (the frontier picks when it names none that can run), router
// dispatches, the handler returns a patch, the graph applies and rescores it, the trace records it. Handed to the
// caller after every turn so a run can resume.
import type { AgentConfig } from "./config.js";
import { applyPatch, bestPathFromSymptom, createGraph, getParents, emptyPatch, type Graph, type GraphPatch } from "./graph.js";
import { renderReport } from "./report.js";
import { settled } from "./scoring.js";
import { rareSweep } from "./rare.js";
import { route } from "./router.js";
import { fallback, options, optionsText, resolveNext, type LeadState, type NextIn } from "./lead.js";
import type { ModelClient } from "./model/client.js";
import { selectFrontier, toConnect, type FrontierDecision } from "./frontier.js";
import type { Alert, Deps, ExitReason, LoopContext, RunResult, Spent } from "./types.js";

// onTurn gets the graph after the rare sweep (turn 0) and after every turn: what a resume starts from.
// signal: an operator's stop or a lost lease; the run throws its reason at the next turn rather than start one.
// cutoff: an error that ends the moves at once, neither retried nor counted as a failed turn (the pool or the
// gateway refusing another call); the closing turn is still tried. retryWaitMs: the wait before a move lost to the
// network runs again.
export interface RunOpts { runId: string; range: [string, string]; index: string; graph?: Graph; startTurn?: number; signal?: AbortSignal; log?: (s: string) => void; onTurn?: (graph: Graph, turn: number) => void | Promise<void>; cutoff?: (error: unknown) => boolean; retryWaitMs?: number }

// A move whose model call the provider or gateway failed: the kernel hands it back as a failed turn, not a throw.
export class TurnFailed extends Error {}

// A network outage is not the move's fault: the same move runs again after a wait, up to about 10 minutes. The
// reference's list, with the gateway's 5xx added: the reference's SDK retried those 8 times before this list saw
// them, where the kernel's limiter gives up after 3 tries within two seconds.
const NETWORK = /connection error|fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|timed out|timeout|overloaded|\b(?:50[0234]|529)\b|failed to execute HTTP request/i;
const NETWORK_RETRIES = 20;
const NETWORK_WAIT_MS = 30_000;
// Failed turns in a row that stop the moves.
const MAX_FAILURES = 3;

const messageOf = (e: unknown): string => {
  const x = e as { message?: unknown; cause?: { message?: unknown; cause?: { message?: unknown } } } | null;
  return String(x?.message ?? e) + String(x?.cause?.message ?? x?.cause?.cause?.message ?? "");
};

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function seedFromAlert(g: Graph, alert: Alert, cfg: AgentConfig): Graph {
  applyPatch(g, { ...emptyPatch(), addNodes: [{ tempId: "symptom", kind: "action", label: alert.title, domain: alert.source, prior: 0.5, evidence: [], artifacts: alert.artifacts, observedAt: alert.observedAt, isSymptom: true }] }, 0, cfg);
  return g;
}

// The chain to the alert is done: its top is the root, every event and link on it confirmed, no open boundary,
// and each action's ran-as identity settled (top confirmed, rivals <= competitorMax).
export function chainSolid(g: Graph, cfg: AgentConfig): boolean {
  const path = bestPathFromSymptom(g);
  if (path) {
    const nodes = path.nodeIds.map((id) => g.nodes[id]!);
    const top = nodes[nodes.length - 1]!;
    const ok = (x: { status: string; confidence: number }) => settled(x, cfg);
    const solid = nodes.every((n) => n.kind !== "boundary-marker" && ok(n)) && path.edgeIds.every((id) => ok(g.edges[id]!));
    const attributed = nodes.filter((n) => n.kind === "action").every((n) => {
      const es = getParents(g, n.id, "attributed-to").filter((e) => !e.retired).sort((a, b) => b.confidence - a.confidence);
      return !es.length || (ok(es[0]!) && es.slice(1).every((e) => e.confidence <= cfg.thresholds.competitorMax));
    });
    return !!top.isRoot && solid && attributed;
  }
  return false;
}

// Stops the run early. A solid chain does not stop it: branch moves keep widening the picture until the
// frontier has nothing left or the budget runs out (then the exit is root-cause-found if the chain is solid).
export function checkExit(g: Graph, cfg: AgentConfig, spent: Spent): ExitReason | null {
  if (Object.values(g.nodes).some((n) => n.isSymptom && n.status === "ruled-out")) return "false-positive";
  if (spent.usd >= cfg.maxUsd) return "budget-exhausted";
  return null;
}

// The frontier's pick, its reason led by the rung that made it ("frontier P3: ..."; a model-named move's is "model: ...").
function frontier(g: Graph, cfg: AgentConfig, turn: number, coverage?: Record<string, number>): FrontierDecision | null {
  const d = selectFrontier(g, cfg, turn, coverage);
  return d && { ...d, reason: `frontier P${d.priority}: ${d.reason}` };
}

// The least kept back for the closing turn, before the run has a move's cost to go by.
const FLOOR_USD = 0.5;

export async function run(alert: Alert, cfg: AgentConfig, deps: Deps, o: RunOpts): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const graph = o.graph ?? seedFromAlert(createGraph(o.runId), alert, cfg);
  // Rare activity per source, once per run (kept in the graph, so a resume reuses it), into the cached context.
  if (graph.rare === undefined && cfg.rareSweep) {
    graph.rare = await rareSweep({ tools: deps.tools, trace: deps.trace.forTurn(0, undefined, "rare"), index: o.index, range: o.range, domains: deps.domains, timeoutMs: cfg.toolTimeoutMs, signal: o.signal }).catch((e) => { log(`rare sweep failed: ${e}`); return ""; });
    log(`rare sweep: ${graph.rare.split("\n").length} lines`);
  }
  if (graph.rare) deps.model.addContext?.(graph.rare);
  o.signal?.throwIfAborted(); // a sweep cut short by a stop or a lost lease is not kept
  await o.onTurn?.(graph, 0);
  let exit: ExitReason | null = null;
  // The model leads: each submission's `next`, checked against the graph, is the next turn's move. With none
  // (turn 1, a resume, a missing or refused `next`) the frontier picks, at no model cost; with cfg.chooseTurn a
  // choose turn asks the model instead.
  const st: LeadState = {};
  let pending: FrontierDecision | undefined;
  // Every prompt says how much budget is left; under wrapUpAt the model is told to wrap up, and under concludeAt
  // (or when the run would end anyway) one closing conclude turn writes the model's own verdict.
  let cur = o.startTurn ?? 1;
  const usdLeft = () => cfg.maxUsd - deps.budget.usd;
  // Framing and scoping are not moves: a fresh run's average starts after them.
  const setupUsd = (o.startTurn ?? 1) <= 1 ? deps.budget.usd : 0;
  // What the run keeps back: one more move at the average cost so far plus the closing turn (about a move's cost).
  // The floor holds before any move has run.
  const reserve = () => (cur > 1 ? Math.max(FLOOR_USD, (2 * (deps.budget.usd - setupUsd)) / (cur - 1)) : FLOOR_USD);
  const lowOn = (share: number) => usdLeft() <= Math.max(reserve(), share * cfg.maxUsd);
  const budgetText = () => {
    const per = deps.budget.usd / Math.max(1, cur - 1);
    const wrap = lowOn(cfg.wrapUpAt);
    return `<budget>\nspent $${deps.budget.usd.toFixed(2)} of $${cfg.maxUsd} ($${usdLeft().toFixed(2)} left, about ${Math.max(0, Math.floor(usdLeft() / per))} more turns at the rate so far)${wrap ? "\nRunning out: under 10% left. Wrap up: open no new threads. Finish the thread you are on and link what you found to the chain. Do not pick a root cause to have one: if the records do not show where the attack began, it stays open. A closing turn, where you write your conclusion, follows automatically." : ""}\n</budget>`;
  };
  const model: ModelClient = {
    runTurn: async (req) => {
      if (req.move === "scope" || req.move === "conclude") {
        const r = await deps.model.runTurn(req);
        if (r.failed !== undefined) throw new TurnFailed(r.failed);
        return r;
      }
      const choosing = req.move === "choose";
      const chose = curSource ? `\n\n<lead_note>You chose to look in ${curSource} first for this move.</lead_note>` : "";
      const r = await deps.model.runTurn({ ...req, userContent: `${req.userContent}${chose}\n\n${budgetText()}\n\n${optionsText(graph, cfg, st, cur, choosing)}` });
      // A move lost to the provider fails the turn, as the reference's thrown call does. A choose turn's loss is
      // told to the next choose turn, which asks again (it still counts as a failed turn, below).
      if (r.failed !== undefined && !choosing) throw new TurnFailed(r.failed);
      // A choose answer is the choice itself; any other submission carries it under `next`.
      const nx = choosing ? (r.submission as NextIn | null) : (r.submission as { next?: NextIn } | null)?.next;
      if (nx) st.next = nx;
      // A turn with no valid submission is one attempt on its target (the handlers count it); the next prompt says so.
      st.failed = choosing ? r.failed : undefined;
      st.silent = r.submission === null && !choosing ? `${req.move} ${req.correlationId}` : undefined;
      return r;
    },
  };
  let curSource: string | undefined; // the sourcetype the model chose for this turn's move
  // The exit to take once the closing conclude turn has run; null: the moves stopped on failed turns, before an exit.
  let closing: { exit: ExitReason | null } | null = null;
  // Failed turns in a row, each one an attempt on its target so the frontier moves on.
  let failures = 0;
  // Why the moves end with no exit of the graph's own: failed turns, or a cutoff.
  let halt: { exit: ExitReason | null; why: string } | null = null;
  const ended: Pick<RunResult, "failed" | "cut" | "concludeFailed"> = {};
  const failedTurn = (error: string) => {
    if (++failures < MAX_FAILURES) return;
    ended.failed = error;
    halt = { exit: null, why: `${MAX_FAILURES} turns in a row failed, the last with: ${error.slice(0, 300)}` };
  };

  for (let turn = o.startTurn ?? 1; ; turn++) {
    o.signal?.throwIfAborted();
    cur = turn;
    // The closing turn ran, or failed: either way it was the last.
    if (closing) { exit = closing.exit; break; }
    const symptomId = Object.values(graph.nodes).find((n) => n.isSymptom)!.id;
    let decision: FrontierDecision | null;
    if (halt) {
      exit = halt.exit;
      if (graph.conclusion || cfg.concludeAt <= 0) break;
      closing = { exit };
      decision = { move: "conclude", targetId: symptomId, turn, reason: `the run ends${exit ? ` (${exit})` : ""}: ${halt.why}` };
    } else {
      exit = checkExit(graph, cfg, deps.budget);
      if (exit === "budget-exhausted" && chainSolid(graph, cfg)) exit = "root-cause-found";
      // With choose turns, nothing open on the graph ends the run; otherwise the model's last choice runs, or it is asked to choose.
      if (!exit && !pending && cfg.chooseTurn && !Object.keys(options(graph, cfg)).length) exit = chainSolid(graph, cfg) ? "root-cause-found" : "inconclusive";
      decision = exit ? null : pending ? { ...pending, turn }
        : cfg.chooseTurn ? { move: "choose", targetId: symptomId, turn, reason: st.refused ?? st.failed ?? "no next move named" }
        : frontier(graph, cfg, turn, deps.tools.coverage);
      pending = undefined;
      st.next = undefined;
      // The frontier has nothing left: the run ends.
      if (!exit && !decision) exit = chainSolid(graph, cfg) ? "root-cause-found" : "inconclusive";
      if (!exit && cfg.concludeAt > 0 && lowOn(cfg.concludeAt)) exit = chainSolid(graph, cfg) ? "root-cause-found" : "budget-exhausted";
      if (exit) {
        if (graph.conclusion || cfg.concludeAt <= 0) break;
        closing = { exit };
        const why = exit === "inconclusive" ? "Nothing is left to do on the graph." : exit === "false-positive" ? "The alerted event was refuted." : usdLeft() <= reserve() || usdLeft() <= cfg.concludeAt * cfg.maxUsd || exit === "budget-exhausted" ? "The budget is used up." : "The chain to the alert is settled.";
        decision = { move: "conclude", targetId: symptomId, turn, reason: `the run ends (${exit}): ${why}` };
      }
    }
    if (!decision) break;
    curSource = decision.source;

    const tt = deps.trace.forTurn(turn, decision.move, decision.targetId);
    tt.write("decision", decision);
    log(`turn ${turn} · ${decision.move} ${decision.targetId} · $${deps.budget.usd.toFixed(2)} · ${decision.reason}`);
    const ctx: LoopContext = { runId: graph.runId, turn, cfg, model, tools: deps.tools, trace: tt, budget: deps.budget, domains: deps.domains, sizes: deps.sizes, range: o.range, index: o.index, signal: o.signal ?? new AbortController().signal };

    let patch: GraphPatch;
    try {
      // A network outage is not the move's fault: wait and retry the same move, up to about 10 minutes.
      const waitMs = o.retryWaitMs ?? NETWORK_WAIT_MS;
      for (let wait = 1; ; wait++) {
        try { patch = await route(decision, graph, ctx); break; } catch (e) {
          if (o.signal?.aborted || o.cutoff?.(e) || !NETWORK.test(messageOf(e)) || wait > NETWORK_RETRIES) throw e;
          tt.write("rejected-submission", { networkRetry: wait, error: String((e as Error)?.message ?? e) });
          log(`  network error, retrying in ${waitMs / 1000}s (${wait}/${NETWORK_RETRIES}): ${(e as Error)?.message ?? e}`);
          await pause(waitMs, o.signal);
        }
      }
      // A lost choose turn is asked again by the next one, but it is a failed turn all the same.
      if (decision.move === "choose" && st.failed !== undefined) failedTurn(`the choose turn was lost to a provider error${st.failed ? ` (${st.failed})` : ""}`);
      else failures = 0;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const error = String((e as Error)?.message ?? e);
      tt.write("rejected-submission", { error });
      const cut = o.cutoff?.(e) === true;
      if (decision.move === "conclude") {
        // The closing turn failed: the report is rendered without the model's conclusion.
        ended.concludeFailed = error;
        log(`  conclude failed: ${error}`);
      } else if (cut) {
        // The pool or the gateway refused the move's call: the moves end, and the closing turn is tried.
        ended.cut = error;
        halt = { exit: chainSolid(graph, cfg) ? "root-cause-found" : "budget-exhausted", why: "The budget is used up." };
        log(`  cut off: ${error}`);
      } else {
        // A failed turn counts as an attempt on its target, so the frontier moves on; three in a row stop the moves.
        log(`  turn failed: ${error}`);
        failedTurn(error);
        if (decision.move !== "choose") st.silent = `${decision.move} ${decision.targetId}`;
      }
      patch = cut || decision.move === "conclude" || decision.move === "choose" ? emptyPatch()
        : { ...emptyPatch(), incrementAttempts: [decision.targetId], ...(decision.move === "expand" ? { incrementExpand: [decision.targetId] } : {}), ...(decision.move === "fork" ? { incrementForks: [decision.targetId] } : {}), ...(decision.move === "branch" ? { incrementBranch: [decision.targetId] } : {}), ...(decision.move === "connect" ? { incrementConnect: toConnect(graph).map((n) => n.id) } : {}) };
    }
    const result = applyPatch(graph, patch, turn, cfg);
    tt.write("graph-patch", { patch, result: { idMap: result.idMap, rejected: result.rejected, touched: result.touched, resolvedMarkers: result.resolvedMarkers } });
    for (const c of result.changes) tt.write("confidence-change", c);
    for (const r of result.rejected) log(`  rejected: ${r.reason}`);
    const created = [...new Set(Object.values(result.idMap))].filter((id) => (graph.nodes[id]?.createdTurn ?? graph.edges[id]?.createdTurn) === turn);
    for (const id of created) log(`  new ${id} ${graph.nodes[id] ? graph.nodes[id]!.label : `${graph.edges[id]!.source} ${graph.edges[id]!.kind} ${graph.edges[id]!.target}`}`);
    for (const m of result.resolvedMarkers) log(`  boundary ${m} resolved`);
    for (const c of result.changes) log(`  ${c.id} ${c.from.toFixed(2)} -> ${c.to.toFixed(2)} ${c.status}`);
    tt.relate([...new Set([...result.touched, ...Object.values(result.idMap)])]);
    const r = resolveNext(st.next, graph, cfg, turn, created, { index: o.index, range: o.range });
    if (r.probe) {
      const probe = { ...emptyPatch(), addProbe: r.probe };
      const applied = applyPatch(graph, probe, turn, cfg);
      tt.write("graph-patch", { patch: probe, result: { idMap: applied.idMap, rejected: applied.rejected, touched: applied.touched, resolvedMarkers: applied.resolvedMarkers } });
    }
    pending = r.decision;
    const refused = r.refused ?? (decision.move === "choose" && !st.next && st.failed === undefined ? "that was not a valid choice." : undefined);
    st.refused = refused;
    // A refused choose turn is not asked again: an available move runs, so a refusal costs one extra turn at most.
    const fb = decision.move === "choose" && refused ? fallback(graph, cfg, st.next, turn + 1) : undefined;
    if (fb) {
      pending = { ...fb, reason: `fallback after a refused choice: ${refused}` };
      st.refused = `${refused} ${fb.move} ${fb.targetId} runs instead.`;
      log(`  fallback: ${fb.move} ${fb.targetId}`);
    }
    if (st.next || fb) tt.write("reasoning", { ...(st.next ? { lead: st.next } : {}), ...(refused ? { refused } : {}), ...(pending ? { next: `${pending.move} ${pending.targetId}` } : {}) });
    if (r.refused) log(`  lead refused: ${r.refused}`);
    await o.onTurn?.(graph, turn);
  }

  deps.trace.forTurn(-1, undefined, "run").write("exit", { exit, budget: { usd: deps.budget.usd } });
  log(`exit: ${exit} · $${deps.budget.usd.toFixed(2)}`);
  const report = renderReport(graph, deps.trace, exit, alert, deps.budget);
  return { runId: graph.runId, exit: exit ?? (ended.failed !== undefined ? null : "inconclusive"), rootPath: bestPathFromSymptom(graph), report, ...ended };
}
