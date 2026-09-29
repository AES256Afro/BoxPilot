/**
 * The audit behind the Dockge port trap (2026-09-29): which apps can fall into Dockge's trap?
 *
 * Dockge was on the home network, published on every address (0.0.0.0:5001), and Tailscale Serve
 * published it on the tailnet at the same port, so tailscaled held 100.x.y.z:5001. On Linux the two
 * cannot both hold the port, and whichever bound second after a restart failed. Every other served
 * app on the owner's server was set to Tailnet only, which publishes on 127.0.0.1: two addresses,
 * no collision. These tests hold every catalog app to that: Tailnet only never publishes a web port
 * on every address, and serving an app that is on every address is refused rather than set up.
 */
import { describe, expect, it } from "vitest";
import { createCatalogService } from "./catalog/index.mjs";
import { publishedPorts, renderCompose } from "./catalog/compose.mjs";
import { appOperations } from "./ops/apps.mjs";
import { coversEveryAddress } from "./ports.mjs";

const serve = appOperations().find((operation) => operation.id === "app.serve.set");
const webPorts = (manifest) => manifest.ports.filter((port) => port.protocol === "tcp" && (port.tailnet ?? "serve") === "serve");
const defaults = (manifest, exposure) => ({ ports: Object.fromEntries(manifest.ports.map((port) => [port.id, port.host])), env: {}, volumes: {}, exposure });

describe("every catalog app, against Tailscale Serve at the same port", async () => {
  const { manifests } = await createCatalogService().all();
  const bridged = manifests.filter((manifest) => manifest.network !== "host" && webPorts(manifest).length);

  it("covers the whole catalog", () => {
    expect(manifests.length).toBeGreaterThan(100);
    expect(bridged.length).toBeGreaterThan(80);
  });

  it("publishes every web port on 127.0.0.1 when set to Tailnet only, which Serve reaches without colliding", () => {
    const trapped = [];
    for (const manifest of bridged) {
      const { composeYaml } = renderCompose(manifest, defaults(manifest, "tailnet"), { lanAddress: "0.0.0.0", tailnetAddress: "100.64.0.10" });
      const published = publishedPorts(composeYaml);
      for (const port of webPorts(manifest)) {
        const entry = published.find((candidate) => candidate.host === port.host && candidate.protocol === "tcp");
        if (!entry || entry.bind !== "127.0.0.1") trapped.push(`${manifest.id}:${port.host} binds ${entry?.bind ?? "nothing"}`);
      }
    }
    expect(trapped).toEqual([]);
  });

  it("refuses to serve any of them while it is on the home network, published on every address", async () => {
    // Reaching Tailscale at all means the refusal did not come first.
    const run = async () => { throw new Error("reached tailscale"); };
    const wrong = [];
    let refused = 0;
    for (const manifest of [...bridged, ...manifests.filter((entry) => entry.network === "host" && webPorts(entry).length)]) {
      const host = manifest.network === "host";
      const { composeYaml } = renderCompose(manifest, defaults(manifest, "lan"), { lanAddress: "0.0.0.0" });
      const web = webPorts(manifest)[0];
      const port = host ? web.container : web.host;
      const published = host
        ? manifest.ports.map((entry) => ({ id: entry.id, host: entry.container, protocol: entry.protocol, bind: "*", fixed: true, web: true, hostNetwork: true }))
        : publishedPorts(composeYaml).map((entry) => ({ host: entry.host, protocol: entry.protocol, bind: entry.bind }));
      // The trap is set exactly when the web port is on every address: on the home network, unless
      // the manifest keeps that port on loopback whatever the owner chooses (then Serve is how in).
      const trap = coversEveryAddress(published.find((entry) => entry.host === port && entry.protocol === "tcp")?.bind);
      expect(trap, manifest.id).toBe(host || web.exposure !== "loopback");
      const apps = { inspect: async () => ({ applications: [{ id: manifest.id, name: manifest.name, installed: true, urls: [{ id: web.id, host: port, exposure: web.exposure }], published }] }) };
      const outcome = await serve.run({ id: manifest.id, enabled: true }, { run, apps }).then(() => "served", (error) => error.message);
      const wasRefused = /Tailscale Serve would hold the same port on the tailnet address/.test(outcome);
      if (wasRefused !== trap) wrong.push(`${manifest.id}: ${trap ? "served" : "refused"} (${outcome})`);
      if (wasRefused) refused += 1;
    }
    expect(wrong).toEqual([]);
    expect(refused).toBeGreaterThan(50);
  });
});
