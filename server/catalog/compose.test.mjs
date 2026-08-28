/**
 * Rendering an app's compose.yaml and .env.
 *
 * The values an owner types are data, not template source: these tests pin that a setting value
 * can never reach into another setting, and that a password survives storage exactly as typed.
 */
import { describe, expect, it } from "vitest";
import { envFileLine, renderCompose, securityOptFor } from "./compose.mjs";

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

describe("a port the app must know it listens on", () => {
  // qBittorrent refuses every request whose Host header carries a port other than its own
  // (a plain-text 401), and gluetun's firewall drops inbound connections it was not told about.
  // Both need the owner's chosen port, not the manifest's default.
  const tunneled = {
    id: "qbt", sha256: "x", image: { reference: "qbittorrent:5" }, network: "bridge", networkVia: "vpn",
    ports: [{ id: "web", label: "Web UI", container: 8080, host: 8095, protocol: "tcp", exposure: "lan", containerFollowsHost: true }],
    volumes: [], capabilities: [], devices: [], extraHosts: [], sysctls: [],
    env: [{ name: "WEBUI_PORT", default: "${PORT_WEB}", fixed: true }],
    sidecars: [{ id: "vpn", image: "gluetun:3", env: { FIREWALL_INPUT_PORTS: "${PORT_WEB}" }, volumes: [], capabilities: [], devices: [] }],
  };

  it("maps host to host, and hands the chosen port to app and sidecar env", () => {
    const values = { ports: { web: 9001 }, env: { WEBUI_PORT: "${PORT_WEB}" }, volumes: {} };
    const { compose } = renderCompose(tunneled, values, { lanAddress: "192.168.1.10" });
    expect(compose.services.vpn.ports).toEqual(["192.168.1.10:9001:9001"]);   // not :8080
    expect(compose.services.qbt.network_mode).toBe("service:vpn");
    expect(compose.services.qbt.environment.WEBUI_PORT).toBe("9001");
    expect(compose.services.vpn.environment.FIREWALL_INPUT_PORTS).toBe("9001");
  });

  it("without the flag the container port stays what the manifest says", () => {
    const plain = { ...tunneled, ports: [{ ...tunneled.ports[0], containerFollowsHost: undefined }] };
    const { compose } = renderCompose(plain, { ports: { web: 9001 }, env: {}, volumes: {} }, { lanAddress: "192.168.1.10" });
    expect(compose.services.vpn.ports).toEqual(["192.168.1.10:9001:8080"]);
  });
});

describe("host network mode", () => {
  const withSidecar = {
    id: "hole", sha256: "x", image: { reference: "pihole:6" }, network: "bridge", networkModes: ["bridge", "host"],
    ports: [{ id: "web", label: "Admin", container: 80, host: 8084, protocol: "tcp", exposure: "lan" }],
    volumes: [], env: [], capabilities: [], devices: [], extraHosts: [], sysctls: [],
    sidecars: [{ id: "unbound", image: "unbound:1", env: {}, volumes: [], capabilities: [], devices: [] }],
  };
  const values = { ports: { web: 8084 }, env: {}, volumes: {} };

  it("bridges by default: publishes ports and runs the sidecar", () => {
    const { compose } = renderCompose(withSidecar, values, { lanAddress: "192.168.1.10" });
    expect(compose.services.hole.ports).toEqual(["192.168.1.10:8084:80"]);
    expect(compose.services.hole.network_mode).toBeUndefined();
    expect(compose.services.unbound).toBeTruthy();
  });

  it("host mode shares the stack, publishes nothing, and drops the sidecar", () => {
    const { compose } = renderCompose(withSidecar, { ...values, networkMode: "host" }, { lanAddress: "192.168.1.10" });
    expect(compose.services.hole.network_mode).toBe("host");
    expect(compose.services.hole.ports).toBeUndefined();
    expect(compose.services.unbound).toBeUndefined();      // a sidecar has no network to live on
    expect(compose.services.hole.depends_on).toBeUndefined();
  });

  it("ignores a networkMode the manifest does not offer", () => {
    const fixed = { ...withSidecar, networkModes: ["bridge"] };
    const { compose } = renderCompose(fixed, { ...values, networkMode: "host" }, { lanAddress: "192.168.1.10" });
    expect(compose.services.hole.network_mode).toBeUndefined(); // stayed bridged
  });
});

describe("no-new-privileges and the ports an app cannot otherwise bind", () => {
  const piHole = { ports: [{ id: "dns", host: 53, protocol: "tcp" }, { id: "web", host: 8084, protocol: "tcp" }] };
  const jellyfin = { ports: [{ id: "web", host: 8096, protocol: "tcp" }] };

  it("keeps the flag everywhere it does not break the app", () => {
    expect(securityOptFor(piHole, false)).toEqual(["no-new-privileges:true"]);
    expect(securityOptFor(jellyfin, true)).toEqual(["no-new-privileges:true"]);
    expect(securityOptFor(jellyfin, false)).toEqual(["no-new-privileges:true"]);
    expect(securityOptFor({ ports: [] }, true)).toEqual(["no-new-privileges:true"]);
  });

  it("drops it only for a privileged port on the host's own network namespace", () => {
    // Pi-hole binds 53 as a non-root user using a file capability, which no-new-privileges refuses
    // to honour. In host mode that leaves a DNS server listening on nothing. In bridge mode it
    // never arises, because Docker allows any user to bind low ports inside a container's own
    // namespace, so the flag stays on there.
    expect(securityOptFor(piHole, true)).toEqual([]);
  });

  it("ignores a port that was never given a number", () => {
    expect(securityOptFor({ ports: [{ id: "x", host: null, protocol: "tcp" }] }, true)).toEqual(["no-new-privileges:true"]);
    expect(securityOptFor({ ports: [{ id: "x", host: 0, protocol: "tcp" }] }, true)).toEqual(["no-new-privileges:true"]);
  });
});

describe("sidecarEnvOverrides", () => {
  const tunneled = {
    id: "app", sha256: "x", image: { reference: "app:1" }, network: "bridge", networkModes: ["bridge"], networkVia: "vpn",
    ports: [{ id: "web", label: "UI", container: 8080, host: 8080, protocol: "tcp", exposure: "lan" }],
    volumes: [], env: [], capabilities: [], devices: [], extraHosts: [], sysctls: [],
    sidecars: [{ id: "vpn", image: "gluetun:1", env: { VPN_TYPE: "wireguard", FIREWALL_OUTBOUND_SUBNETS: "10.0.0.0/8" }, volumes: [], capabilities: [], devices: [] }],
  };
  const values = { ports: { web: 8080 }, env: {}, volumes: {} };

  it("adds and overrides sidecar env from the caller (the shared VPN profile's security options)", () => {
    const { compose } = renderCompose(tunneled, values, { lanAddress: "192.168.1.10", sidecarEnvOverrides: { vpn: { DOT: "on", BLOCK_ADS: "on", FIREWALL_OUTBOUND_SUBNETS: "192.168.1.0/24" } } });
    expect(compose.services.vpn.environment.DOT).toBe("on");
    expect(compose.services.vpn.environment.BLOCK_ADS).toBe("on");
    // the override wins over the manifest's own value
    expect(compose.services.vpn.environment.FIREWALL_OUTBOUND_SUBNETS).toBe("192.168.1.0/24");
    // untouched manifest env survives
    expect(compose.services.vpn.environment.VPN_TYPE).toBe("wireguard");
  });

  it("changes nothing when no overrides are given", () => {
    const { compose } = renderCompose(tunneled, values, { lanAddress: "192.168.1.10" });
    expect(compose.services.vpn.environment.FIREWALL_OUTBOUND_SUBNETS).toBe("10.0.0.0/8");
    expect(compose.services.vpn.environment.DOT).toBeUndefined();
  });
});
