/**
 * Rendering an app's compose.yaml and .env.
 *
 * The values an owner types are data, not template source: these tests pin that a setting value
 * can never reach into another setting, and that a password survives storage exactly as typed.
 */
import { describe, expect, it } from "vitest";
import { envFileLine, renderCompose } from "./compose.mjs";

describe("values the owner typed", () => {
  const manifest = {
    id: "probe", sha256: "x", image: { reference: "example/probe:1" }, network: "bridge", ports: [], volumes: [],
    env: [{ name: "GREETING", secret: false }, { name: "ADMIN_PASSWORD", secret: true }],
    capabilities: [], devices: [], extraHosts: [], sysctls: [], sidecars: [],
  };

  it("never lets a setting value interpolate another setting", () => {
    // Compose would otherwise replace this with the real password on its way to the container.
    const { composeYaml, envFile } = renderCompose(manifest, { env: { GREETING: "${ADMIN_PASSWORD} $HOME", ADMIN_PASSWORD: "s3cret" }, ports: {}, volumes: {} });
    expect(composeYaml).toContain("$${ADMIN_PASSWORD} $$HOME");
    expect(composeYaml).not.toContain("s3cret");
    expect(envFile).toBe("ADMIN_PASSWORD='s3cret'\n");
  });

  it("stores a secret containing a dollar sign or a quote exactly as typed", () => {
    const password = "pa$$w0rd ${NOPE} it's fine";
    const { envFile } = renderCompose(manifest, { env: { ADMIN_PASSWORD: password }, ports: {}, volumes: {} });
    expect(envFile).toBe("ADMIN_PASSWORD='pa$$w0rd ${NOPE} it\\'s fine'\n");
    // The reader is the inverse: what comes back out is what the owner typed.
    expect(envFileLine("ADMIN_PASSWORD", password)).toBe(envFile.trimEnd());
  });
});

describe("where an app's ports are published", () => {
  const manifest = {
    id: "dash", sha256: "x", image: { reference: "example/dash:1" }, network: "bridge",
    ports: [{ id: "web", label: "Web UI", container: 80, host: 3000, protocol: "tcp", exposure: "lan" }],
    volumes: [], env: [], capabilities: [], devices: [], extraHosts: [], sysctls: [], sidecars: [],
  };
  const values = { ports: { web: 3000 }, env: {}, volumes: {} };

  it("binds to the network address by default", () => {
    const { compose } = renderCompose(manifest, values, { lanAddress: "192.168.1.10" });
    expect(compose.services.dash.ports).toEqual(["192.168.1.10:3000:80"]);
  });

  it("binds to this server only when the owner chose tailnet", () => {
    // Not a firewall rule: the container stops listening on the network at all, so the only way
    // in is Tailscale Serve, which authenticates before the app sees anyone. Several apps in this
    // catalog have no login of their own.
    const { compose, hostPorts } = renderCompose(manifest, { ...values, exposure: "tailnet" }, { lanAddress: "192.168.1.10" });
    expect(compose.services.dash.ports).toEqual(["127.0.0.1:3000:80"]);
    expect(hostPorts[0].exposure).toBe("loopback");
  });

  it("leaves a manifest's own loopback port alone whatever the choice", () => {
    const loopbackManifest = { ...manifest, ports: [{ ...manifest.ports[0], exposure: "loopback" }] };
    const { compose } = renderCompose(loopbackManifest, { ...values, exposure: "lan" }, { lanAddress: "192.168.1.10" });
    expect(compose.services.dash.ports).toEqual(["127.0.0.1:3000:80"]);
  });

  // Tailscale Serve terminates HTTPS and proxies HTTP, so it can only front an app's web ports.
  // Sending the rest to loopback alongside them is what quietly broke Syncthing's sync, Forgejo's
  // git-over-SSH and Pi-hole's DNS while the operation still reported success.
  const mixed = {
    ...manifest,
    ports: [
      { id: "web", label: "Web UI", container: 8384, host: 8384, protocol: "tcp", exposure: "lan", tailnet: "serve" },
      { id: "sync", label: "Sync", container: 22000, host: 22000, protocol: "tcp", exposure: "lan", tailnet: "address" },
      { id: "dns", label: "DNS", container: 53, host: 53, protocol: "tcp", exposure: "lan", tailnet: "unchanged" },
      { id: "quic", label: "Sync (QUIC)", container: 22000, host: 22000, protocol: "udp", exposure: "lan", tailnet: "unchanged" },
    ],
  };
  const mixedValues = { ports: { web: 8384, sync: 22000, dns: 53, quic: 22000 }, env: {}, volumes: {} };

  it("sends each port where its own protocol can still be reached", () => {
    const { compose, hostPorts } = renderCompose(mixed, { ...mixedValues, exposure: "tailnet" }, { lanAddress: "192.168.1.10", tailnetAddress: "100.64.0.5" });
    expect(compose.services.dash.ports).toEqual([
      "127.0.0.1:8384:8384",   // Serve fronts the web UI
      "100.64.0.5:22000:22000", // reachable from the tailnet, and nowhere else
      "192.168.1.10:53:53",     // the house still needs to resolve names
      "192.168.1.10:22000:22000/udp",
    ]);
    expect(hostPorts.map((entry) => entry.exposure)).toEqual(["loopback", "tailnet", "lan", "lan"]);
  });

  it("leaves a port on the LAN rather than nowhere when there is no tailnet address", () => {
    // Tailscale absent or down. Taking the port away entirely would be worse than not moving it.
    const { compose } = renderCompose(mixed, { ...mixedValues, exposure: "tailnet" }, { lanAddress: "192.168.1.10", tailnetAddress: null });
    expect(compose.services.dash.ports[1]).toBe("192.168.1.10:22000:22000");
  });
});
