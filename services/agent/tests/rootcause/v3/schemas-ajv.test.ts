import { describe, expect, it } from "vitest";
import { schemaErrors } from "../../../core/stream.js";
import { clip, salvage, stripUnknown } from "../../../plugins/rootcause/v3/model/client.js";
import { lengthLimits, SUBMIT, type SubmitName } from "../../../plugins/rootcause/v3/model/schemas.js";
import { splunkTool } from "../../../plugins/rootcause/v3/tools/splunk-tool.js";

// The schemas are written by hand as JSON Schema; they have to compile under the agent's ajv (core/stream.ts),
// the one validator that holds a model's emission and a search's input to them.
const backend = { search: async () => "", count: async () => 0 };
const search = splunkTool(backend, "lab").inputSchema;
const names = Object.keys(SUBMIT) as SubmitName[];
const cand = { label: "curl wrote /tmp/x", domain: "edr", prior: 0.3, artifacts: [], nodeEvidence: [], edgeEvidence: [] };
const causes = { candidates: [cand], reasoning: "r" };

describe("v3 tool schemas", () => {
  it.each(names)("%s compiles under the agent's ajv", (name) => {
    expect(() => schemaErrors(SUBMIT[name], {})).not.toThrow();
  });
  it("the search tool compiles under the agent's ajv", () => {
    expect(() => schemaErrors(search, {})).not.toThrow();
  });
  it("names no draft, so a reader does not pick a different one", () => {
    for (const name of names) expect(SUBMIT[name]).not.toHaveProperty("$schema");
  });
  it("accepts a well-formed submission", () => {
    expect(schemaErrors(SUBMIT.submit_causes, causes)).toBeNull();
  });
  it("rejects a submission missing a required field at the path ajv reports to the kernel", () => {
    const { label: _, ...noLabel } = cand;
    expect(schemaErrors(SUBMIT.submit_causes, { ...causes, candidates: [noLabel] })).toContain("/candidates/0 must have required property 'label'");
    expect(schemaErrors(SUBMIT.submit_causes, { candidates: [cand] })).toContain("/ must have required property 'reasoning'");
  });
  it("leaves relation optional on an identity signal", () => {
    const signal = { layer: "machine-facing", kind: "account", value: "svc", toolCallIds: ["r1"] };
    expect(schemaErrors(SUBMIT.submit_causes, { ...causes, candidates: [{ ...cand, identitySignals: [signal] }] })).toBeNull();
  });
  it("rejects a search without a purpose", () => {
    expect(schemaErrors(search, { spl: "index=lab sourcetype=edr" })).toContain("must have required property 'purpose'");
  });
  it("a salvage that would leave a list under its minimum fails, as the schema's item counts say", () => {
    const theory = (id: string) => ({ id, story: "s", accountsFor: [], gaps: "g", predictions: [{ id: "P1", sourcetype: "edr", expect: "e", spl: "index=lab", separates: [] }] });
    const input = { theories: [theory("H1"), theory("H2")], nextTests: ["P1"], reasoning: "r" };
    expect(salvage("submit_theories", input, 0, {}, { success: false, msg: "m", drop: [["theories", 0]] })).toBeNull();
    expect(salvage("submit_theories", { ...input, theories: [theory("H1"), theory("H2"), theory("H3")] }, 0, {}, { success: false, msg: "m", drop: [["theories", 0]] })?.dropped).toBe(1);
  });
});

// As the reference's zod (a plain object) parses a submission: what its schema has no field for is dropped at every
// depth, and the rest is left for the schema to judge.
describe("a submission stripped of keys its schema has no field for", () => {
  it("drops them at every depth, in list items and nested objects, and says where each was", () => {
    const ev = { summary: "s", strength: "direct", polarity: "supports", toolCallIds: ["r1"], edge: "E1" };
    const input = { ...causes, candidates: [{ ...cand, boundary: { targetDomain: "x" }, nodeEvidence: [ev], baseline: { summary: "s", unusual: true, toolCallIds: ["r1"], window: "30d" } }], source: "edr", next: { move: "expand", why: "w", hint: "h" } };
    const { value, stripped } = stripUnknown(SUBMIT.submit_causes, input);
    expect(stripped.sort()).toEqual(["candidates.0.baseline.window", "candidates.0.boundary", "candidates.0.nodeEvidence.0.edge", "next.hint", "source"]);
    expect(schemaErrors(SUBMIT.submit_causes, value)).toBeNull();
    const { edge: _, ...kept } = ev;
    expect(value).toEqual({ ...causes, candidates: [{ ...cand, nodeEvidence: [kept], baseline: { summary: "s", unusual: true, toolCallIds: ["r1"] } }], next: { move: "expand", why: "w" } });
    // The input is not changed.
    expect(input.candidates[0]).toHaveProperty("boundary");
  });
  it("leaves a value of the wrong type for the schema to refuse, as zod does", () => {
    const { value, stripped } = stripUnknown(SUBMIT.submit_causes, { ...causes, next: "expand", candidates: "[]" });
    expect(stripped).toEqual([]);
    expect(schemaErrors(SUBMIT.submit_causes, value)).toContain("/next must be object");
  });
  it("leaves an object whose schema allows other keys as it is", () => {
    const open = { type: "object", properties: { a: { type: "string" } } };
    expect(stripUnknown(open, { a: "x", b: 1 })).toEqual({ value: { a: "x", b: 1 }, stripped: [] });
  });
  it("is what a salvage starts from: a failure that rested on a stray key is judged again without it, and costs no item", () => {
    const input = { ...causes, candidates: [{ ...cand, notes: "x" }, { ...cand, label: "b" }] };
    const first = { success: false as const, msg: 'candidates.0: unrecognized key "notes"', drop: [["candidates", 0]] };
    expect(salvage("submit_causes", input, 0, {}, first)).toEqual({ data: { ...causes, candidates: [cand, { ...cand, label: "b" }] }, dropped: 0 });
  });
});

// Every length cap in a schema is one `clip` trims to: found here by a walk of its own, not by clip's own table.
describe("the schemas' length caps", () => {
  type Cap = { name: string; key: string; max: number; list: boolean };
  const caps: Cap[] = [];
  const walk = (node: unknown, name: string, key: string): void => {
    if (!node || typeof node !== "object") return;
    const s = node as Record<string, any>;
    if (s.type === "string" && typeof s.maxLength === "number") caps.push({ name, key, max: s.maxLength, list: false });
    if (s.items?.type === "string" && typeof s.items.maxLength === "number") caps.push({ name, key, max: s.items.maxLength, list: true });
    else walk(s.items, name, key);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, name, k);
  };
  for (const name of names) walk(SUBMIT[name], name, "");

  it("no field name is capped differently in two places, or capped in one and not another", () => {
    expect(lengthLimits(Object.values(SUBMIT)).clashes).toEqual([]);
  });
  it.each(caps.map((c) => [`${c.name}.${c.key}${c.list ? "[]" : ""}`, c] as const))("%s is trimmed to its cap", (_, c) => {
    const long = "x".repeat(c.max + 50);
    const got = clip({ [c.key]: c.list ? [long] : long }) as Record<string, string | string[]>;
    const text = (c.list ? (got[c.key] as string[])[0] : got[c.key]) as string;
    expect(text).toHaveLength(c.max);
  });
  it("a clash is reported", () => {
    const a = { type: "object", properties: { note: { type: "string", maxLength: 10 }, b: { type: "object", properties: { note: { type: "string" } } } } };
    expect(lengthLimits([a]).clashes).toEqual(["note"]);
  });
});
