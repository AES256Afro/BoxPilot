/**
 * Reading Docker's own view of the box.
 *
 * Health is the part callers act on — a failing health check should reach the owner's phone — and
 * docker only reports it inside the free-text status, so this pins that it is pulled back out.
 */
import { describe, expect, it, vi } from "vitest";
import { createHostInspectHelper } from "./host-inspect-helper.mjs";

describe("container health", () => {
  it("reads health out of the status text docker actually prints", async () => {
    const docker = vi.fn(async (args) => {
      if (args[0] === "ps") {
        return { ok: true, stdout: [
          JSON.stringify({ ID: "aaaaaaaaaaaa", Names: "bp-jellyfin", Image: "jellyfin:1", State: "running", Status: "Up 2 hours (healthy)" }),
          JSON.stringify({ ID: "bbbbbbbbbbbb", Names: "bp-kuma", Image: "kuma:1", State: "running", Status: "Up 5 minutes (unhealthy)" }),
          JSON.stringify({ ID: "cccccccccccc", Names: "bp-ntfy", Image: "ntfy:1", State: "running", Status: "Up 3 days" }),
          JSON.stringify({ ID: "dddddddddddd", Names: "bp-new", Image: "new:1", State: "running", Status: "Up 4 seconds (health: starting)" }),
        ].join("\n"), stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const helper = createHostInspectHelper({ run: async (_binary, args, options) => docker(args, options) });
    const result = await helper.inventoryDocker();
    expect(result.containers.map((container) => [container.name, container.health])).toEqual([
      ["bp-jellyfin", "healthy"], ["bp-kuma", "unhealthy"], ["bp-ntfy", "none"], ["bp-new", "starting"],
    ]);
  });

  it("keeps the labels that say who owns a container", async () => {
    const run = async (_binary, args) => ({ ok: true, stderr: "", stdout: args[0] === "ps" ? [
      JSON.stringify({ ID: "a", Names: "bp-ollama", State: "running", Status: "Up", Labels: "com.docker.compose.project=bp-ollama,io.boxpilot.app=ollama,com.docker.compose.service=ollama" }),
      JSON.stringify({ ID: "b", Names: "llmcoach-ollama-1", State: "running", Status: "Up", Labels: "com.docker.compose.service=ollama,com.docker.compose.project=llmcoach" }),
      JSON.stringify({ ID: "c", Names: "adhoc", State: "running", Status: "Up", Labels: "" }),
    ].join("\n") : "" });
    const result = await createHostInspectHelper({ run }).inventoryDocker();
    expect(result.containers.map((c) => [c.name, c.app, c.composeProject])).toEqual([
      ["bp-ollama", "ollama", "bp-ollama"], ["llmcoach-ollama-1", null, "llmcoach"], ["adhoc", null, null],
    ]);
  });
});
