// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { laneFor } from "../helper-lanes.mjs";
import { credentialName, gatewayUnit, gatewayUser, keyFile } from "./paths.mjs";

/*
 * The gateway's unit and the operations around it (M45.3): its own user, the key by LoadCredential
 * from the root-only file the connect task writes, a sandbox that keeps it out of every other
 * secret, and nothing that turns it on but the owner connecting Claude.
 */

const unit = (await readFile(`deploy/${gatewayUnit}`, "utf8")).replaceAll("\r\n", "\n");
const directives = (name) => [...unit.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]);

describe("the model gateway's unit", () => {
  it("runs as its own user in the web service's group, so only that service may open its socket", () => {
    expect(directives("User")).toEqual([gatewayUser]);
    expect(directives("Group")).toEqual(["boxpilot"]);
    expect(directives("RuntimeDirectoryMode")).toEqual(["0750"]);
    expect(directives("ExecStart")).toEqual(["/usr/local/bin/node /opt/boxpilot/server/model-gateway/main.mjs"]);
  });

  it("gets the key from systemd, from the file connecting writes, and runs only when there is one", () => {
    expect(directives("LoadCredential")).toEqual([`${credentialName}:${keyFile}`]);
    expect(directives("ConditionPathExists")).toEqual([keyFile]);
    expect(unit).not.toMatch(/^EnvironmentFile=/m);
  });

  it("is sandboxed with no capabilities and kept out of every other secret on the server", () => {
    for (const [name, value] of [["NoNewPrivileges", "true"], ["ProtectSystem", "strict"], ["ProtectHome", "true"], ["PrivateDevices", "true"], ["PrivateTmp", "true"], ["CapabilityBoundingSet", ""], ["AmbientCapabilities", ""], ["RestrictSUIDSGID", "true"], ["ProtectProc", "invisible"], ["UMask", "0077"]]) {
      expect(directives(name), name).toEqual([value]);
    }
    expect(directives("InaccessiblePaths")[0].split(" ")).toEqual(["-/var/lib/boxpilot", "-/var/lib/boxpilot-managed", "-/etc/boxpilot/secrets"]);
    expect(unit).not.toMatch(/^ReadWritePaths=/m);
  });

  it("is installed with the other units and turned on only by connecting Claude", async () => {
    const install = (await readFile("scripts/boxpilot-install.sh", "utf8")).replaceAll("\r\n", "\n");
    const upgrade = (await readFile("scripts/boxpilot-upgrade.sh", "utf8")).replaceAll("\r\n", "\n");
    expect(install).not.toContain("boxpilot-model-gateway");
    expect(upgrade).not.toMatch(/systemctl \S+ boxpilot-model-gateway/);
    expect(upgrade).toContain('for unit in "${INSTALL_DIR}"/deploy/*.service');
  });
});

describe("the operations around it", () => {
  it("connect is high and the owner's, with the cap typed to agree to it; the cap and disconnecting are medium", () => {
    const connect = registry.get("agents.cloud.connect");
    expect([connect.risk, connect.minimumRole, connect.runsRootTask]).toEqual(["high", "owner", true]);
    expect(connect.confirm({ capUsd: 20 })).toBe("$20 a month");
    expect(connect.parameters.fields.key.secret).toBe(true);
    expect(registry.validate("agents.cloud.connect", { key: "sk-proj-abc", capUsd: 20 })).toMatch(/key/);
    expect(registry.validate("agents.cloud.connect", { key: `sk-ant-api03-${"x".repeat(40)}`, capUsd: 20 })).toBeNull();
    expect(registry.get("agents.cloud.cap").risk).toBe("medium");
    expect(registry.get("agents.cloud.disconnect").risk).toBe("medium");
    for (const id of ["agents.cloud.connect", "agents.cloud.cap", "agents.cloud.disconnect"]) expect(laneFor(id, {}), id).toEqual(["agents:cloud"]);
  });
});
