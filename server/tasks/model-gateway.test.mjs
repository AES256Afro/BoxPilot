// @vitest-environment node
import { describe, expect, it } from "vitest";
import { keyFile, settingsFile } from "../model-gateway/paths.mjs";
import { modelGatewayCap, modelGatewayConnect, modelGatewayDisconnect } from "./model-gateway.mjs";

/*
 * The model gateway's root tasks (M45.3): the key root-only, the cap, the gateway on, the key proved
 * before it is kept, and the key before it back when Claude refuses the new one.
 */

const key = `sk-ant-api03-${"a".repeat(40)}`;
const older = `sk-ant-api03-${"b".repeat(40)}`;

function host({ files = {}, userExists = true, unitInstalled = true, check = async () => ({ ok: true }), status = async () => ({ connected: true }) } = {}) {
  const disk = new Map(Object.entries(files));
  const modes = new Map();
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command.endsWith("/id")) return { ok: userExists, stdout: "", stderr: userExists ? "" : "no such user" };
    if (args[0] === "cat") return { ok: unitInstalled, stdout: "", stderr: unitInstalled ? "" : "No files found" };
    return { ok: true, stdout: "active\n", stderr: "" };
  };
  const fileSystem = {
    mkdir: async () => {},
    readFile: async (file) => { if (!disk.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return disk.get(file); },
    writeFile: async (file, text, { mode } = {}) => { disk.set(file, text); modes.set(file, mode); },
    rm: async (file) => { disk.delete(file); },
  };
  const logs = [];
  return { disk, modes, calls, logs, context: { run, files: fileSystem, client: { status, check }, wait: async () => {}, log: (line) => logs.push(line) } };
}

describe("connecting Claude", () => {
  it("keeps the key root-only and the cap readable, starts the gateway, and proves the key", async () => {
    const box = host({ userExists: false });
    expect(await modelGatewayConnect({ key, capUsd: 20 }, box.context)).toEqual({ connected: true, capUsd: 20, unit: "boxpilot-model-gateway.service" });
    expect(box.disk.get(keyFile)).toBe(`${key}\n`);
    expect(box.modes.get(keyFile)).toBe(0o600);
    expect(JSON.parse(box.disk.get(settingsFile))).toEqual({ capUsd: 20 });
    expect(box.modes.get(settingsFile)).toBe(0o644);
    expect(box.calls).toContain("/usr/sbin/useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --user-group boxpilot-model-gateway");
    expect(box.calls).toEqual(expect.arrayContaining(["/usr/bin/systemctl enable boxpilot-model-gateway.service", "/usr/bin/systemctl restart boxpilot-model-gateway.service"]));
    expect(box.logs.join("\n")).not.toContain(key);
  });

  it("does not keep a key Claude refuses: the one before comes back", async () => {
    const box = host({ files: { [keyFile]: `${older}\n` }, check: async () => { throw Object.assign(new Error("refused"), { code: "auth" }); } });
    await expect(modelGatewayConnect({ key, capUsd: 20 }, box.context)).rejects.toThrow(/refused this key, so it was not kept/);
    expect(box.disk.get(keyFile)).toBe(`${older}\n`);
    expect(box.calls.filter((call) => call.endsWith("restart boxpilot-model-gateway.service"))).toHaveLength(2);
  });

  it("keeps no key when there was none and the gateway cannot reach Claude", async () => {
    const box = host({ check: async () => { throw Object.assign(new Error("down"), { code: "unreachable" }); } });
    await expect(modelGatewayConnect({ key, capUsd: 20 }, box.context)).rejects.toThrow(/could not be reached/);
    expect(box.disk.has(keyFile)).toBe(false);
    expect(box.calls).toContain("/usr/bin/systemctl disable --now boxpilot-model-gateway.service");
  });

  it("refuses what is not a key, a cap out of range, and a server without the unit", async () => {
    await expect(modelGatewayConnect({ key: "sk-proj-abc", capUsd: 20 }, host().context)).rejects.toThrow(/not an Anthropic API key/);
    await expect(modelGatewayConnect({ key, capUsd: 0 }, host().context)).rejects.toThrow(/whole dollars from 1 to 1000/);
    await expect(modelGatewayConnect({ key, capUsd: 12.5 }, host().context)).rejects.toThrow(/whole dollars/);
    await expect(modelGatewayConnect({ key, capUsd: 20 }, host({ unitInstalled: false }).context)).rejects.toThrow(/upgrade BoxPilot/);
  });
});

describe("the cap and disconnecting", () => {
  it("writes a new cap for the gateway's next call", async () => {
    const box = host();
    expect(await modelGatewayCap({ capUsd: 50 }, box.context)).toEqual({ capUsd: 50 });
    expect(JSON.parse(box.disk.get(settingsFile))).toEqual({ capUsd: 50 });
    await expect(modelGatewayCap({ capUsd: 5000 }, box.context)).rejects.toThrow(/whole dollars/);
  });

  it("stops the gateway and deletes the key, keeping the cap", async () => {
    const box = host({ files: { [keyFile]: `${key}\n`, [settingsFile]: "{\"capUsd\":20}\n" } });
    expect(await modelGatewayDisconnect({}, box.context)).toEqual({ connected: false });
    expect(box.disk.has(keyFile)).toBe(false);
    expect(box.disk.has(settingsFile)).toBe(true);
    expect(box.calls).toContain("/usr/bin/systemctl disable --now boxpilot-model-gateway.service");
  });
});
