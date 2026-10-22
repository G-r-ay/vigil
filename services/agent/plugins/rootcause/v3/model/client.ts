// Model calls (spec §5.2). A move is one kernel turn: the model may search up to the move's cap
// (maxToolCallsPerTurn, counted in searches, not rounds) through the evidence tool, which refuses any search past it,
// then emits the move's submission against its schema. The kernel journals every search as a `call` event
// with a ref, bills the model, delimits the results and resumes. The move's own check runs inside the turn: an
// answer that fails it or the schema goes back to the model to fix, twice at most, and then what is sound in it is salvaged.
import { runSubturn, type PluginContext, type PluginHooks, type Subturn, type AgentKinds, type AgentOptions } from "../../../../core/agent.js";
import { schemaErrors, SUBMIT_TOOL } from "../../../../core/stream.js";
import type { CallPayload, RunKind } from "../../../../contracts/events.js";
import { defineTool, type RegisteredTool, type ToolResult } from "../../../../contracts/tool.js";
import type { Harness, Outcome } from "../../../../core/loop.js";
import type { PluginManifest } from "../../../../contracts/plugin.js";
import type { RunSpec } from "../../../../core/spec.js";
import type { AgentConfig } from "../config.js";
import type { Move } from "../frontier.js";
import { correction, issued, neverRan, type EvidenceTool, type Registry, type ToolRegistry } from "../tools/registry.js";
import type { TurnTrace } from "../trace.js";
import type { Domain } from "../types.js";
import { lengthLimits, SUBMIT, SUBMIT_DESCRIPTIONS, type SubmitName } from "./schemas.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { baselineProblem, type InputOf } from "../baseline.js";

export type TurnMove = Move | "pivot-entry" | "pivot-forward" | "scope";

export interface TurnRequest {
  move: TurnMove;
  correlationId: string;
  userContent: string;
  submitTool: SubmitName;
  allowedDomains: Domain[];
  focusTime?: string; // the target's time: the default search window is built around it
  beforeMs?: number; // look-back of the default window
  maxSearches?: number; // this move's search cap, below cfg.maxToolCallsPerTurn (strengthen needs few)
  minCount?: number; // mapping mode for the search tool
  maxPerBatch?: number; // searches run per model response; the rest wait for the results
  model?: string; // a model of its own for this move (scope's, a refusal's fallback); the spec's when unset
  trace: TurnTrace;
}

export interface ToolCallOut { id: string; tool: string; input: unknown; ok: boolean; traceId: string; text?: string }

export interface TurnResult {
  submission: unknown | null;
  toolCalls: ToolCallOut[];
  failed?: string; // the provider or gateway failed this turn (its error text): the model's answer was never judged
}

export interface ModelClient {
  runTurn(req: TurnRequest): Promise<TurnResult>;
  addContext?(text: string): void; // appended to the system prompt (the environment map), cached with it
}

export interface ClientDeps { cfg: AgentConfig; tools: ToolRegistry; domains: Domain[]; survey: string; range: [string, string] }

// The pool refused another model call: the run's allowance (calls, dollars, wall clock) is spent. Not the model
// refusing a move, which runTurn retries.
export class Refused extends Error {}

// What a refused move is asked again without: the snapshot's STORIES section, the attack narrative a refusal most
// often rests on.
const STORIES = /\nSTORIES \(competing[\s\S]*?(?=\n<\/graph_snapshot>)/;

// Runs one evidence tool call the code makes (a script's, a sweep's) and traces it: the query, then the output.
export async function runTool(d: ClientDeps, req: TurnRequest, tool: string, input: unknown): Promise<ToolCallOut> {
  const rec = await d.tools.call(tool, input, { allowedDomains: req.allowedDomains, allDomains: d.domains, timeoutMs: d.cfg.toolTimeoutMs, range: d.range, focusTime: req.focusTime, beforeMs: req.beforeMs, minCount: req.minCount });
  req.trace.write("query", { toolCallId: rec.toolCallId, tool, input });
  const text = rec.result.ok ? rec.result.data : rec.result.error;
  const traceId = req.trace.write("tool-output", { toolCallId: rec.toolCallId, ok: rec.result.ok, output: text });
  return { id: rec.toolCallId, tool, input, ok: rec.result.ok, traceId, text };
}

// Over-long text is trimmed, not refused: a long note must not throw away a correct finding. The caps are the schemas'.
export const LIMITS = lengthLimits(Object.values(SUBMIT));
const trim = (v: string, max: number | undefined) => (max && v.length > max ? v.slice(0, max - 1) + "…" : v);
// A list or object sent as a JSON string (models do send events that way) is parsed, not refused.
const STRUCT = new Set(["takeover", "candidates", "effects", "causes", "events", "evidence", "nodeEvidence", "edgeEvidence", "artifacts", "identitySignals", "baseline", "boundary", "theories", "predictions", "nextTests", "toolCallIds", "supports", "weakens", "links", "unrelated", "contradicts"]);
const unstring = (v: string): unknown => { try { const x = JSON.parse(v); return x && typeof x === "object" ? x : v; } catch { return v; } };
export const clip = (v: unknown, key = ""): unknown =>
  typeof v === "string" && STRUCT.has(key) && /^\s*[[{]/.test(v) && unstring(v) !== v ? clip(unstring(v), key)
  : typeof v === "string" ? trim(v, LIMITS.scalar[key])
  : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? trim(x, LIMITS.items[key]) : clip(x)))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, k)])) : v;

// Why a clipped value does not meet the move's schema (what the kernel's ajv holds an emission to, plus the length
// caps), with the list items the failure rests on, from the paths ajv reports: the top-level item on each path
// (`effects/0` for `effects/0/artifacts/1`), dropped whole as the reference drops it. A failure outside any
// top-level item leaves nothing to drop, and salvage nothing to keep. null when it does meet it.
const itemOf = (p: string[]) => (p.length >= 2 && /^\d+$/.test(p[1]!) ? p.slice(0, 2) : []);
function schemaProblem(name: SubmitName, value: unknown): { msg: string; drop: Path[] } | null {
  const msg = schemaErrors(SUBMIT[name], value);
  if (msg === null) return null;
  const paths = msg.split("; ").map((e) => e.split(" ")[0]!.split("/").slice(1));
  const drop = paths.map(itemOf).filter((p) => p.length);
  return { msg, drop: drop.length === paths.length ? drop : [] };
}

// The kernel's ajv has held the emission to the schema already; this clips it, then checks citations and the rest.
// Every toolCallId must be a search the run journaled. A failure goes back to the model to fix (CORRECTIONS times);
// after that, salvage keeps what is sound and the move's attempt is spent.
type Cand = { label: string; baseline?: { unusual: boolean; toolCallIds: string[] } };
// No "recon": it names resources too ("recon job"), and refusing on it lost a correct finding.
export const ACCUSE = /\b(attacker|attacker's|malicious|adversary|threat actor|stolen|compromised|hijacked|backdoor|exfiltrat\w*|intruder|rogue|abus\w*|tamper\w*)\b/i;

const LISTS = ["candidates", "effects", "causes", "events"] as const;
// Attribution: saying an account or credential was taken over (stolen, compromised, controlled by someone
// else, the attacker using or operating it) needs the record of the takeover itself. Runs have blamed a
// legitimate person this way, from a missing login record or from sharing their address.
export const TAKEOVER = /\b(stolen|compromised|hijack\w*|taken over|took over|account takeover|controlled by (?:the )?(?:attacker|adversary|an? (?:external|unknown) (?:operator|attacker))|(?:attacker|adversary|intruder|operator)(?:'s)? (?:us(?:ing|ed)|operat(?:ing|ed)|controll(?:ing|ed)|with|holding|via)\b|(?:attacker|adversary)-(?:controlled|operated))/i;
const ABSENCE = /\b(no|not|never|without|absen\w*|missing|lack\w*)\b[^.]{0,60}\b(record|log|login|logon|sign-?in|assume-?role|federation|token|event|found|seen|recorded)/i;
const takeoverProblem = (c: { label: string; takeover?: { summary: string; toolCallIds: string[] } }) =>
  !TAKEOVER.test(c.label) ? null
  : !c.takeover?.toolCallIds.length ? `"${c.label.slice(0, 80)}": the label says an account or credential was taken over (stolen, compromised, controlled or used by the attacker) but gives no takeover record. Either cite the record of the takeover itself under takeover (a sign-in from a new address or device, a token, key or password created or reset, an MFA change, a credential read from a host or file, malicious code running in that account's session (the process record)), or relabel it neutrally: what happened, run as which account, from which address. A missing login or assume-role record is not a takeover record, and sharing an address or role with the attacker is not one either.`
  : ABSENCE.test(c.takeover.summary) ? `"${c.label.slice(0, 80)}": the takeover record must be a record that exists; "${c.takeover.summary.slice(0, 100)}" describes a missing one. Relabel it neutrally (what happened, run as which account, from which address) unless a search returns the takeover itself.`
  : null;
const STORY_TAKEOVER = /\b(insider|rogue (?:employee|admin|developer|user))\b/i;
const TAKEOVER_TEST = /\b(sign-?in|login|logon|token|key|password|mfa|credential|session (?:creat|issu)|assume-?role|federat)/i;
export const UNSEEN = /\b(outside (?:the )?(?:captured |available |collected )?(?:telemetry|logs?|logging|data|visibility)|(?:not|never|un) ?(?:captured|logged|recorded|observed|visible) (?:in|by) (?:the )?(?:telemetry|logs?|data|any source)|unlogged|unobserved|out[- ]of[- ]band (?:mint|issu)\w*|no visible (?:mint|issu|origin|source)\w*)\b/i;
export interface CheckCtx { inputOf?: InputOf; range?: [string, string] }
type Path = (string | number)[];
// drop: the top-level list items a failure rests on (["effects", 0]), so a last salvage can keep the rest of the submission.
export type CheckResult = { success: true; data: unknown } | { success: false; msg: string; drop: Path[] };

type Citable = Parameters<typeof issued>[0];
export function check(name: SubmitName, input: unknown, calls: number | Citable, cx: CheckCtx = {}): CheckResult {
  const tools = typeof calls === "number" ? { callCount: calls } : calls;
  const v = { data: clip(input) };
  // A ref the run never issued, anywhere in the submission, fails it whole: nothing is dropped, so salvage keeps
  // nothing, as the reference.
  const unissued = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(unissued) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, y]) => (k === "toolCallIds" && Array.isArray(y) ? y.map(String).filter((id) => !issued(tools, id)) : unissued(y))) : [];
  const ids = new Set(unissued(v.data));
  if (ids.size) return { success: false, msg: `toolCallIds never issued in this run: ${[...ids].join(", ")}. Cite only refs from your searches or from the snapshot.`, drop: [] };
  // The environment map records what exists and how often, never a judgment about it.
  if (name === "submit_environment") {
    const m = String((v.data as { map?: string }).map ?? "").match(/\b(suspicious|malicious|anomal\w*|outliers?|unusual|attack\w*|attacker|c2|command[- ]and[- ]control|phish\w*|not normal|abnormal|compromise\w*|exfiltrat\w*|backdoor\w*|indicator\w*)\b/gi);
    if (m) return { success: false, drop: [], msg: `the map judges activity (${[...new Set(m.map((x) => x.toLowerCase()))].join(", ")}). It records only what exists and how often ("seen N times on M hosts"). Remove those judgments and anything seen only a few times, and submit again.` };
  }
  // Any event labelled as the attacker's (or malicious, stolen, compromised) must carry a baseline showing it is
  // not that account's or address's normal activity, whichever move proposes it. Otherwise: fix it once.
  const d = v.data as unknown as Partial<Record<(typeof LISTS)[number], Cand[]>>;
  const items = LISTS.flatMap((k) => (d[k] ?? []).map((c, i) => ({ c, at: [k, i] as [string, number] })));
  const taken = items.map((x) => ({ ...x, why: takeoverProblem(x.c as never) })).filter((x) => x.why);
  if (taken.length) return { success: false, drop: taken.map((x) => x.at), msg: taken.map((x) => x.why).join(" ") };
  // A story may suppose a takeover or an insider, but then one of its predictions must look for the takeover record.
  if (name === "submit_theories") {
    const ts = (v.data as { theories: { id: string; story: string; predictions: { expect: string; spl: string }[] }[] }).theories;
    const bad = ts.filter((t) => (TAKEOVER.test(t.story) || STORY_TAKEOVER.test(t.story)) && !t.predictions.some((p) => TAKEOVER_TEST.test(`${p.expect} ${p.spl}`)));
    if (bad.length) return { success: false, drop: [], msg: `${bad.map((t) => t.id).join(", ")}: the story says an account was taken over or that a person is the attacker, but no prediction looks for the record of that takeover. Add a prediction that would find it (the sign-in from a new address or device, the token, key or password created, the credential read), or tell the story without naming whose account was taken.` };
  }
  const accusing = items.filter(({ c }) => ACCUSE.test(c.label) && !(c.baseline?.unusual && c.baseline.toolCallIds.length));
  // An accusing label without a baseline, or a baseline that fails the checks, is kept and tagged unverified
  // (the report never accuses from it; a failed baseline proves nothing either way, so it is dropped).
  for (const { c } of accusing) (c as Cand & { unverified?: boolean }).unverified = true;
  for (const { c } of items) if (baselineProblem(c as never, cx.inputOf, cx.range)) { (c as Cand & { unverified?: boolean }).unverified = true; delete c.baseline; }
  // An event is a record the searches returned. "Happened outside the logs" is not one: it ends the chain on an
  // absence and stops the search for the real step ("credential minted outside captured
  // telemetry" was once confirmed and became the chain top; the token theft upstream was never looked for).
  const unseen = items.filter(({ c }) => UNSEEN.test(c.label));
  if (unseen.length) return { success: false, drop: unseen.map((x) => x.at), msg: `${unseen.map(({ c }) => `"${c.label.slice(0, 80)}"`).join("; ")}: an event must be a record your searches returned, not something inferred from records that are missing. Leave it out and report the records that do exist: earlier records naming the same credential, key, token, session, file, host or pod (where it was read, written, copied or used first). If nothing in the data shows the cause, report no candidate for it (or a boundary to the source that would record it).` };
  return { success: true, data: v.data };
}


// v without the list items at the paths in gone ("effects/0"); the rest keep their place.
const prune = (v: unknown, at: string[], gone: Set<string>): unknown =>
  Array.isArray(v) ? v.flatMap((x, j) => (gone.has([...at, j].join("/")) ? [] : [prune(x, [...at, String(j)], gone)]))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x, [...at, k], gone)])) : v;

// A submission without the keys its schema has no field for, at every depth, as the reference's zod (a plain
// object, not strict) parses it: such a key is dropped, never an error, and never sent back to fix. A value of the
// wrong type is left as it is, for the schema to refuse. `stripped` names each dropped key by its dotted path.
type Shape = { type?: unknown; properties?: Record<string, Shape>; items?: Shape; additionalProperties?: unknown };
export function stripUnknown(schema: Record<string, unknown>, value: unknown): { value: unknown; stripped: string[] } {
  const stripped: string[] = [];
  const walk = (s: Shape, v: unknown, at: string[]): unknown => {
    if (Array.isArray(v)) return s.type === "array" && s.items ? v.map((x, i) => walk(s.items!, x, [...at, String(i)])) : v;
    if (!v || typeof v !== "object" || s.type !== "object" || !s.properties) return v;
    const known = s.properties;
    return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
      if (Object.hasOwn(known, k)) return [[k, walk(known[k]!, x, [...at, k])]];
      if (s.additionalProperties !== false) return [[k, x]];
      stripped.push([...at, k].join("."));
      return [];
    }));
  };
  return { value: walk(schema as Shape, value, []), stripped };
}

// A failed check drops the top-level items it rests on (a whole candidate, effect, cause or event) and keeps the
// rest, so one bad event does not throw away the others; up to three passes. A failure that names no item (a ref
// never issued, a bad field of the submission itself) salvages nothing. A key the schema has no field for is
// dropped first, as the reference's parse drops it, and is never what an item is dropped for.
export function salvage(name: SubmitName, input: unknown, calls: number | Citable, cx: CheckCtx, first: CheckResult): { data: unknown; dropped: number } | null {
  const { value, stripped } = stripUnknown(SUBMIT[name], clip(input));
  let cur = value as Record<string, unknown[]>, r = first, dropped = 0;
  if (stripped.length) { const bad = schemaProblem(name, cur); r = bad ? { success: false, ...bad } : check(name, cur, calls, cx); }
  for (let i = 0; i < 3 && !r.success; i++) {
    if (!r.drop.length) return null;
    const gone = new Set(r.drop.map((p) => p.join("/")));
    cur = prune(cur, [], gone) as typeof cur;
    dropped += gone.size;
    const bad = schemaProblem(name, cur); // dropping can leave a list under its minimum
    r = bad ? { success: false, ...bad } : check(name, cur, calls, cx);
  }
  return r.success ? { data: r.data, dropped } : null;
}

// What a recorded turn looks like: replayable by ScriptedModelClient against a cassette. Tool call ids in
// the submission are written as $0, $1 ... (the index of the call in this turn).
export interface ScriptEntry { move: TurnMove; correlationId: string; toolCalls: { tool: string; input: unknown }[]; submission: unknown }

const mapIds = (v: unknown, f: (s: string) => string): unknown =>
  typeof v === "string" ? f(v) : Array.isArray(v) ? v.map((x) => mapIds(x, f)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapIds(x, f)])) : v;


// What a move touches of the kernel: the run's harness and options as `runAgent` would hold them, with the evidence
// tool granted as a local tool the model's searches go through. Frame and moves alike run as subturns here.
export class KernelTurns {
  // The tools hooks grant: set once the run has a source to search.
  local: readonly RegisteredTool[] = [];
  private ctx: PluginContext;
  // The model round the subturn in hand is on: a search can tell which response asked for it.
  round: () => number = () => 0;
  constructor(harness: Harness<AgentKinds>, run: { run_id: string; run_kind: RunKind; spec: RunSpec; plugin: PluginManifest; tools: readonly RegisteredTool[]; started_by?: string; signal?: AbortSignal }) {
    const hooks: PluginHooks = { tools: (c) => { this.round = c.turn; return this.local; } };
    const options: AgentOptions = { ...run, hooks };
    // No outer model loop here: runSubturn hands hooks its own turn counter.
    this.ctx = { harness, options, turn: () => 0 };
  }
  turn<T>(sub: Subturn): Promise<Outcome<T>> { return runSubturn<T>(this.ctx, sub); }
  // The run's model, as its spend is journaled: what a move without a model of its own runs on.
  get model(): string { return this.ctx.harness.provider.model; }
  async calls(): Promise<CallPayload[]> {
    return (await this.ctx.harness.state.read(this.ctx.options.run_id)).filter((e) => e.kind === "call").map((e) => e.payload as CallPayload);
  }
}

// The JSON the kernel holds an emission to. Lengths are not asked of it: an over-long note is trimmed by the
// check, and must not cost the whole submission.
const wire = (name: SubmitName): Record<string, unknown> => {
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "maxLength").map(([k, y]) => [k, strip(y)])) : x;
  return { description: SUBMIT_DESCRIPTIONS[name], ...(strip(SUBMIT[name]) as Record<string, unknown>) };
};

const argsOf = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return {}; } };

// How many times an answer that fails its check or its schema goes back to the model before it is salvaged: every move's.
export const CORRECTIONS = 2;

export class KernelModelClient implements ModelClient {
  private system: string[];
  private cur: TurnRequest | undefined;
  // What the evidence tool answered this move, in order: the raw output the kernel's own result text is cut from.
  private answered: { key: string; ok: boolean; output: string }[] = [];
  // The searches this move has run, and how many of them the model's current response asked for.
  private searched = 0;
  private batch = { round: -1, n: 0 };
  // The move's calls the registry has noted so far, in ledger order, and how many of `answered` they matched.
  private seen: { call: CallPayload; input: unknown; text: string }[] = [];
  private matched = 0;

  constructor(private d: ClientDeps & { tools: Registry }, private turns: KernelTurns) {
    this.system = [SYSTEM_PROMPT, d.survey];
    turns.local = d.tools.list().map((t) => this.localTool(t));
  }

  addContext(text: string) {
    this.system.push(text);
  }

  // The evidence tool as the kernel holds it: its handler is the registry's run, scoped to the move in hand.
  private localTool(t: EvidenceTool): RegisteredTool {
    const { cfg, domains, range } = this.d;
    return defineTool(
      {
        id: t.name,
        description: t.description,
        parameters: t.inputSchema,
        execute: async (args): Promise<ToolResult> => {
          const req = this.cur;
          if (req === undefined) return { ok: false, failure: { kind: "refused", detail: "no move is running" } };
          const cap = req.maxSearches ?? cfg.maxToolCallsPerTurn;
          if (this.searched >= cap) return { ok: false, failure: { kind: "refused", detail: `Not run: no searches left this turn. Submit now with ${SUBMIT_TOOL}.` } };
          const round = this.turns.round();
          if (this.batch.round !== round) this.batch = { round, n: 0 };
          if (req.maxPerBatch && this.batch.n >= req.maxPerBatch) return { ok: false, failure: { kind: "refused", detail: `Not run: at most ${req.maxPerBatch} searches per batch. Read these results first, then send the next batch (fix any search that returned nothing).` } };
          this.batch.n++;
          this.searched++;
          const last = this.searched >= cap ? `\nNo searches left this turn. Submit now with ${SUBMIT_TOOL}.` : "";
          const r = await this.d.tools.run(t.name, args, { allowedDomains: req.allowedDomains, allDomains: domains, timeoutMs: cfg.toolTimeoutMs, range, focusTime: req.focusTime, beforeMs: req.beforeMs, minCount: req.minCount });
          this.answered.push({ key: JSON.stringify(args), ok: r.ok, output: r.ok ? r.data ?? "" : r.error ?? "" });
          if (!r.ok) {
            const detail = r.error ?? "";
            return { ok: false, failure: /^timed out/.test(detail) ? { kind: "timeout", timeoutMs: cfg.toolTimeoutMs } : /^bad input/.test(detail) ? { kind: "invalid_args", detail: detail + last } : { kind: "backend_error", detail: detail + last } };
          }
          const max = cfg.rawOutputMaxChars;
          const data = r.data ?? "";
          return { ok: true, rows: [{ output: (data.length > max ? `${data.slice(0, max)}\n…[cut at ${max} chars: aggregate or narrow the search]` : data) + last }], rowCount: 1, capped: false, sourceSystem: t.name };
        },
      },
      { maxRows: 1, timeoutMs: cfg.toolTimeoutMs + 60_000 },
      true,
    );
  }

  // A refusal (the safety filter misfiring on attack narrative built up in the snapshot) is retried: once without
  // the STORIES section, then once on the fallback model. Searches already run in a refused attempt stay citable
  // (they are on the ledger) but the retry runs its own.
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { cfg } = this.d;
    const first = await this.runTurnOnce(req);
    if (!first.refused) return first;
    req.trace.write("refusal", { attempt: 1, model: req.model ?? this.turns.model, retry: "without STORIES" });
    const lean = { ...req, userContent: req.userContent.replace(STORIES, "") };
    const second = await this.runTurnOnce(lean);
    if (!second.refused) return second;
    req.trace.write("refusal", { attempt: 2, model: lean.model ?? this.turns.model, retry: `fallback model ${cfg.refusalFallbackModel}` });
    const third = await this.runTurnOnce({ ...req, model: cfg.refusalFallbackModel });
    if (third.refused) {
      req.trace.write("refusal", { attempt: 3, gaveUp: true });
      return { submission: null, toolCalls: [] };
    }
    return third;
  }

  private async runTurnOnce(req: TurnRequest): Promise<TurnResult & { refused?: true }> {
    const { cfg, tools } = this.d;
    const searches = req.maxSearches ?? cfg.maxToolCallsPerTurn;
    const before = (await this.turns.calls()).length;
    this.cur = req;
    this.answered = [];
    this.searched = 0;
    this.batch = { round: -1, n: 0 };
    this.seen = [];
    this.matched = 0;
    const cx: CheckCtx = { inputOf: tools.inputOf?.bind(tools), range: this.d.range };
    // Keys the answers' schema has no field for, dropped before the kernel held them to it.
    const stripped = new Set<string>();
    let outcome: Outcome<unknown> | undefined;
    let failure: unknown;
    try {
      outcome = await this.turns.turn({
        role: req.move,
        system: this.system.join("\n\n"),
        task: req.userContent,
        schema: wire(req.submitTool),
        tools: searches > 0 ? this.turns.local.map((t) => t.id) : [],
        // The cap is on searches, which the evidence tool counts and refuses past it. Rounds are only bounded: one
        // per search at most, and the answer's. A move with no searches still opens on a round free to think, as
        // the reference's does.
        max_turns: Math.max(searches, 1) + 1,
        // As the reference: once the move's searches are spent, every round after is forced to the submit, without
        // thinking, its corrections included. The first round is never forced, so a move with no searches thinks once.
        answer_now: () => this.searched >= searches,
        cite: true,
        // Held to the move's check over what the move has searched so far; a failed answer is answered with what
        // is wrong and the model goes again. An answer kept to the end is checked once more below.
        check: async (answer) => {
          await this.sync(before);
          const v = check(req.submitTool, answer, tools, cx);
          return v.success ? null : v.msg;
        },
        corrections: CORRECTIONS,
        // As the reference's zod parses a submission: a key its schema has no field for is dropped, not sent back.
        prepare: (answer) => {
          const s = stripUnknown(SUBMIT[req.submitTool], answer);
          for (const at of s.stripped) stripped.add(at);
          return s.value;
        },
        // As the reference asks Claude: the conversation cached to its last message every round, and
        // adaptive thinking on every round that is not forced to the submit.
        cache_conversation: true,
        think: true,
        ...(req.model === undefined ? {} : { model: req.model }),
      });
    } catch (error) {
      failure = error;
    } finally {
      this.cur = undefined;
    }
    // Whatever the move searched is on the ledger and citable, however it ended.
    const toolCalls = await this.settle(req, before);
    if (failure !== undefined) throw failure;
    if (outcome!.refusal !== null) throw new Refused(outcome!.reason);
    if (outcome!.model_refused === true) return { submission: null, toolCalls, refused: true };

    // The answer the turn ended on is checked: what is sound is kept, what is not is dropped, and a turn with no
    // valid submission is one attempt on its target. One the check still failed after the corrections, and an
    // emission the kernel rejected twice, are salvaged when they parsed: what in them is sound is kept.
    let submission: unknown = null;
    const dropped = stripped.size ? { stripped: [...stripped] } : {};
    // A provider failure is not an answer the model got wrong: it is told apart on the ledger and in the result.
    const failed = outcome!.status === "failed" && outcome!.emission_rejected !== true ? outcome!.reason : undefined;
    const kept = outcome!.value ?? outcome!.rejected_value;
    if (failed !== undefined) req.trace.write("provider-failure", { reason: failed });
    else if (kept === undefined || kept === null || typeof kept !== "object") req.trace.write("rejected-submission", { reason: outcome!.reason, ...dropped });
    else {
      const bad = outcome!.value === null ? schemaProblem(req.submitTool, clip(kept)) : null;
      const v: CheckResult = bad ? { success: false, ...bad } : check(req.submitTool, kept, tools, cx);
      if (v.success) submission = v.data;
      else {
        const s = salvage(req.submitTool, kept, tools, cx, v);
        req.trace.write("rejected-submission", { input: kept, error: v.msg, ...(s ? { salvaged: `kept the rest, dropped ${s.dropped} item(s)` } : {}), ...dropped });
        submission = s?.data ?? null;
      }
    }
    finishTurn(req, submission, dropped);
    return { submission, toolCalls, ...(failed !== undefined ? { failed } : {}) };
  }

  // The move's calls on the ledger since the last look, noted in the registry: a search citable from here on, one
  // that never ran or a correction numbered but not evidence. The check reads them mid-move, settle after it.
  private async sync(before: number): Promise<void> {
    for (const call of (await this.turns.calls()).slice(before + this.seen.length)) {
      const input = argsOf(call.arguments);
      if (correction(call)) {
        this.d.tools.note(call.ref, input, "", false);
        this.seen.push({ call, input, text: call.result });
        continue;
      }
      // The kernel journals a search refused before the tool ran too (by the kernel or past the cap), which the tool
      // never answered.
      const mine = !neverRan(call) && this.answered[this.matched]?.key === JSON.stringify(input) ? this.answered[this.matched++] : undefined;
      this.d.tools.note(call.ref, input, mine?.ok ? mine.output : "", !neverRan(call));
      this.seen.push({ call, input, text: mine?.output ?? call.result });
    }
  }

  // The move's searches as the ledger holds them: citable from here on, and traced for the report. An answer sent
  // back to fix is no search: it is not traced, returned or cited.
  private async settle(req: TurnRequest, before: number): Promise<ToolCallOut[]> {
    await this.sync(before);
    const out: ToolCallOut[] = [];
    for (const { call, input, text } of this.seen) {
      if (correction(call)) continue;
      req.trace.write("query", { toolCallId: call.ref, tool: call.tool, input });
      const traceId = req.trace.write("tool-output", { toolCallId: call.ref, ok: call.ok, output: text });
      out.push({ id: call.ref, tool: call.tool, input, ok: call.ok, traceId, text });
    }
    return out;
  }
}

// Traces the submission, with any keys its schema had no field for that were dropped on the way.
export function finishTurn(req: TurnRequest, submission: unknown, dropped: { stripped?: string[] } = {}) {
  if (submission !== null) req.trace.write("submission", { tool: req.submitTool, submission, ...dropped });
}

// Replays recorded or hand-written turns, matched by (move, correlationId) in order. Tool calls run for real
// through the registry (a cassette backend in tests), so refs and traces match a live run.
export class ScriptedModelClient implements ModelClient {
  private used = new Set<number>();
  constructor(private d: ClientDeps, private script: ScriptEntry[]) {}
  get remaining() { return this.script.length - this.used.size; }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const i = this.script.findIndex((s, j) => !this.used.has(j) && s.move === req.move && s.correlationId === req.correlationId);
    if (i < 0) throw new Error(`scripted model: no entry for (${req.move}, ${req.correlationId})`);
    this.used.add(i);
    const s = this.script[i]!;
    const toolCalls: ToolCallOut[] = [];
    for (const c of s.toolCalls) toolCalls.push(await runTool(this.d, req, c.tool, c.input));
    const raw = mapIds(s.submission, (x) => (/^\$\d+$/.test(x) ? toolCalls[Number(x.slice(1))]?.id ?? x : x));
    if (raw === null) return { submission: null, toolCalls };
    const submission = stripUnknown(SUBMIT[req.submitTool], clip(raw)).value;
    const bad = schemaErrors(SUBMIT[req.submitTool], submission);
    if (bad) { req.trace.write("rejected-submission", { input: raw, error: bad }); return { submission: null, toolCalls }; }
    req.trace.write("submission", { tool: req.submitTool, submission });
    return { submission, toolCalls };
  }
}
