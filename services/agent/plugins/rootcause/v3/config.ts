export interface AgentConfig {
  maxUsd: number;
  maxToolCallsPerTurn: number;
  strengthenSearches: number;
  maxTheorize: number;
  rareSweep: boolean;
  rawOutputMaxChars: number;
  toolTimeoutMs: number;
  maxStrengthenAttempts: number;
  maxExpandAttempts: number;
  stallDelta: number;
  maxForksPerNode: number;
  maxForwardSteps: number;
  lookbackDays: number;
  stitchWindowMinutes: number;
  linkNeedsSharedValue: boolean;
  // The loop's behaviour switches, each on as the reference run had it; off is the reference loop's other path.
  roleArnHandOff: boolean; // role ARNs join different accounts only as a hand-off
  inheritLegit: boolean; // a step causing its own account's legitimate step is legitimate
  lead: boolean; // the model names each next move (lead.ts); off: the frontier's priority ladder picks every move
  loose: boolean; // record freely: findings that fail a check are tagged (unverified / inferred link), not refused; the report is strict
  theorizeEvery: number; // lead off: turns of other moves between rounds of stories, once a round's tests are done
  branchEvery: number; // lead off: once the stories run, a branch from a chain event at least this often
  wrapUpAt: number; // share of maxUsd left when the model is told to wrap up
  concludeAt: number; // share left when the run stops for the closing conclude turn
  thresholds: { confirm: number; settled: number; ruleOut: number; expandMin: number; altPathMin: number; competitorMax: number };
  weights: { direct: number; corroborating: number; circumstantial: number };
  priorRange: [number, number];
}

export const defaultConfig: AgentConfig = {
  maxUsd: 7, // the engine sets the run's own ceiling from its spec
  maxToolCallsPerTurn: 6,
  strengthenSearches: 3, // a check needs a record or two; 6 let strengthen take a third of all searches
  rareSweep: true, // rare-activity sweep at the start of a run (rare.ts)
  maxTheorize: 8, // rounds of competing stories per run (4 ran out by mid-run with the key question open)
  rawOutputMaxChars: 20_000, // v1 found 8k too small for 50 rows
  toolTimeoutMs: 90_000, // big sources (millions of events) need it; a slow search returns partial results
  maxStrengthenAttempts: 3,
  maxExpandAttempts: 2,
  stallDelta: 0.05,
  maxForksPerNode: 3,
  maxForwardSteps: 3, // entry + 2 forward steps (a 5-step pivot walked a developer's routine CI)
  lookbackDays: 14,
  stitchWindowMinutes: 30,
  linkNeedsSharedValue: true, // a new cause/effect link needs a value both events carry
  roleArnHandOff: true,
  inheritLegit: true,
  lead: true,
  loose: true,
  theorizeEvery: 4,
  branchEvery: 6,
  wrapUpAt: 0.10,
  concludeAt: 0.03, // at least $0.50: one conclude turn costs about that
  thresholds: { confirm: 0.85, settled: 0.95, ruleOut: 0.1, expandMin: 0.6, altPathMin: 0.3, competitorMax: 0.15 },
  weights: { direct: 2.0, corroborating: 1.0, circumstantial: 0.4 },
  priorRange: [0.1, 0.5],
};
