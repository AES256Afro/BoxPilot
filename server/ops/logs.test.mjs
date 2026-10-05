import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { finalRedaction } from "../assistant/prompt.mjs";
import { createRedactor } from "../redaction.mjs";
import { logOperations } from "./logs.mjs";
import { createRegistry } from "./registry.mjs";

const registry = createRegistry([logOperations]);

describe("log operations", () => {
  it("lists groups, units, and containers", async () => {
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "list-units") return { ok: true, stdout: JSON.stringify([{ unit: "docker.service", description: "Docker", active: "active" }, { unit: "weird unit", description: "" }]), stderr: "" };
      if (args[0] === "ps") return { ok: true, stdout: "bp-jellyfin\trunning\tjellyfin/jellyfin:10.11.11\nbad name\trunning\tx", stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    });
    await expect(registry.execute("logs.sources", {}, { run })).resolves.toEqual({ groups: expect.arrayContaining([{ id: "boxpilot", label: "BoxPilot" }, { id: "kernel", label: "Kernel" }]), units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [{ name: "bp-jellyfin", state: "running", image: "jellyfin/jellyfin:10.11.11" }], dockerAvailable: true });
  });

  it("reads groups, units, and containers with window and filter, and validates input", async () => {
    const calls = [];
    const run = vi.fn(async (binary, args) => {
      calls.push(`${binary.split("/").pop()} ${args.join(" ")}`);
      if (args[0] === "ps") return { ok: true, stdout: "bp-jellyfin\nother", stderr: "" };
      if (binary.endsWith("docker")) return { ok: true, stdout: "2026-08-21T01:00:00Z hello token=abc\n2026-08-21T01:00:01Z world", stderr: "" };
      return { ok: true, stdout: "-- Logs begin --\n2026-08-21T01:00:00+0000 host boxpilot[1]: up\n2026-08-21T01:00:01+0000 host boxpilot[1]: password=secret", stderr: "" };
    });
    await expect(registry.execute("logs.read", { kind: "group", target: "boxpilot", lines: 50, since: "2h" }, { run })).resolves.toMatchObject({ lines: ["2026-08-21T01:00:00+0000 host boxpilot[1]: up", "2026-08-21T01:00:01+0000 host boxpilot[1]: password=[REDACTED]"] });
    expect(calls.at(-1)).toBe("journalctl --no-pager -o short-iso -n 50 --since -2hour -u boxpilot.service -u boxpilot-helper.service -u boxpilot-run@*");
    await expect(registry.execute("logs.read", { kind: "group", target: "kernel" }, { run })).resolves.toMatchObject({ kind: "group" });
    expect(calls.at(-1)).toContain(" -k");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", filter: "error" }, { run })).resolves.toMatchObject({ target: "docker.service" });
    expect(calls.at(-1)).toBe("journalctl --no-pager -o short-iso -n 5000 -u docker.service");
    await expect(registry.execute("logs.read", { kind: "container", target: "bp-jellyfin", filter: "hello" }, { run })).resolves.toEqual({ kind: "container", target: "bp-jellyfin", lines: ["2026-08-21T01:00:00Z hello token=[REDACTED]"], truncated: false });
    await expect(registry.execute("logs.read", { kind: "container", target: "missing" }, { run })).rejects.toThrow("not found");
    await expect(registry.execute("logs.read", { kind: "unit", target: "../etc" }, { run })).rejects.toThrow("invalid");
    await expect(registry.execute("logs.read", { kind: "group", target: "nope" }, { run })).rejects.toThrow("Unknown log group");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "yesterday" }, { run })).rejects.toThrow("must look like");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", lines: 5 }, { run })).rejects.toThrow("10-2000");
  });

  it("keeps the zone of a followed timestamp instead of reading it as host-local time", async () => {
    const calls = [];
    const run = vi.fn(async (binary, args) => {
      calls.push(`${binary.split("/").pop()} ${args.join(" ")}`);
      if (args[0] === "ps") return { ok: true, stdout: "bp-jellyfin", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await registry.execute("logs.read", { kind: "container", target: "bp-jellyfin", since: "2026-08-21T01:00:00Z" }, { run });
    expect(calls.at(-1)).toBe("docker logs --timestamps --tail 300 --since 2026-08-21T01:00:00Z bp-jellyfin");
    await registry.execute("logs.read", { kind: "container", target: "bp-jellyfin", since: "2026-08-21T03:00:00+02:00" }, { run });
    expect(calls.at(-1)).toContain("--since 2026-08-21T01:00:00Z ");
    await registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "2026-08-20T21:00:00-0400" }, { run });
    expect(calls.at(-1)).toBe("journalctl --no-pager -o short-iso -n 300 --since 2026-08-21 01:00:00 UTC -u docker.service");
    await registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "2026-08-21 01:00" }, { run });
    expect(calls.at(-1)).toContain("--since 2026-08-21 01:00 -u");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "2026-08-21T01:00:00+2" }, { run })).rejects.toThrow("must look like");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "2026-13-45T01:00:00Z" }, { run })).rejects.toThrow("must look like");
  });
});

it("restricts live-output cache release to owners and a single validated job id", () => {
  expect(registry.get("job.output.release")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: false });
  expect(registry.validate("job.output.release", { jobId: "../../etc/passwd" })).not.toBeNull();
  expect(registry.validate("job.output.release", { jobId: "11111111-2222-4333-8444-555555555555", path: "/tmp/x" })).not.toBeNull();
});

/**
 * An obviously fake key, made here from random bytes in a key's shape: never a real one. Each body
 * line starts FAKE and its number, so a line that survives is easy to name, and the last one is short
 * the way a real key's is.
 */
function fakeKey(label = "RSA PRIVATE KEY", lines = 26) {
  const body = Array.from({ length: lines }, (_, index) => `FAKE${String(index).padStart(2, "0")}${randomBytes(48).toString("base64")}`.slice(0, index === lines - 1 ? 28 : 64));
  return { lines: [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`], body };
}
const survivors = (output, body) => body.filter((line) => output.includes(line) || output.includes(line.slice(6, 28)));

/**
 * journalctl as far as these tests need it: `-g` matches the message (not the timestamp, host and unit
 * before it) as a regular expression, case-blind when the pattern has no capital letter; `-n` keeps
 * the newest matches. The pattern is read the way PCRE2 reads the two things the sweep-5 review used:
 * `\Q` quotes the rest up to `\E`, and `(?x)` makes `#` start a comment to the end.
 */
function asPcre2(raw) {
  let source = raw.replace(/\\Q([\s\S]*?)(?:\\E|$)/g, (_all, literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const extended = source.indexOf("(?x)");
  if (extended >= 0) source = `${source.slice(0, extended)}${source.slice(extended + 4).replace(/#.*$/, "").replace(/\s+/g, "")}`;
  return new RegExp(source, /[A-Z]/.test(raw) ? "" : "i");
}

function fakeJournal(entries) {
  return vi.fn(async (_binary, args) => {
    let shown = entries;
    const grep = args.indexOf("-g");
    if (grep >= 0) {
      const pattern = asPcre2(args[grep + 1]);
      shown = entries.filter((entry) => pattern.test(entry.message));
    }
    const newest = Number(args[args.indexOf("-n") + 1]);
    return { ok: true, stdout: shown.slice(-newest).map((entry) => `${entry.at} box ${entry.unit}: ${entry.message}`).join("\n"), stderr: "" };
  });
}

describe("a private key in a log read with a filter (sweep 4)", () => {
  // What the agents' logs_query tool hands the model: the lines, joined, through the final redaction.
  const toModel = (result) => finalRedaction(`${result.lines.length} lines:\n${result.lines.join("\n")}`, createRedactor());

  it("takes a key out of the journal even when the filter would drop its BEGIN and END lines", async () => {
    const key = fakeKey();
    const entries = [
      { at: "2026-10-05T09:00:00+0000", unit: "certgen[311]", message: "writing a fresh key for the dashboard" },
      ...key.lines.map((message) => ({ at: "2026-10-05T09:00:01+0000", unit: "certgen[311]", message })),
      { at: "2026-10-05T09:00:02+0000", unit: "certgen[311]", message: "fake dashboard certificate is ready" },
    ];
    // "fake" is in every body line and in neither marker line; "m" is the filter the sweep caught.
    for (const filter of ["fake", "m"]) {
      const result = await registry.execute("logs.read", { kind: "unit", target: "certgen.service", filter }, { run: fakeJournal(entries) });
      expect(survivors(result.lines.join("\n"), key.body), filter).toEqual([]);
      expect(survivors(toModel(result), key.body), filter).toEqual([]);
      expect(result.lines.join("\n"), filter).toContain("[REDACTED_PRIVATE_KEY]");
    }
    const matching = await registry.execute("logs.read", { kind: "unit", target: "certgen.service", filter: "fake" }, { run: fakeJournal(entries) });
    expect(matching.lines).toContain("2026-10-05T09:00:02+0000 box certgen[311]: fake dashboard certificate is ready");
    expect(matching.lines).not.toContain("2026-10-05T09:00:00+0000 box certgen[311]: writing a fresh key for the dashboard");
  });

  it("takes a key out of a container's log before the filter picks lines", async () => {
    const key = fakeKey("PRIVATE KEY");
    const stdout = [
      "2026-10-05T09:00:00.000000001Z starting the web server",
      ...key.lines.map((line) => `2026-10-05T09:00:01.000000001Z ${line}`),
      "2026-10-05T09:00:02.000000001Z fake listener up on :8443",
    ].join("\n");
    const run = vi.fn(async (_binary, args) => (args[0] === "ps" ? { ok: true, stdout: "bp-certs", stderr: "" } : { ok: true, stdout, stderr: "" }));
    for (const filter of ["fake", "m"]) {
      const result = await registry.execute("logs.read", { kind: "container", target: "bp-certs", filter }, { run });
      expect(survivors(result.lines.join("\n"), key.body), filter).toEqual([]);
      expect(survivors(toModel(result), key.body), filter).toEqual([]);
    }
    const matching = await registry.execute("logs.read", { kind: "container", target: "bp-certs", filter: "fake" }, { run });
    expect(matching.lines).toEqual(["2026-10-05T09:00:01.000000001Z [REDACTED_PRIVATE_KEY]", "2026-10-05T09:00:02.000000001Z fake listener up on :8443"]);
  });
});

describe("a journal filter that journalctl would read as more than text (sweep 5)", () => {
  const toModel = (result) => finalRedaction(`${result.lines.length} lines:\n${result.lines.join("\n")}`, createRedactor());
  const journalWithKey = () => {
    const key = fakeKey();
    const entries = [
      { at: "2026-10-05T09:00:00+0000", unit: "certgen[311]", message: "writing a fresh key for the dashboard" },
      ...key.lines.map((message) => ({ at: "2026-10-05T09:00:01+0000", unit: "certgen[311]", message })),
      { at: "2026-10-05T09:00:02+0000", unit: "certgen[311]", message: "fake dashboard certificate is ready" },
    ];
    return { key, entries };
  };

  it("takes the key out whatever the filter says, and never hands the filter to journalctl", async () => {
    const { key, entries } = journalWithKey();
    // Each picks the key's first two body lines. Paired with the key markers as one -g pattern, the
    // first quoted the marker alternative away (\Q) and the second commented it out ((?x)#), so two
    // body lines came back with no BEGIN or END - one short of the run redactKeyBodies takes out.
    for (const filter of [String.raw`FAKE0[01])|zzz\Q`, "FAKE0[01])(?x)#", "FAKE00", "fake"]) {
      const run = fakeJournal(entries);
      const result = await registry.execute("logs.read", { kind: "unit", target: "certgen.service", filter }, { run });
      expect(run.mock.calls.at(-1)[1], filter).not.toContain("-g");
      expect(run.mock.calls.at(-1)[1].join(" "), filter).not.toContain(filter);
      expect(survivors(result.lines.join("\n"), key.body), filter).toEqual([]);
      expect(survivors(toModel(result), key.body), filter).toEqual([]);
    }
  });

  it("matches the filter as text, case-blind, over a bounded window, newest matches last", async () => {
    const { entries } = journalWithKey();
    const run = fakeJournal(entries);
    const result = await registry.execute("logs.read", { kind: "unit", target: "certgen.service", filter: "DASHBOARD", lines: 10 }, { run });
    expect(result.lines).toEqual([
      "2026-10-05T09:00:00+0000 box certgen[311]: writing a fresh key for the dashboard",
      "2026-10-05T09:00:01+0000 box certgen[311]: [REDACTED_PRIVATE_KEY]",
      "2026-10-05T09:00:02+0000 box certgen[311]: fake dashboard certificate is ready",
    ]);
    const args = run.mock.calls.at(-1)[1];
    expect(Number(args[args.indexOf("-n") + 1])).toBe(5_000);
    // A pattern is text: "a.b" is not a regular expression that matches "axb".
    const literal = await registry.execute("logs.read", { kind: "unit", target: "certgen.service", filter: "fresh.key" }, { run: fakeJournal([{ at: "2026-10-05T09:00:00+0000", unit: "certgen[311]", message: "fresh key" }]) });
    expect(literal.lines).toEqual([]);
    const many = Array.from({ length: 40 }, (_, index) => ({ at: `2026-10-05T09:00:${String(index).padStart(2, "0")}+0000`, unit: "app[1]", message: `error ${index}` }));
    const newest = await registry.execute("logs.read", { kind: "unit", target: "app.service", filter: "error", lines: 10 }, { run: fakeJournal(many) });
    expect(newest.lines).toEqual(many.slice(-10).map((entry) => `${entry.at} box app[1]: ${entry.message}`));
  });
});
