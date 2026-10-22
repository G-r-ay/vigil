import { describe, expect, it } from "vitest";
import { frameAlert, judged, neutralTitle, timeOf } from "../../../plugins/rootcause/v3/frame.js";

describe("timeOf", () => {
  it("reads epoch seconds as the brief wrote them", () => {
    expect(timeOf("1534759305")).toBe("2018-08-20T10:01:45.000Z");
    expect(timeOf(" 1534759305.5 ")).toBe("2018-08-20T10:01:45.500Z");
  });

  it("reads an ISO timestamp", () => {
    expect(timeOf("2018-08-20T15:17:00Z")).toBe("2018-08-20T15:17:00.000Z");
  });

  it("answers null for no time", () => {
    expect(timeOf(null)).toBeNull();
    expect(timeOf("")).toBeNull();
    expect(timeOf("yesterday-ish")).toBeNull();
  });
});

// The frame turn as the kernel answers it: each ask's task is recorded, the answers handed back in order.
const turnsOf = (...answers: (Record<string, unknown> | null)[]) => {
  const tasks: string[] = [];
  const turns = {
    turn: async (sub: { task: string }) => {
      tasks.push(sub.task);
      const value = answers.shift() ?? null;
      return { refusal: null, value, reason: value === null ? "no answer" : "the role answered" };
    },
  } as unknown as Parameters<typeof frameAlert>[0];
  return { turns, tasks };
};
const answer = (over: Record<string, unknown> = {}) => ({
  title: "DeleteRule on events.amazonaws.com by arn:aws:sts::1:assumed-role/admin/x from 13.38.84.140",
  action: "DeleteRule", target: "events.amazonaws.com", principal: "arn:aws:sts::1:assumed-role/admin/x", address: "13.38.84.140",
  observed_at: "2026-08-13T12:34:40Z", source: "aws:cloudtrail",
  artifacts: [{ kind: "arn", value: "arn:aws:sts::1:assumed-role/admin/x" }, { kind: "ip", value: "13.38.84.140" }],
  index: "lab", ...over,
});
const BRIEF = "The attacker used the stolen admin role arn:aws:sts::1:assumed-role/admin/x from 13.38.84.140 to delete the security rule (DeleteRule) at 2026-08-13T12:34:40Z.";

describe("frameAlert: the alert's title is named neutrally", () => {
  it("tells the frame model to name the event without judging it, even where the brief does", async () => {
    const { turns } = turnsOf(answer());
    let system = "";
    const spy = { turn: async (sub: { system: string }) => { system = sub.system; return (turns as { turn: (s: unknown) => unknown }).turn(sub); } } as unknown as Parameters<typeof frameAlert>[0];
    await frameAlert(spy, "r1", BRIEF, ["lab"]);
    expect(system).toMatch(/title names that event neutrally.*by which principal, from which address.*No judgement words \(attacker, malicious, compromised, stolen.*even where the brief uses them/s);
  });

  it("keeps a neutral title from an accusing brief as it came, asked once, the brief's values as artifacts", async () => {
    const { turns, tasks } = turnsOf(answer());
    const framed = await frameAlert(turns, "r1", BRIEF, ["lab"]);
    expect(tasks).toHaveLength(1);
    expect(framed.alert.title).toBe(answer().title);
    expect(framed.alert.artifacts).toEqual(answer().artifacts);
    expect(framed.note).toBeNull();
  });

  it("leaves a neutral brief's framing unchanged", async () => {
    const neutral = "DeleteRule on events.amazonaws.com by arn:aws:sts::1:assumed-role/admin/x from 13.38.84.140 at 2026-08-13T12:34:40Z.";
    const { turns, tasks } = turnsOf(answer());
    const framed = await frameAlert(turns, "r1", neutral, ["lab"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).not.toContain("<correction>");
    expect(framed).toMatchObject({ alert: { title: answer().title, description: neutral, observedAt: "2026-08-13T12:34:40.000Z", source: "aws:cloudtrail" }, index: "lab", note: null });
  });

  it("asks once more with the rule when the title accuses, and takes the neutral answer", async () => {
    const { turns, tasks } = turnsOf(answer({ title: "Attacker deletes security rule with stolen admin role" }), answer());
    const framed = await frameAlert(turns, "r1", BRIEF, ["lab"]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatch(/<correction>\nYour title "Attacker deletes security rule with stolen admin role" judges the event \("attacker", "stolen"\)\..*no judgement words/s);
    expect(framed.alert.title).toBe(answer().title);
    expect(framed.note).toMatch(/judged the event \("attacker", "stolen"\); asked again with the rule, it named it neutrally/);
  });

  it("holds the title to the takeover rule too", async () => {
    const { turns, tasks } = turnsOf(answer({ title: "Admin role taken over, rule deleted" }), answer());
    await frameAlert(turns, "r1", BRIEF, ["lab"]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toContain('("taken over")');
  });

  it("names the title in code from the framed parts when the second answer still accuses", async () => {
    const accusing = answer({ title: "Malicious DeleteRule by the attacker", action: "malicious DeleteRule", principal: "the attacker" });
    const { turns, tasks } = turnsOf(accusing, accusing);
    const framed = await frameAlert(turns, "r1", BRIEF, ["lab"]);
    expect(tasks).toHaveLength(2);
    // The principal the model judged is read from the artifacts instead; the brief's values stay as they were.
    expect(framed.alert.title).toBe("DeleteRule on events.amazonaws.com by arn:aws:sts::1:assumed-role/admin/x from 13.38.84.140");
    expect(judged(framed.alert.title)).toBeNull();
    expect(framed.alert.artifacts).toEqual(answer().artifacts);
    expect(framed.note).toMatch(/asked again with the rule, it still did \("malicious", "attacker"\), so the title was named in code from the framed parts: "DeleteRule on/);
  });

  it("names it in code from the first answer when the second ask is not answered", async () => {
    const { turns } = turnsOf(answer({ title: "Compromised admin deletes rule" }), null);
    const framed = await frameAlert(turns, "r1", BRIEF, ["lab"]);
    expect(framed.alert.title).toBe(answer().title);
    expect(framed.note).toMatch(/the second ask was not answered/);
  });

  it("does not ask again for a brief the run is refused on", async () => {
    const { turns, tasks } = turnsOf(answer({ title: "attacker", observed_at: null }));
    await expect(frameAlert(turns, "r1", BRIEF, ["lab"])).rejects.toThrow(/no point in time/);
    expect(tasks).toHaveLength(1);
  });
});

describe("neutralTitle", () => {
  it("is <action> on <target> by <principal> from <address>", () => {
    expect(neutralTitle({ action: "ConsoleLogin", target: "aws console", principal: "alice", address: "1.2.3.4" }, [])).toBe("ConsoleLogin on aws console by alice from 1.2.3.4");
  });
  it("takes out the judging words and what they leave dangling, reads a missing principal or address off the artifacts, and leaves out what nothing names", () => {
    const arts = [{ kind: "user" as const, value: "bob" }, { kind: "ip" as const, value: "9.9.9.9" }];
    expect(neutralTitle({ action: "the attacker's exfiltration of the bucket by the attacker", target: null, principal: "compromised bob", address: null }, arts)).toBe("of the bucket by bob from 9.9.9.9");
    expect(neutralTitle({ action: null, target: "ws-7" }, [])).toBe("Reported event on ws-7");
  });
  it("keeps a principal that is one of the brief's own values whole, though a check would fire on it", () => {
    expect(neutralTitle({ action: "CreateUser", principal: "rogue-svc" }, [{ kind: "user", value: "rogue-svc" }])).toBe("CreateUser by rogue-svc");
    expect(neutralTitle({ action: "CreateUser", principal: "rogue admin" }, [{ kind: "user", value: "carol" }])).toBe("CreateUser by carol");
  });
});
