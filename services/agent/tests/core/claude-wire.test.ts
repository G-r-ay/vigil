// A turn that opts into Claude's cache and thinking, as root cause's moves do: every call carries
// a second cache breakpoint on its last message, every round free to choose its tool thinks, and
// what it thought goes back with its calls. A forced round never thinks; another model, or a turn
// that does not opt in, is sent what it always was.
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { FramePayload } from "../../contracts/events.js";
import { defineTool, type RegisteredTool } from "../../contracts/tool.js";
import { runSubturn, type AgentOptions, type PluginContext, type Subturn } from "../../core/agent.js";
import { budgetOf, FRESH, unmeteredQuota } from "../../core/budget.js";
import { localDispatch } from "../../core/dispatch.js";
import { Limiter } from "../../core/limiter.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import type { Message, Provider } from "../../core/provider.js";
import { registryOf } from "../../core/registry.js";
import { InProcessState } from "../../core/state.js";
import { inputHash, SUBMIT_TOOL } from "../../core/stream.js";
import { openAiSurface } from "../../core/wire.js";

type Body = OpenAI.Chat.ChatCompletionCreateParams;
type Chunk = OpenAI.Chat.ChatCompletionChunk;

const RUN = "5a2c2d3e-0000-4000-8000-000000000613";
const SCHEMA = { type: "object", required: ["verb"], properties: { verb: { type: "string", enum: ["TALLY", "HALT"] } } };
const BUMP: RegisteredTool = defineTool(
  { id: "bump", description: "bump", parameters: {}, execute: async () => ({ ok: true, rows: [{ n: 1 }], rowCount: 1, capped: false, sourceSystem: "test" }) },
  { maxRows: 10, timeoutMs: 500 },
  true,
);
const USAGE = { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 };

// Two searches, then the forced answer round.
const ROUNDS = [
  { tool: "bump", args: "{}", thought: ["first ", "look"], signature: "sig-1" },
  { tool: "bump", args: "{}", thought: ["second look"], signature: "sig-2" },
  { tool: SUBMIT_TOOL, args: JSON.stringify({ verb: "HALT" }) },
];

// A gateway streaming each round as Bifrost streams Claude's: the thinking a fragment at a time
// under reasoning_details, its signature alone after it, then the call. It keeps every body.
// The thinking comes back whatever was asked, so a turn that did not ask is seen to drop it.
function gateway() {
  const bodies: Body[] = [];
  let step = 0;
  const create = async (body: Body): Promise<AsyncIterable<Chunk>> => {
    bodies.push(structuredClone(body));
    const round = ROUNDS[step++];
    if (round === undefined) throw new Error(`the gateway ran out at call ${step}`);
    const chunk = (fields: Record<string, unknown>) => ({ id: "c", created: 1, model: body.model, object: "chat.completion.chunk", ...fields }) as unknown as Chunk;
    const delta = (d: Record<string, unknown>) => chunk({ choices: [{ index: 0, delta: d, finish_reason: null }] });
    const chunks = [
      ...(round.thought ?? []).map((text) => delta({ reasoning: text, reasoning_details: [{ index: 0, type: "reasoning.text", text }] })),
      ...(round.signature === undefined ? [] : [delta({ reasoning_details: [{ index: 0, type: "reasoning.text", signature: round.signature }] })]),
      delta({ tool_calls: [{ index: 0, type: "function", id: `call-${step}`, function: { name: round.tool, arguments: round.args } }] }),
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

function contextOf(model: string) {
  const { client, bodies } = gateway();
  const limiter = new Limiter({ rpm: 10_000, tpm: 10_000_000 }, 4, 1);
  const surfaceFor = (id: string): Provider => openAiSurface(client, id, limiter, "vertex", `vertex/${id}`);
  const state = new InProcessState();
  const harness = {
    provider: surfaceFor(model),
    provider_for: surfaceFor,
    registry: registryOf([], {}),
    dispatch: localDispatch,
    budget: budgetOf({ max_calls: 20, max_cost_usd: 10, max_wall_ms: 600_000, max_park_ms: 60_000 }, unmeteredQuota, Date.now, FRESH, async () => null),
    memory: nullMemory,
    state,
  } as unknown as Harness<Record<never, never>>;
  const options = {
    run_id: RUN,
    run_kind: "root_cause",
    spec: { runtime: { max_turns: 8, result_cap: 8_000, recall_limit: 5 }, approvals: [] },
    tools: [BUMP],
  } as unknown as AgentOptions;
  return { state, bodies, ctx: { harness, options, turn: () => 0 } as unknown as PluginContext };
}

const step = (over: Partial<Subturn> = {}): Subturn => ({ role: "expand", system: "find the cause", task: "look twice", schema: SCHEMA, tools: ["bump"], max_turns: 3, ...over });
const ON = { cache_conversation: true, think: true };

async function bodiesOf(model: string, over: Partial<Subturn> = {}) {
  const { ctx, bodies, state } = contextOf(model);
  const outcome = await runSubturn<{ verb: string }>(ctx, step(over));
  expect(outcome.value).toEqual({ verb: "HALT" });
  return { bodies, state };
}

// Every content part that carries Anthropic's cache marker, by message index.
const markers = (body: Body) =>
  body.messages.flatMap((message, i) => (Array.isArray(message.content) ? (message.content as { cache_control?: unknown }[]).filter((part) => part.cache_control !== undefined).map(() => i) : []));

const thoughtsSent = (body: Body) =>
  body.messages.filter((message) => message.role === "assistant").map((message) => (message as { reasoning_details?: unknown }).reasoning_details);

describe("a Claude turn that caches its conversation and thinks", () => {
  it("thinks on every round free to choose, and never on the round forced to the answer", async () => {
    const { bodies } = await bodiesOf("claude-opus-4-8", ON);
    expect(bodies).toHaveLength(3);
    for (const open of bodies.slice(0, 2)) {
      expect(open).toMatchObject({ reasoning: { max_tokens: 1024, display: "summarized" } });
      expect(open.tool_choice).toBeUndefined();
    }
    expect(bodies[2]!.tool_choice).toEqual({ type: "function", function: { name: SUBMIT_TOOL } });
    expect(bodies[2]).not.toHaveProperty("reasoning");
  });

  it("marks the system prompt and the last message of every call: two breakpoints of Anthropic's four", async () => {
    const { bodies } = await bodiesOf("claude-opus-4-8", ON);
    for (const body of bodies) {
      expect(markers(body)).toEqual([0, body.messages.length - 1]);
      expect(JSON.stringify(body.tools)).not.toContain("cache_control");
    }
    // The first call ends on the task; the later ones on the last search's result.
    expect(bodies[0]!.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: expect.stringContaining("look twice"), cache_control: { type: "ephemeral" } }] });
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: [{ type: "text", cache_control: { type: "ephemeral" } }] });
    // Only the call's own copy is marked: the message the breakpoint left behind goes back plain.
    expect(bodies[2]!.messages.filter((message) => message.role === "tool").map((message) => typeof message.content)).toEqual(["string", "object"]);
  });

  it("sends each round's thinking back on its calls, whole and signed, the forced round's included", async () => {
    const { bodies } = await bodiesOf("claude-opus-4-8", ON);
    expect(thoughtsSent(bodies[1]!)).toEqual([[{ type: "reasoning.text", text: "first look", signature: "sig-1" }]]);
    expect(thoughtsSent(bodies[2]!)).toEqual([
      [{ type: "reasoning.text", text: "first look", signature: "sig-1" }],
      [{ type: "reasoning.text", text: "second look", signature: "sig-2" }],
    ]);
    // The thinking is not what the model said: no text rides in its place.
    expect(bodies[1]!.messages.find((message) => message.role === "assistant")!.content).toBe("");
  });

  it("thinks on a step's own Claude, keyed off the model each call goes to", async () => {
    const { bodies } = await bodiesOf("gemini-2.5-pro", { ...ON, model: "claude-sonnet-5" });
    expect(bodies.map((body) => body.model)).toEqual(["vertex/claude-sonnet-5", "vertex/claude-sonnet-5", "vertex/claude-sonnet-5"]);
    expect(bodies.map((body) => "reasoning" in body)).toEqual([true, true, false]);
    expect(markers(bodies[1]!)).toEqual([0, bodies[1]!.messages.length - 1]);
  });

  it("journals on each frame what the call opted into: thinking only where it was free to", async () => {
    const { state } = await bodiesOf("claude-opus-4-8", ON);
    const frames = (await state.read(RUN)).filter((one) => one.kind === "frame").map((one) => one.payload as FramePayload);
    expect(frames.map((frame) => [frame.sampling["cache_conversation"], frame.sampling["think"]])).toEqual([
      [true, "adaptive"],
      [true, "adaptive"],
      [true, undefined],
    ]);
  });

  it("hashes a frame's input without the thinking, which the ledger never holds", () => {
    const plain: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", tool: "bump", args: "{}" }] },
    ];
    const thought: Message[] = [plain[0]!, { ...plain[1]!, reasoning: [{ type: "reasoning.text", text: "hm", signature: "s" }] } as Message];
    expect(inputHash(thought, [], null)).toBe(inputHash(plain, [], null));
  });
});

describe("a turn that does not opt in, or a model that is not Claude", () => {
  it("is sent what it always was on Claude: the system prompt marked, nothing asked to think, nothing thought sent back", async () => {
    const { bodies, state } = await bodiesOf("claude-opus-4-8");
    for (const body of bodies) {
      expect(markers(body)).toEqual([0]);
      expect(body).not.toHaveProperty("reasoning");
      expect(thoughtsSent(body).every((one) => one === undefined)).toBe(true);
      expect(body.messages.slice(1).every((message) => typeof message.content === "string")).toBe(true);
    }
    const frames = (await state.read(RUN)).filter((one) => one.kind === "frame").map((one) => one.payload as FramePayload);
    expect(frames.every((frame) => !("think" in frame.sampling) && !("cache_conversation" in frame.sampling))).toBe(true);
  });

  it("explicitly off is the same bodies as unset", async () => {
    const unset = await bodiesOf("claude-opus-4-8");
    const off = await bodiesOf("claude-opus-4-8", { cache_conversation: false, think: false });
    expect(JSON.stringify(off.bodies)).toBe(JSON.stringify(unset.bodies));
  });

  it.each(["gemini-2.5-pro", "gpt-4o"])("leaves %s byte-identical with both on", async (model) => {
    const on = await bodiesOf(model, ON);
    const off = await bodiesOf(model);
    expect(JSON.stringify(on.bodies)).toBe(JSON.stringify(off.bodies));
    expect(JSON.stringify(on.bodies)).not.toContain("cache_control");
    expect(JSON.stringify(on.bodies)).not.toContain("reasoning");
  });

  it("caches an older Claude's conversation but does not ask it to think: Bifrost would give it a fixed budget", async () => {
    const { bodies } = await bodiesOf("claude-sonnet-4-5", ON);
    expect(bodies.every((body) => !("reasoning" in body))).toBe(true);
    expect(markers(bodies[1]!)).toEqual([0, bodies[1]!.messages.length - 1]);
  });
});
