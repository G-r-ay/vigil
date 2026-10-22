// Who the report may name. An account, user, email address, principal or address is named as the attacker, the
// origin or an operator only when the alert's proven chain reaches it: the events the alert reaches over proven
// links. Any other is unlinked: the conclude move's answer goes back once while it names one, and the report, the
// run summary and the console show it as "[unlinked actor]" ("[unlinked address]" for an address), except in a
// sentence that clears it. The same in loose mode and strict.
import { defaultConfig, type AgentConfig } from "./config.js";
import { getChildren, getParents, symptomOf, type Graph, type GraphEdge, type GraphNode, type NodeId } from "./graph.js";
import type { Artifact } from "./types.js";

export const UNLINKED_ACTOR = "[unlinked actor]";
export const UNLINKED_ADDRESS = "[unlinked address]";

// Proven: confirmed, or at the confirm threshold.
const proven = (x: { status: string; confidence: number }, cfg: Pick<AgentConfig, "thresholds">) => x.status === "confirmed" || x.confidence >= cfg.thresholds.confirm;

// The alert's proven chain: the alert, the events upstream of it over proven explains links into proven events, and
// those events' effects over proven links (a branch finding the chain's implant ran). Unverified events are never on it.
export function provenChain(g: Graph, cfg: Pick<AgentConfig, "thresholds"> = defaultConfig): Set<NodeId> {
  const s = symptomOf(g);
  if (!s) return new Set();
  const link = (e: GraphEdge) => !e.retired && e.status !== "ruled-out" && proven(e, cfg);
  const event = (n: GraphNode | undefined): n is GraphNode => !!n && n.kind === "action" && n.status !== "ruled-out" && !n.unverified && proven(n, cfg);
  const reach = new Set<NodeId>([s.id]);
  for (const todo = [s.id]; todo.length; ) for (const e of getParents(g, todo.pop()!)) { const n = g.nodes[e.source]; if (link(e) && event(n) && !reach.has(n.id)) { reach.add(n.id); todo.push(n.id); } }
  for (const todo = [...reach]; todo.length; ) for (const e of getChildren(g, todo.pop()!)) { const n = g.nodes[e.target]; if (link(e) && event(n) && !reach.has(n.id)) { reach.add(n.id); todo.push(n.id); } }
  return reach;
}

const principalArn = (a: Artifact) => a.kind === "arn" && /:(role|user|assumed-role)\//i.test(a.value);
const isWho = (a: Artifact) => a.kind === "user" || a.kind === "email-address" || a.kind === "principal" || a.kind === "ip" || principalArn(a);
const CARRIER = /\.amazonaws\.com$|^aws:service:|\.googleapis\.com$/i;
const IP = /^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
// Words a name may be spelled as that the report also uses for other things ("root cause", "admin workstation").
const COMMON = new Set(["root", "admin", "administrator", "system", "service", "user", "users", "guest", "default", "unknown", "none", "local", "localhost", "nobody", "everyone", "attacker", "operator", "account", "github", "lambda", "role", "assumed-role", "function", "serviceaccount", "aws", "iam", "sts", "k8s", "ad"]);
// An identity value, as opposed to a description ("intruder via the stolen session").
const valueLike = (v: string) => v.length >= 3 && !/\s/.test(v) && !CARRIER.test(v) && !COMMON.has(v);

// The identities an event names: its own account and address artifacts, the accounts it ran as and, at even odds or
// better, who operated it (as the report's accounts count an operator).
function whoOf(g: Graph, n: GraphNode): string[] {
  const out = n.artifacts.filter(isWho).map((a) => a.value);
  const actors = [...getParents(g, n.id, "attributed-to"), ...getParents(g, n.id, "operated-by").filter((e) => e.confidence >= 0.5)].filter((e) => !e.retired && e.status !== "ruled-out");
  for (const e of actors) { const a = g.nodes[e.source]; if (a) out.push(a.label, ...a.artifacts.filter(isWho).map((x) => x.value)); }
  return out;
}

const canon = (v: string) => v.trim().toLowerCase();
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A whole value: not inside a longer name or address (10.0.0.1 is not 10.0.0.12; bob is not bobby).
const whole = (f: string) => new RegExp(`(?<![\\w@.-])${esc(f)}(?![\\w@-]|\\.\\w)`, "gi");
// How a value may be written: whole, or by its last segment (bob for ad:CORP\bob or arn:...:user/bob), 4+ chars.
function forms(v: string): string[] {
  const c = canon(v);
  if (IP.test(c)) return [c];
  const short = c.split(/[/:\\]/).filter(Boolean).at(-1) ?? c;
  return [...new Set([c, ...(short.length >= 4 && valueLike(short) ? [short] : [])])];
}

// A sentence that clears who it names (the old loop's rule): they keep their name there. "Suspected" or "unverified"
// still points at them.
export const CLEARS = /\b(legitimate|benign|ruled[- ]out|exonerated|not (?:the |an? )?(?:attacker|malicious|involved|operator)|normal (?:work|activity|operations)|expected activity)\b/i;
// Sentences and clauses, with what separates them kept so the text joins back unchanged.
const SPLIT = /((?<=[.!?;])\s+|\n)/;

export interface Unlinked {
  // Every unreached identity the text names outside a clearing sentence, replaced.
  text(s: string): string;
  // The unreached identities the text names outside a clearing sentence, as the graph holds them.
  named(s: string): string[];
  unreached(v: string): boolean;
  // An unreached identity left out where it would be listed (an indicator): it counts as redacted.
  drop(v: string): void;
  // Distinct identities replaced or left out so far.
  readonly count: number;
}

export function unlinked(g: Graph, cfg: Pick<AgentConfig, "thresholds"> = defaultConfig): Unlinked {
  const chain = provenChain(g, cfg);
  const reached = new Set<string>();
  for (const id of chain) for (const v of whoOf(g, g.nodes[id]!)) reached.add(canon(v));
  const all = new Set<string>();
  for (const n of Object.values(g.nodes)) {
    if (n.kind === "action") whoOf(g, n).forEach((v) => all.add(canon(v)));
    if (n.kind === "actor") [n.label, ...n.artifacts.filter(isWho).map((a) => a.value)].forEach((v) => all.add(canon(v)));
  }
  // A form stays when a reached identity is written with it (bob, when ad:bob is on the chain and arn:...:user/bob is not).
  const reachedText = [...reached].join("\n");
  const byForm = new Map<string, string>(); // form -> the identity it names
  for (const v of all) {
    if (reached.has(v) || !valueLike(v)) continue;
    for (const f of forms(v)) if (!whole(f).test(reachedText) && !byForm.has(f)) byForm.set(f, v);
  }
  const order = [...byForm.keys()].sort((a, b) => b.length - a.length);
  const hits = new Set<string>();
  const scan = (s: string, replace: boolean) => {
    const found = new Set<string>();
    const out = s.split(SPLIT).map((part, i) => {
      if (i % 2 === 1 || CLEARS.test(part)) return part;
      let t = part;
      for (const f of order) t = t.replace(whole(f), () => { found.add(byForm.get(f)!); return IP.test(f) ? UNLINKED_ADDRESS : UNLINKED_ACTOR; });
      return replace ? t : part;
    }).join("");
    return { out, found };
  };
  return {
    text(s) {
      if (!order.length || !s) return s;
      const r = scan(s, true);
      r.found.forEach((v) => hits.add(v));
      return r.out;
    },
    named: (s) => (order.length && s ? [...scan(s, false).found] : []),
    unreached: (v) => byForm.get(canon(v)) !== undefined,
    drop(v) { const id = byForm.get(canon(v)); if (id) hits.add(id); },
    get count() { return hits.size; },
  };
}

// What the conclude move is sent back with once, while its answer names someone the proven chain does not reach.
export function unlinkedCorrection(names: string[]): string {
  return `the conclusion names ${names.map((n) => `"${n}"`).join(", ")}, which the alert's proven chain does not reach (no confirmed link joins them to the alert). Name someone as the attacker, the origin or an operator only through proven links; otherwise say they are unverified or leave them out. Facts you observed (destinations, hosts, files) can stay, marked as not linked. Submit the conclusion again.`;
}

// The names the conclude answer gives that the proven chain does not reach: in its text, and in the labels of the
// events it names as the root cause and the chain.
export function concludeNames(g: Graph, answer: { conclusion?: string; rootCause?: string; chain?: string[] }, cfg: Pick<AgentConfig, "thresholds"> = defaultConfig): string[] {
  const u = unlinked(g, cfg);
  const labels = [...new Set([...(answer.rootCause ? [answer.rootCause] : []), ...(answer.chain ?? [])])].map((id) => g.nodes[id]).filter((n) => n && !n.legitimate).map((n) => n!.label);
  return [...new Set([answer.conclusion ?? "", ...labels].flatMap((s) => u.named(s)))];
}
