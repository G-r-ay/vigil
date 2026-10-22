import { ZERO_TOKENS, type TokenCounts } from "../contracts/budget.js";

export interface ToolCall {
  id: string;
  tool: string;
  args: string;
}

// What a model thought before it answered, as the gateway handed it over: Bifrost's
// reasoning_details, one per thinking block. Opaque to the harness and passed back as it
// came, signature and all, because Anthropic checks a thinking block it is sent back.
export interface Reasoning {
  type: string;
  text?: string;
  signature?: string;
  data?: string;
}

// The harness's own message shape rather than a vendor's, so the loop imports no
// SDK and a second surface or a scripted provider is a drop-in.
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls: readonly ToolCall[]; reasoning?: readonly Reasoning[] }
  | { role: "tool"; call_id: string; content: string };

export interface ToolSchema {
  id: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnRequest {
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  // Set on the emission turn: answer against this schema, offer no tools. Combining
  // tools with a strict output format degrades unpredictably across providers.
  emit?: Record<string, unknown>;
  // Call this tool, and no other: tool_choice forced to it. A surface whose gateway refuses a
  // forced choice offers only that tool instead; one that refuses tools at all asks for the
  // tool's arguments as an emission. The run's emission turn covers a miss.
  force?: string;
  // Claude only, both; another model is sent what it always was. cache_conversation moves a
  // second cache breakpoint onto the last message of every call, so each round reads the
  // conversation so far from cache rather than only the system prompt. think asks for adaptive
  // thinking on a round whose tool choice is not forced: Anthropic refuses a forced tool with
  // thinking on, so a forced round never thinks.
  cache_conversation?: boolean;
  think?: boolean;
  signal?: AbortSignal;
}

// One model call assembled from its stream. Nothing on the wire returns this; it
// is what a consumer holds once the stream has ended.
export interface Turn {
  content: string;
  tool_calls: readonly ToolCall[];
  tokens: TokenCounts;
  reasoning?: readonly Reasoning[];
}

// Usage arrives before the stream ends, so a call that dies afterwards has still
// reported what it spent. Tool calls come last, once the model has asked for them.
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; tokens: TokenCounts }
  // Only when the model thought: what it thought, whole, before the calls it asked for.
  | { type: "reasoning"; reasoning: readonly Reasoning[] }
  | { type: "tool_call"; call: ToolCall };

// Exactly one model call, streamed. The loop belongs to the harness, which keeps
// the turn cap, approval gate and injection scan out of a component a workflow can swap.
export interface Provider {
  readonly model: string;
  readonly provider_type: string;
  // The sampling parameters every call is sent with, journaled on each frame so a
  // replay knows what the model was asked under. Absent is the provider's defaults.
  readonly sampling?: Readonly<Record<string, unknown>>;
  stream(request: TurnRequest): AsyncIterable<ProviderEvent>;
}

// Carries what was already burned, so a call that fails does not drop spend the
// budget still has to account for.
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly tokens: TokenCounts = ZERO_TOKENS,
  ) {
    super(message);
  }
}

// The model declined to answer (finish_reason "refusal", Bifrost's pass-through of Anthropic's
// stop_reason, or OpenAI's "content_filter"): its own answer, not a fault of the gateway.
export class ModelRefused extends ProviderError {}
