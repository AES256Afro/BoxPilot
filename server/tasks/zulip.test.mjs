// @vitest-environment node
/**
 * The root tasks that reach Zulip for the agents (M38), against a stand-in for Zulip's API: the
 * bot's key is read from the credential store and never returned, every request goes to loopback
 * under Zulip's own name with the HTTPS Serve forwards, posts arrive (a long trace as a file), and
 * #agent-files is read within its limits.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeZulip } from "../../test/fake-zulip.mjs";
import { chatLimits } from "../agents/zulip.mjs";
import { zulipCheck, zulipClient, zulipPoll, zulipPost } from "./zulip.mjs";

const key = "k".repeat(16) + "EY".repeat(8);
const bot = "boxpilot-agents-bot@homebox.tail1234.ts.net";
let zulip;
const credentials = { read: async (name) => (name === "zulip-agents-bot" ? key : null) };
const where = () => ({ base: zulip.base, host: zulip.host, botEmail: bot, credentialName: "zulip-agents-bot" });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
  zulip = await startFakeZulip();
  zulip.addBot(bot, key);
  zulip.addPerson("owner@example.com", "o".repeat(32), "Alex");
  for (const name of ["agent-findings", "agent-logs", "agent-knowledge", "agent-files"]) zulip.addChannel(name);
});
afterEach(async () => { await zulip.close(); });

describe("reaching Zulip", () => {
  it("goes only to loopback, as Serve does, and never hands back the key", async () => {
    const result = await zulipCheck({ ...where(), hello: { channel: "agent-findings", topic: "BoxPilot", content: "Connected." } }, { credentials });
    expect(result).toMatchObject({ email: bot, isBot: true });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(zulip.messages("agent-findings").map((message) => [message.sender_email, message.subject, message.content])).toEqual([[bot, "BoxPilot", "Connected."]]);
    for (const request of zulip.requests) expect(request).toMatchObject({ host: "homebox.tail1234.ts.net:8543", proto: "https" });
    await expect(zulipClient({ ...where(), base: "http://192.168.1.10:8543" }, { credentials })).rejects.toThrow("loopback address only");
    await expect(zulipClient({ ...where(), base: "https://example.com" }, { credentials })).rejects.toThrow("loopback address only");
    await expect(zulipClient({ ...where(), credentialName: "missing" }, { credentials })).rejects.toThrow("not saved under missing");
  });

  it("says when Zulip refuses the key, and when the key is a person's", async () => {
    const wrong = { read: async () => "w".repeat(32) };
    await expect(zulipCheck(where(), { credentials: wrong })).rejects.toThrow("Zulip refused the bot's key; connect Zulip again");
    const person = { read: async () => "o".repeat(32) };
    await expect(zulipCheck({ ...where(), botEmail: "owner@example.com" }, { credentials: person })).rejects.toThrow("belongs to a person, not the bot");
  });
});

describe("posting", () => {
  it("sends each post to its channel and topic, and a long trace as a file linked from it", async () => {
    const { results } = await zulipPost({ ...where(), posts: [
      { id: uuid(1), channel: "agent-findings", topic: "Server Keeper", content: "**Server Keeper** answered." },
      { id: uuid(2), channel: "agent-logs", topic: "Server Keeper", content: "run abc", attachment: { name: "run-abc.md", text: "# The whole trace\n\nstep 1" } },
    ] }, { credentials });
    expect(results).toEqual([{ id: uuid(1), ok: true, messageId: expect.any(Number) }, { id: uuid(2), ok: true, messageId: expect.any(Number) }]);
    expect(zulip.messages("agent-findings")[0].content).toBe("**Server Keeper** answered.");
    const log = zulip.messages("agent-logs")[0];
    expect(log.content).toMatch(/^run abc\n\nThe whole trace: \[run-abc\.md\]\(\/user_uploads\/2\/[0-9a-f]+\/[0-9a-f]+\/run-abc\.md\)$/);
    expect(zulip.requests.some((request) => request.path === "/api/v1/user_uploads" && request.body.includes("# The whole trace"))).toBe(true);
  });

  it("reports a post Zulip would not take and sends the rest; a refused key stops the batch", async () => {
    const { results } = await zulipPost({ ...where(), posts: [
      { id: uuid(1), channel: "no-such-channel", topic: "x", content: "lost" },
      { id: uuid(2), channel: "agent-findings", topic: "x", content: "kept" },
    ] }, { credentials });
    expect(results).toEqual([{ id: uuid(1), ok: false, error: "Posting to #no-such-channel: Zulip said Channel 'no-such-channel' does not exist" }, { id: uuid(2), ok: true, messageId: expect.any(Number) }]);
    const refused = await zulipPost({ ...where(), posts: [{ id: uuid(3), channel: "agent-findings", topic: "x", content: "a" }, { id: uuid(4), channel: "agent-findings", topic: "x", content: "b" }] }, { credentials: { read: async () => "w".repeat(32) } });
    expect(refused.results.map((result) => result.ok)).toEqual([false, false]);
    expect(refused.results[1].error).toMatch(/refused the bot's key/);
  });
});

describe("reading #agent-files", () => {
  it("brings the files people linked after the last message seen, and leaves the bot's own out", async () => {
    const notes = zulip.addUpload("router notes.md", Buffer.from("# Router\nThe router is upstairs."));
    const photo = zulip.addUpload("rack.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const zip = zulip.addUpload("backup.zip", Buffer.from("PK"));
    const first = zulip.postAs("owner@example.com", "agent-files", "house", `The router [router notes.md](${notes})`);
    zulip.postAs(bot, "agent-files", "house", "Added to Knowledge as “router notes”.");
    zulip.postAs("owner@example.com", "agent-files", "rack", `Photo [rack.png](${photo}) and [backup.zip](${zip})`);
    const read = await zulipPoll({ ...where(), channel: "agent-files", after: null }, { credentials });
    expect(read.messages.map((message) => [message.topic, message.sender, message.files.map((file) => [file.name, file.kind ?? null, file.skipped ?? null])])).toEqual([
      ["house", "Alex", [["router notes.md", "text", null]]],
      ["rack", "Alex", [["rack.png", "image", null], ["backup.zip", null, "not a PDF, Markdown, text or image file"]]],
    ]);
    expect(Buffer.from(read.messages[0].files[0].bytes, "base64").toString("utf8")).toBe("# Router\nThe router is upstairs.");
    expect(read.last).toBeGreaterThan(first.id);
    const again = await zulipPoll({ ...where(), channel: "agent-files", after: read.last }, { credentials });
    expect(again.messages).toEqual([]);
  });

  it("leaves out a file larger than 5 MB, and stops a poll at its file limit, to go on next time", async () => {
    const big = zulip.addUpload("huge.pdf", Buffer.alloc(chatLimits.fileBytes + 10, 1));
    zulip.postAs("owner@example.com", "agent-files", "big", `[huge.pdf](${big})`);
    const many = Array.from({ length: chatLimits.filesPerPoll + 2 }, (_value, index) => zulip.addUpload(`note-${index}.txt`, Buffer.from(`note ${index}`)));
    for (const path of many) zulip.postAs("owner@example.com", "agent-files", "many", `[${path.split("/").pop()}](${path})`);
    const read = await zulipPoll({ ...where(), channel: "agent-files", after: null }, { credentials });
    expect(read.messages[0].files).toEqual([{ name: "huge.pdf", skipped: "larger than 5 MB" }]);
    const taken = read.messages.flatMap((message) => message.files);
    expect(taken).toHaveLength(chatLimits.filesPerPoll);
    expect(read.more).toBe(true);
    const next = await zulipPoll({ ...where(), channel: "agent-files", after: read.last }, { credentials });
    expect(next.messages.flatMap((message) => message.files).map((file) => file.name)).toEqual(["note-9.txt", "note-10.txt", "note-11.txt"]);
  });
});
