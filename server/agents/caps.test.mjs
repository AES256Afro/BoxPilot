// @vitest-environment node
/**
 * The runner's hard caps (M37) are in its unit file, where the kernel enforces them, and the Usage
 * panel shows them from caps.mjs. This keeps the two the same, and the unit's sandbox and network
 * as they must be. tests/ubuntu/agents-caps.sh proves on real systemd that the caps hold.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runnerCaps, runnerUnit, unitDirectives } from "./caps.mjs";

const unit = (await readFile(`deploy/${runnerUnit}`, "utf8")).replaceAll("\r\n", "\n");
const directives = (name) => [...unit.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1].trim());

describe("the agents runner's unit", () => {
  it("holds the caps caps.mjs describes, once each", () => {
    for (const [name, value] of Object.entries(unitDirectives(runnerCaps))) expect(directives(name), name).toEqual([value]);
    expect(runnerCaps.cpuQuotaPercent).toBeLessThanOrEqual(400);
    expect(runnerCaps.modelThreads).toBeLessThanOrEqual(runnerCaps.cpuQuotaPercent / 100);
  });

  it("reaches this machine only", () => {
    expect(directives("IPAddressDeny")).toEqual(["any"]);
    expect(directives("IPAddressAllow")).toEqual(["localhost"]);
  });

  it("runs as its own user, in a sandbox, with no capabilities", () => {
    expect(directives("User")).toEqual(["boxpilot-agents"]);
    for (const [name, value] of [["NoNewPrivileges", "true"], ["ProtectSystem", "strict"], ["ProtectHome", "true"], ["PrivateDevices", "true"], ["PrivateTmp", "true"], ["CapabilityBoundingSet", ""], ["AmbientCapabilities", ""], ["RestrictSUIDSGID", "true"], ["ProtectProc", "invisible"]]) {
      expect(directives(name), name).toEqual([value]);
    }
    expect(unit).not.toMatch(/^ReadWritePaths=/m);
  });

  it("gets its key from systemd, keeps the model server in its own cgroup, and starts the runner", () => {
    expect(directives("LoadCredential")).toEqual(["runner-token:/var/lib/boxpilot/agents/runner.token"]);
    expect(directives("KillMode")).toEqual(["control-group"]);
    expect(directives("ExecStart")).toEqual(["/usr/local/bin/node /opt/boxpilot/server/agents/runner-main.mjs"]);
  });

  it("is installed with the other units, never enabled by the installer, and restarted by an upgrade only when it runs", async () => {
    const install = (await readFile("scripts/boxpilot-install.sh", "utf8")).replaceAll("\r\n", "\n");
    const upgrade = (await readFile("scripts/boxpilot-upgrade.sh", "utf8")).replaceAll("\r\n", "\n");
    expect(install).not.toContain("boxpilot-agents");
    expect(upgrade).toContain('for unit in "${INSTALL_DIR}"/deploy/*.service');
    expect(upgrade.match(/systemctl (\S+) boxpilot-agents\.service/g)).toEqual(["systemctl try-restart boxpilot-agents.service", "systemctl try-restart boxpilot-agents.service"]);
  });
});
