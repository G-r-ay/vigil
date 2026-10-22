// A subturn's check: a failed answer goes back to the model as the answer to its submit call, and the
// ledger holds that exchange as a call, so every round's frame still rebuilds from the ledger alone.
import { describe, expect, it } from "vitest";
import type { CallPayload, FramePayload } from "../../contracts/events.js";
import { defineTool, type RegisteredTool } from "../../contracts/tool.js";
import { runSubturn, type AgentOptions, type PluginContext, type Subturn } from "../../core/agent.js";
import { budgetOf, FRESH, unmeteredQuota } from "../../core/budget.js";
import { localDispatch } from "../../core/dispatch.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import { registryOf } from "../../core/registry.js";
import { replayFrames } from "../../core/replay.js";
import { InProcessState } from "../../core/state.js";
import { SUBMIT_TOOL } from "../../core/stream.js";
import { scriptedProvider, type ScriptedTurn } from "../support/scripted-provider.js";

const RUN = "5a2c2d3e-0000-4000-8000-000000000611";
const SCHEMA = { type: "object", required: ["verb"], properties: { verb: { type: "string", enum: ["TALLY", "HALT"] } } };
const BUMP: RegisteredTool = defineTool(
  { id: "bump", description: "bump", parameters: {}, execute: async () => ({ ok: true, rows: [{ n: 1 }], rowCount: 1, capped: false, sourceSystem: "test" }) },
  { maxRows: 10, timeoutMs: 500 },
  true,
);
const submit = (verb: string): ScriptedTurn => ({ calls: [{ tool: SUBMIT_TOOL, args: JSON.stringify({ verb }) }] });
const halts = (answer: unknown) => ((answer as { verb: string }).verb === "HALT" ? null : "the count is not done");

function contextOf(script: readonly ScriptedTurn[]) {
  const state = new InProcessState();
  const harness = {
    provider: scriptedProvider(script),
    registry: registryOf([], {}),
    dispatch: localDispatch,
    budget: budgetOf({ max_calls: 20, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 }, unmeteredQuota, Date.now, FRESH),
    memory: nullMemory,
    state,
  } as unknown as Harness<Record<never, never>>;
  const options = {
    run_id: RUN,
    run_kind: "root_cause",
    spec: { runtime: { max_turns: 8, result_cap: 8_000, recall_limit: 5 }, approvals: [] },
    tools: [BUMP],
  } as unknown as AgentOptions;
  const ctx = { harness, options, turn: () => 0 } as unknown as PluginContext;
  return { state, ctx };
}

const step = (over: Partial<Subturn> = {}): Subturn => ({ role: "counter", system: "count things", task: "count to one", schema: SCHEMA, tools: ["bump"], max_turns: 3, cite: true, ...over });

describe("a subturn's check", () => {
  it("journals the failed submit and its correction as a call, and every frame replays", async () => {
    const { state, ctx } = contextOf([{ calls: [{ tool: "bump", args: "{}" }] }, submit("TALLY"), submit("HALT")]);
    const outcome = await runSubturn<{ verb: string }>(ctx, step({ check: halts, corrections: 2 }));

    expect(outcome.value).toEqual({ verb: "HALT" });
    const events = await state.read(RUN);
    const calls = events.filter((one) => one.kind === "call").map((one) => one.payload as CallPayload);
    expect(calls.map((call) => [call.ref, call.turn, call.tool, call.ok, call.failure])).toEqual([
      ["r1", 1, "bump", true, null],
      ["r2", 2, SUBMIT_TOOL, false, "invalid_args"],
    ]);
    expect(calls[1]!.result).toContain("Invalid submission: the count is not done. Fix it and call submit_answer again.");
    const frames = events.filter((one) => one.kind === "frame").map((one) => (one.payload as FramePayload).transcript);
    expect(frames).toEqual([[], ["r1"], ["r1", "r2"]]);
    const replayed = replayFrames(events);
    expect(replayed.frames.filter((one) => one.mismatch !== null)).toEqual([]);
    expect(replayed.reproduced).toBe(3);
  });

  it("journals nothing new for a step with no check", async () => {
    const script = [{ calls: [{ tool: "bump", args: "{}" }] }, submit("TALLY")];
    const plain = contextOf(script);
    const outcome = await runSubturn<{ verb: string }>(plain.ctx, step());

    expect(outcome.value).toEqual({ verb: "TALLY" });
    const kinds = (await plain.state.read(RUN)).map((one) => one.kind);
    const checked = contextOf(script);
    await runSubturn(checked.ctx, step({ check: () => null, corrections: 2 }));
    expect((await checked.state.read(RUN)).map((one) => one.kind)).toEqual(kinds);
    expect(kinds.filter((kind) => kind === "call")).toHaveLength(1);
  });
});
