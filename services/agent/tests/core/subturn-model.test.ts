// A subturn on a model of its own: every call in it is asked of that model through the run's
// gateway, and priced and journaled as that model. A subturn that names none is what it was.
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { SpendPayload } from "../../contracts/budget.js";
import type { FramePayload } from "../../contracts/events.js";
import { defineTool, type RegisteredTool } from "../../contracts/tool.js";
import { runSubturn, type AgentOptions, type PluginContext, type Subturn } from "../../core/agent.js";
import { budgetOf, FRESH, unmeteredQuota } from "../../core/budget.js";
import { localDispatch } from "../../core/dispatch.js";
import { Limiter } from "../../core/limiter.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import { costOf, type Prices, type Rates } from "../../core/prices.js";
import type { Provider } from "../../core/provider.js";
import { registryOf } from "../../core/registry.js";
import { InProcessState } from "../../core/state.js";
import { SUBMIT_TOOL } from "../../core/stream.js";
import { openAiSurface } from "../../core/wire.js";
import { harnessFor } from "../../harness.js";
import { huntSpecFor } from "../support/hunt.js";
import { scriptedProvider } from "../support/scripted-provider.js";

type Body = OpenAI.Chat.ChatCompletionCreateParams;
type Chunk = OpenAI.Chat.ChatCompletionChunk;

const RUN = "5a2c2d3e-0000-4000-8000-000000000612";
const SPEC_MODEL = "gemini-2.5-pro";
const STEP_MODEL = "claude-sonnet-5";
const SCHEMA = { type: "object", required: ["verb"], properties: { verb: { type: "string", enum: ["TALLY", "HALT"] } } };
const BUMP: RegisteredTool = defineTool(
  { id: "bump", description: "bump", parameters: {}, execute: async () => ({ ok: true, rows: [{ n: 1 }], rowCount: 1, capped: false, sourceSystem: "test" }) },
  { maxRows: 10, timeoutMs: 500 },
  true,
);

const rates = (input: number, output: number): Rates => ({
  input,
  output,
  cache_read: input / 10,
  cache_write: input * 1.25,
  source: "exact",
  fetched_at: "2026-10-01T00:00:00.000Z",
});
const PRICED: Record<string, Rates> = { [SPEC_MODEL]: rates(1.25e-6, 10e-6), [STEP_MODEL]: rates(3e-6, 15e-6) };
const USAGE = { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 };
const TOKENS = { input: 1_000, output: 200, cache_read: 0, cache_write: 0 };

// A gateway that answers each call with the next tool call, streamed as Bifrost streams it,
// and keeps every body it was sent.
function gateway(calls: readonly { tool: string; args: string }[]) {
  const bodies: Body[] = [];
  let step = 0;
  const create = async (body: Body): Promise<AsyncIterable<Chunk>> => {
    bodies.push(structuredClone(body));
    const call = calls[step++];
    if (call === undefined) throw new Error(`the gateway ran out at call ${step}`);
    const chunk = (fields: Record<string, unknown>) => ({ id: "c", created: 1, model: body.model, object: "chat.completion.chunk", ...fields }) as unknown as Chunk;
    const chunks = [
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", id: `call-${step}`, function: { name: call.tool, arguments: call.args } }] }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      chunk({ choices: [], usage: USAGE }),
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
  };
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, bodies };
}

const ROUNDS = [
  { tool: "bump", args: "{}" },
  { tool: SUBMIT_TOOL, args: JSON.stringify({ verb: "HALT" }) },
];

// The harness as harnessFor builds it, over a gateway the test holds: one surface per model,
// the provider namespaced on the wire and bare for pricing.
function contextOf(opts: { specModel?: string; prices?: Prices; resolves?: boolean } = {}) {
  const { client, bodies } = gateway(ROUNDS);
  const limiter = new Limiter({ rpm: 10_000, tpm: 10_000_000 }, 4, 1);
  const resolved: string[] = [];
  const surfaceFor = (model: string): Provider => openAiSurface(client, model, limiter, "vertex", `vertex/${model}`);
  const state = new InProcessState();
  const priced: [string, string][] = [];
  const prices: Prices = opts.prices ?? (async (model) => PRICED[model] ?? null);
  const harness = {
    provider: surfaceFor(opts.specModel ?? SPEC_MODEL),
    ...(opts.resolves === false
      ? {}
      : {
          provider_for: (model: string) => {
            resolved.push(model);
            return surfaceFor(model);
          },
        }),
    registry: registryOf([], {}),
    dispatch: localDispatch,
    budget: budgetOf(
      { max_calls: 20, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 },
      unmeteredQuota,
      Date.now,
      FRESH,
      async (model, provider) => {
        priced.push([model, provider]);
        return prices(model, provider);
      },
    ),
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
  return { state, ctx, bodies, resolved, priced };
}

const step = (over: Partial<Subturn> = {}): Subturn => ({ role: "scope", system: "map the estate", task: "count to one", schema: SCHEMA, tools: ["bump"], max_turns: 3, ...over });

const payloads = async (state: InProcessState, kind: string) =>
  (await state.read(RUN)).filter((one) => one.kind === kind).map((one) => one.payload);

// What two runs of one script can differ in besides what they were asked: the clock.
const clockless = (value: unknown) => JSON.parse(JSON.stringify(value, (key, one) => (key === "duration_ms" ? undefined : one)));
const timeless = (events: readonly { kind: string; payload: unknown }[]) => clockless(events.map((one) => ({ kind: one.kind, payload: one.payload })));

describe("a subturn on its own model", () => {
  it("asks every call of that model, through the spec's provider", async () => {
    const { ctx, bodies, resolved } = contextOf();
    const outcome = await runSubturn<{ verb: string }>(ctx, step({ model: STEP_MODEL }));

    expect(outcome.value).toEqual({ verb: "HALT" });
    expect(resolved).toEqual([STEP_MODEL]);
    expect(bodies.map((body) => body.model)).toEqual([`vertex/${STEP_MODEL}`, `vertex/${STEP_MODEL}`]);
  });

  it("is sent what that model takes, not what the spec's does: a Claude's cache marker", async () => {
    const plain = contextOf();
    await runSubturn(plain.ctx, step());
    const own = contextOf();
    await runSubturn(own.ctx, step({ model: STEP_MODEL }));

    const system = (body: Body) => body.messages.find((message) => message.role === "system")?.content;
    expect(typeof system(plain.bodies[0]!)).toBe("string");
    expect(system(own.bodies[0]!)).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
  });

  it("journals each call's spend as that model, at its rates, and its frames under it", async () => {
    const { state, ctx, priced } = contextOf();
    await runSubturn(ctx, step({ model: STEP_MODEL }));

    const spends = (await payloads(state, "spend")) as SpendPayload[];
    expect(spends).toHaveLength(2);
    const rate = PRICED[STEP_MODEL]!;
    for (const spend of spends) {
      expect(spend).toEqual({
        model_id: STEP_MODEL,
        provider_type: "vertex",
        role: "scope",
        tokens: TOKENS,
        cost_usd: costOf(rate, TOKENS),
        pricing_source: "exact",
        rates: { input: rate.input, output: rate.output, cache_read: rate.cache_read, cache_write: rate.cache_write },
        fetched_at: rate.fetched_at,
      });
    }
    expect(priced).toEqual([
      [STEP_MODEL, "vertex"],
      [STEP_MODEL, "vertex"],
    ]);
    const frames = (await payloads(state, "frame")) as FramePayload[];
    expect(frames.map((frame) => [frame.model_id, (frame.sampling as { wire_model?: string }).wire_model])).toEqual([
      [STEP_MODEL, `vertex/${STEP_MODEL}`],
      [STEP_MODEL, `vertex/${STEP_MODEL}`],
    ]);
  });

  it("prices an override nobody prices as the kernel prices any unpriced model", async () => {
    // The spec on the unpriced model, no override: what today journals for it.
    const today = contextOf({ specModel: STEP_MODEL, prices: async (model) => (model === SPEC_MODEL ? PRICED[SPEC_MODEL]! : null) });
    await runSubturn(today.ctx, step());
    const own = contextOf({ prices: async (model) => (model === SPEC_MODEL ? PRICED[SPEC_MODEL]! : null) });
    await runSubturn(own.ctx, step({ model: STEP_MODEL }));

    const spends = (await payloads(own.state, "spend")) as SpendPayload[];
    expect(spends).toEqual(await payloads(today.state, "spend"));
    expect(spends.map((spend) => [spend.model_id, spend.cost_usd, spend.rates, spend.pricing_source])).toEqual([
      [STEP_MODEL, null, null, null],
      [STEP_MODEL, null, null, null],
    ]);

    // The catalog's "unknown" card: named, never stored as zeros.
    const unknown: Prices = async (model) =>
      model === SPEC_MODEL ? PRICED[SPEC_MODEL]! : { input: null, output: null, cache_read: null, cache_write: null, source: "unknown", fetched_at: null };
    const carded = contextOf({ prices: unknown });
    await runSubturn(carded.ctx, step({ model: STEP_MODEL }));
    const cardedToday = contextOf({ specModel: STEP_MODEL, prices: unknown });
    await runSubturn(cardedToday.ctx, step());
    const cardedSpends = (await payloads(carded.state, "spend")) as SpendPayload[];
    expect(cardedSpends).toEqual(await payloads(cardedToday.state, "spend"));
    expect(cardedSpends[0]).toMatchObject({ model_id: STEP_MODEL, cost_usd: null, rates: null, pricing_source: "unknown" });
  });

  it("changes nothing when unset: the same requests, events and outcome as a harness that resolves no model", async () => {
    const before = contextOf({ resolves: false });
    const was = await runSubturn(before.ctx, step());
    const after = contextOf();
    const is = await runSubturn(after.ctx, step());

    expect(after.resolved).toEqual([]);
    expect(clockless(is)).toEqual(clockless(was));
    expect(after.bodies).toEqual(before.bodies);
    expect(after.bodies.map((body) => body.model)).toEqual([`vertex/${SPEC_MODEL}`, `vertex/${SPEC_MODEL}`]);
    expect(timeless(await after.state.read(RUN))).toEqual(timeless(await before.state.read(RUN)));
    const spends = (await payloads(after.state, "spend")) as SpendPayload[];
    expect(spends.map((spend) => [spend.model_id, spend.cost_usd])).toEqual([
      [SPEC_MODEL, costOf(PRICED[SPEC_MODEL]!, TOKENS)],
      [SPEC_MODEL, costOf(PRICED[SPEC_MODEL]!, TOKENS)],
    ]);
  });

  it("refuses a model the harness cannot resolve rather than run it on the spec's", async () => {
    const { ctx, bodies } = contextOf({ resolves: false });
    await expect(runSubturn(ctx, step({ model: STEP_MODEL }))).rejects.toThrow(`the scope step asks for ${STEP_MODEL}, and this harness serves only ${SPEC_MODEL}`);
    expect(bodies).toEqual([]);

    const scripted = { ...ctx, harness: { ...ctx.harness, provider: scriptedProvider([]) } } as PluginContext;
    await expect(runSubturn(scripted, step({ model: STEP_MODEL }))).rejects.toThrow("this harness serves only scripted/model");
  });
});

describe("harnessFor resolves a subturn's model as it resolves the spec's", () => {
  it("names the spec's provider on the wire and prices the bare id under it", () => {
    const harness = harnessFor({ ...huntSpecFor(), model: "claude-opus-4-8", provider: "vertex" }, new InProcessState());
    const own = harness.provider_for!(STEP_MODEL);
    expect([own.model, own.provider_type, own.sampling]).toEqual([STEP_MODEL, "vertex", { ...harness.provider.sampling, wire_model: `vertex/${STEP_MODEL}` }]);
    const same = harness.provider_for!("claude-opus-4-8");
    expect([same.model, same.provider_type, same.sampling]).toEqual([harness.provider.model, harness.provider.provider_type, harness.provider.sampling]);
  });

  it("leaves the id bare and the gateway the provider when the spec names none", () => {
    const harness = harnessFor(huntSpecFor(), new InProcessState());
    const own = harness.provider_for!(STEP_MODEL);
    expect([own.model, own.provider_type, (own.sampling as { wire_model: string }).wire_model]).toEqual([STEP_MODEL, "bifrost", STEP_MODEL]);
  });
});
