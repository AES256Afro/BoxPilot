import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog } from "./index.mjs";
import { renderCompose, resolveDevices } from "./compose.mjs";
import { resolveValues, sanitizeStoredValues, validateManifest } from "./schema.mjs";

const base = { schemaVersion: 2, id: "demo", name: "Demo", category: "Test", description: "A demo", image: { reference: "nginx:1.27" } };
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("manifest schema", () => {
  it("accepts a minimal manifest and fills defaults", () => {
    const { manifest, errors } = validateManifest(base);
    expect(errors).toEqual([]);
    expect(manifest).toMatchObject({ id: "demo", risk: "medium", ports: [], volumes: [], env: [], health: { kind: "running", stableSeconds: 10 }, network: "bridge" });
  });

  it("rejects unknown fields, bad ids, bad images, and inconsistent volumes", () => {
    expect(validateManifest({ ...base, bogus: 1 }).errors).toContainEqual(expect.stringContaining("bogus"));
    expect(validateManifest({ ...base, id: "Bad Id" }).errors).toContainEqual(expect.stringContaining("manifest.id"));
    expect(validateManifest({ ...base, image: { reference: "nginx:1.27; rm -rf /" } }).errors).toContainEqual(expect.stringContaining("image.reference"));
    expect(validateManifest({ ...base, volumes: [{ id: "x", container: "/x", path: "data", hostPath: "/srv" }] }).errors).toContainEqual(expect.stringContaining("exactly one of"));
    expect(validateManifest({ ...base, volumes: [{ id: "x", container: "/x", path: "../etc" }] }).errors).toContainEqual(expect.stringContaining("simple relative"));
    // A lower-case name is fine — Tdarr genuinely reads `serverIP` — but it still has to look like
    // a variable, and a name may not appear twice.
    expect(validateManifest({ ...base, env: [{ name: "serverIP", default: "x" }] }).errors).toEqual([]);
    expect(validateManifest({ ...base, env: [{ name: "has-a-dash", default: "x" }] }).errors).toContainEqual(expect.stringContaining("env[0].name"));
    // signIn ties the card's "Sign in" panel to a real password entry and a real page.
    const withLogin = { ...base, ports: [{ id: "web", container: 80, host: 8084 }], env: [{ name: "ADMIN_PASSWORD", type: "password", generate: true }, { name: "ADMIN_USER", default: "admin" }] };
    expect(validateManifest({ ...withLogin, signIn: { path: "/admin/", passwordEnv: "ADMIN_PASSWORD", usernameEnv: "ADMIN_USER" } }).manifest.signIn).toEqual({ path: "/admin/", port: null, username: null, usernameEnv: "ADMIN_USER", passwordEnv: "ADMIN_PASSWORD", note: null });
    expect(validateManifest({ ...withLogin, signIn: { passwordEnv: "NOPE" } }).errors).toContainEqual(expect.stringContaining("signIn.passwordEnv"));
    expect(validateManifest({ ...withLogin, signIn: { passwordEnv: "ADMIN_USER" } }).errors).toContainEqual(expect.stringContaining("must name a password entry"));
    expect(validateManifest({ ...withLogin, signIn: { passwordEnv: "ADMIN_PASSWORD", path: "admin" } }).errors).toContainEqual(expect.stringContaining("signIn.path"));
    expect(validateManifest({ ...withLogin, signIn: { passwordEnv: "ADMIN_PASSWORD", port: "dns" } }).errors).toContainEqual(expect.stringContaining("signIn.port"));
    // networkModes: the attachment options the owner may pick between.
    expect(validateManifest({ ...base, networkModes: ["bridge", "host"] }).manifest.networkModes).toEqual(["bridge", "host"]);
    expect(validateManifest({ ...base }).manifest.networkModes).toEqual(["bridge"]); // default: fixed to its own network
    expect(validateManifest({ ...base, networkModes: ["host"] }).errors).toContainEqual(expect.stringContaining("must include the manifest's own network"));
    expect(validateManifest({ ...base, networkModes: ["bridge", "bridge"] }).errors).toContainEqual(expect.stringContaining("must not repeat"));
    expect(validateManifest({ ...base, networkModes: ["bridge", "macvlan"] }).errors).toContainEqual(expect.stringContaining("networkModes"));
    // resolveValues only accepts a mode the manifest offers.
    const modal = validateManifest({ ...base, networkModes: ["bridge", "host"] }).manifest;
    expect(resolveValues(modal, { networkMode: "host" }).values.networkMode).toBe("host");
    expect(resolveValues(modal, { networkMode: "macvlan" }).errors).toContainEqual(expect.stringContaining("values.networkMode"));
    expect(validateManifest({ ...base, env: [{ name: "TZ", default: "x" }, { name: "TZ", default: "y" }] }).errors).toContainEqual(expect.stringContaining("env[1].name"));
    expect(validateManifest({ ...base, capabilities: ["NET_ADMIN"] }).errors).toContainEqual(expect.stringContaining("CAP_"));
    expect(validateManifest({ ...base, schemaVersion: 1 }).errors).toContainEqual(expect.stringContaining("schemaVersion"));
  });

  it("resolves values with defaults and rejects bad input", () => {
    const { manifest } = validateManifest({ ...base, ports: [{ id: "web", container: 80, host: 8080 }, { id: "fixed", container: 53, host: 53, fixed: true }], volumes: [{ id: "media", container: "/media", hostPath: "/srv/media", configurable: true }], env: [{ name: "TZ", type: "timezone", default: "Etc/UTC" }, { name: "SECRET", type: "password", generate: true }, { name: "MODE", options: ["a", "b"], default: "a" }, { name: "NEEDED", required: true }] });
    expect(resolveValues(manifest, {}).errors).toContainEqual(expect.stringContaining("NEEDED"));
    const good = resolveValues(manifest, { ports: { web: 9090 }, env: { NEEDED: "yes", TZ: "America/Chicago" }, volumes: { media: "/mnt/media/" } });
    expect(good.errors).toEqual([]);
    expect(good.values).toEqual({ ports: { web: 9090, fixed: 53 }, env: { TZ: "America/Chicago", SECRET: "", MODE: "a", NEEDED: "yes" }, volumes: { media: "/mnt/media" } });
    expect(resolveValues(manifest, { ports: { fixed: 5353 }, env: { NEEDED: "y" } }).errors).toContainEqual(expect.stringContaining("fixed"));
    expect(resolveValues(manifest, { ports: { web: 53 }, env: { NEEDED: "y" } }).errors).toContainEqual(expect.stringContaining("collides"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", MODE: "z" } }).errors).toContainEqual(expect.stringContaining("one of"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", TZ: "not a tz!" } }).errors).toContainEqual(expect.stringContaining("Region/City"));
    expect(resolveValues(manifest, { env: { NEEDED: "y" }, volumes: { media: "/etc/ssl" } }).errors).toContainEqual(expect.stringContaining("protected"));
    expect(resolveValues(manifest, { env: { NEEDED: "y" }, volumes: { media: "/srv/../etc" } }).errors).toContainEqual(expect.stringContaining("clean"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", EXTRA: "1" } }).errors).toContainEqual(expect.stringContaining("EXTRA"));
  });

  it("renders compose with secrets only in .env and generates missing passwords", () => {
    const { manifest } = validateManifest({ ...base, ports: [{ id: "web", container: 80, host: 8080, exposure: "loopback" }, { id: "dns", container: 53, protocol: "udp" }], volumes: [{ id: "data", container: "/data", path: "data" }], env: [{ name: "ADMIN_PASSWORD", type: "password", generate: true }, { name: "TZ", default: "Etc/UTC" }], capabilities: ["CAP_NET_BIND_SERVICE"] });
    const values = resolveValues(manifest, {}).values;
    const first = renderCompose(manifest, values, { lanAddress: "192.168.1.10" });
    expect(first.composeYaml).toContain("127.0.0.1:8080:80");
    expect(first.composeYaml).toContain("192.168.1.10:53:53/udp");
    expect(first.composeYaml).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    expect(first.composeYaml).not.toContain(first.env.ADMIN_PASSWORD);
    expect(first.envFile).toMatch(/^ADMIN_PASSWORD='[A-Za-z0-9_-]{20,}'\n$/);
    expect(first.composeYaml).toContain("cap_drop:\n      - ALL");
    const second = renderCompose(manifest, values, { existingEnv: { ADMIN_PASSWORD: "keep-me" } });
    expect(second.env.ADMIN_PASSWORD).toBe("keep-me");
  });

  it("validates sidecars and renders them into the compose project", () => {
    const withSidecar = { ...base,
      env: [{ name: "APP_REDIS", default: "redis://broker:6379", fixed: true }, { name: "SECRET", type: "password", generate: true }],
      volumes: [{ id: "data", container: "/data", path: "data" }],
      sidecars: [{ id: "broker", image: "redis:8.8.2-alpine", env: { REDIS_EXTRA: "${SECRET}" }, volumes: [{ id: "redisdata", container: "/data", path: "redis-data" }] }],
    };
    const { manifest, errors } = validateManifest(withSidecar);
    expect(errors).toEqual([]);
    const { values } = resolveValues(manifest, {});
    const rendered = renderCompose(manifest, values, {});
    expect(rendered.compose.services.broker).toMatchObject({ container_name: "bp-demo-broker", image: "redis:8.8.2-alpine", volumes: ["./redis-data:/data"] });
    expect(rendered.compose.services.demo.depends_on).toEqual(["broker"]);
    expect(rendered.composeYaml).toContain("REDIS_EXTRA: ${SECRET}"); // interpolated by compose from .env, never inlined

    expect(validateManifest({ ...withSidecar, sidecars: [{ id: "demo", image: "redis:8" }] }).errors).toContainEqual(expect.stringContaining("distinct from the app id"));
    expect(validateManifest({ ...withSidecar, sidecars: [{ id: "broker", image: "redis:8", volumes: [{ id: "x", container: "/x", path: "data" }] }] }).errors).toContainEqual(expect.stringContaining("unique relative directory"));
    expect(validateManifest({ ...withSidecar, network: "host" }).errors).toContainEqual(expect.stringContaining("host-network"));
    expect(validateManifest({ ...withSidecar, sidecars: [{ id: "broker", image: "not a ref!" }] }).errors).toContainEqual(expect.stringContaining("image reference"));
  });

  it("sanitizes stored values down to what the manifest accepts today", () => {
    const { manifest } = validateManifest({ ...base,
      ports: [{ id: "web", container: 80, host: 8080 }],
      env: [{ name: "TZ", default: "Etc/UTC" }],
      volumes: [{ id: "media", container: "/media", hostPath: "/srv/media", configurable: true }, { id: "docker", container: "/var/run/docker.sock", hostPath: "/var/run/docker.sock" }],
    });
    const stored = { ports: { web: 9090, gone: 1 }, env: { TZ: "Europe/Berlin", REMOVED: "x" }, volumes: { media: "/srv/movies", docker: "/var/run/docker.sock" } };
    expect(sanitizeStoredValues(manifest, stored)).toEqual({ ports: { web: 9090 }, env: { TZ: "Europe/Berlin" }, volumes: { media: "/srv/movies" } });
    expect(resolveValues(manifest, sanitizeStoredValues(manifest, stored)).errors).toEqual([]);
    expect(sanitizeStoredValues(manifest, null)).toEqual({ ports: {}, env: {}, volumes: {} });
  });
});

describe("catalog loader", () => {
  it("loads valid manifests, reports invalid ones, and enforces id = file name", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-catalog-")); directories.push(directory);
    await writeFile(path.join(directory, "good.yaml"), "schemaVersion: 2\nid: good\nname: Good\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1\n");
    await writeFile(path.join(directory, "bad.yaml"), "schemaVersion: 2\nid: bad\nname: Bad\n");
    await writeFile(path.join(directory, "mismatch.yaml"), "schemaVersion: 2\nid: other\nname: O\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1\n");
    await writeFile(path.join(directory, "broken.yaml"), "schemaVersion: [2\n");
    const { manifests, problems } = await loadCatalog({ directory });
    expect(manifests.map((manifest) => manifest.id)).toEqual(["good"]);
    expect(manifests[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(problems.map((problem) => problem.file).sort()).toEqual(["bad.yaml", "broken.yaml", "mismatch.yaml"]);
  });

  it("ships a valid built-in catalog", async () => {
    const { manifests, problems } = await loadCatalog();
    expect(problems).toEqual([]);
    expect(manifests.map((manifest) => manifest.id)).toEqual(expect.arrayContaining(["jellyfin", "homepage", "portainer"]));
    for (const manifest of manifests) {
      // Every shipped manifest installs with defaults, except fields it declares required (an agent key).
      const required = manifest.env.filter((entry) => entry.required).map((entry) => `values.env.${entry.name}: is required`);
      expect(resolveValues(manifest, {}).errors.filter((error) => !required.includes(error))).toEqual([]);
    }
  });
});

describe("setup choices", () => {
  const base = { schemaVersion: 2, id: "lists", name: "Lists", category: "DNS", description: "d", image: { reference: "x/y:1" } };
  const setup = { title: "Blocklists", finalize: ["pihole", "-g"], choices: [
    { id: "big", label: "Big", recommended: true, website: "https://example.com", exec: ["sh", "-c", "echo big"] },
    { id: "small", label: "Small", exec: ["sh", "-c", "echo small"] },
  ] };

  it("validates the setup block strictly and normalizes it", () => {
    const { manifest, errors } = validateManifest({ ...base, setup });
    expect(errors).toEqual([]);
    expect(manifest.setup).toMatchObject({ title: "Blocklists", finalize: ["pihole", "-g"], note: null, choices: [{ id: "big", recommended: true, website: "https://example.com" }, { id: "small", recommended: false, website: null }] });
    expect(validateManifest(base).manifest.setup).toBeNull();
    expect(validateManifest({ ...base, setup: { title: "T", choices: [{ id: "a", label: "A", exec: [] }] } }).errors).toContainEqual(expect.stringContaining("exec"));
    expect(validateManifest({ ...base, setup: { title: "T", choices: [{ id: "a", label: "A", exec: ["x"] }, { id: "a", label: "B", exec: ["y"] }] } }).errors).toContainEqual(expect.stringContaining("unique"));
    expect(validateManifest({ ...base, setup: { title: "T", choices: [{ id: "a", label: "A", exec: ["x"], website: "http://insecure" }] } }).errors).toContainEqual(expect.stringContaining("https"));
    expect(validateManifest({ ...base, setup: { title: "T", choices: [], bogus: 1 } }).errors).toContainEqual(expect.stringContaining("bogus"));
  });

  it("defaults to the recommended choices, rejects unknown ids, and keeps stored ids the manifest still has", () => {
    const { manifest } = validateManifest({ ...base, setup });
    expect(resolveValues(manifest, {}).values.setup).toEqual(["big"]);
    expect(resolveValues(manifest, { setup: [] }).values.setup).toEqual([]);
    expect(resolveValues(manifest, { setup: ["small", "small"] }).values.setup).toEqual(["small"]);
    expect(resolveValues(manifest, { setup: ["huge"] }).errors).toContainEqual(expect.stringContaining("huge"));
    expect(resolveValues(manifest, { setup: "big" }).errors).toContainEqual(expect.stringContaining("list"));
    const plain = validateManifest(base).manifest;
    expect(resolveValues(plain, { setup: ["big"] }).errors).toContainEqual(expect.stringContaining("no setup choices"));
    expect(resolveValues(plain, {}).values).not.toHaveProperty("setup");
    expect(sanitizeStoredValues(manifest, { setup: ["big", "gone"] }).setup).toEqual(["big"]);
    expect(sanitizeStoredValues(plain, { setup: ["big"] })).not.toHaveProperty("setup");
  });
});

describe("device globs", () => {
  it("accepts globs in manifests and resolves them against the host", async () => {
    const base = { schemaVersion: 2, id: "smart", name: "Smart", category: "Disks", description: "d", image: { reference: "x/y:1" } };
    expect(validateManifest({ ...base, devices: ["/dev/sd?", "/dev/nvme?", "/dev/ttyUSB0"] }).errors).toEqual([]);
    expect(validateManifest({ ...base, devices: ["/etc/passwd"] }).errors).toContainEqual(expect.stringContaining("devices"));
    const listDirectory = async (directory) => (directory === "/dev" ? ["nvme0", "nvme0n1", "nvme0n1p1", "sda", "sdb", "sda1", "tty", "zero"] : []);
    expect(await resolveDevices(["/dev/sd?", "/dev/nvme?", "/dev/ttyUSB0", "/dev/hd?"], listDirectory)).toEqual(["/dev/sda", "/dev/sdb", "/dev/nvme0", "/dev/ttyUSB0"]);
    expect(await resolveDevices(["/dev/nvme*"], listDirectory)).toEqual(["/dev/nvme0", "/dev/nvme0n1", "/dev/nvme0n1p1"]);
    expect(await resolveDevices(["/dev/*/by-id"], listDirectory)).toEqual([]);
    // A GPU render node is an accelerator, not what the app is for: it is declared optional, and
    // a server without one still installs the app.
    const gpu = validateManifest({ ...base, optionalDevices: ["/dev/dri/renderD*"] });
    expect(gpu.errors).toEqual([]);
    expect(gpu.manifest.optionalDevices).toEqual(["/dev/dri/renderD*"]);
    expect(validateManifest({ ...base, optionalDevices: ["renderD128"] }).errors).toContainEqual(expect.stringContaining("optionalDevices"));
    const { manifest } = validateManifest({ ...base, devices: ["/dev/sd?"] });
    const { compose } = renderCompose(manifest, { ports: {}, env: {}, volumes: {} }, { devices: ["/dev/sda"] });
    expect(compose.services.smart.devices).toEqual(["/dev/sda:/dev/sda"]);
  });
});

describe("networkVia and sidecar targets", () => {
  const base = { schemaVersion: 2, id: "dl", name: "DL", category: "Media", description: "d", image: { reference: "x/dl:1" }, ports: [{ id: "web", container: 8080, host: 8080 }] };
  it("routes the app through a VPN sidecar and publishes its ports there", () => {
    const { manifest, errors } = validateManifest({ ...base, networkVia: "vpn", sidecars: [{ id: "vpn", image: "q/gluetun:1", capabilities: ["CAP_NET_ADMIN"], devices: ["/dev/net/tun"], env: { VPN_SERVICE_PROVIDER: "mullvad" } }] });
    expect(errors).toEqual([]);
    const { compose } = renderCompose(manifest, { ports: { web: 8080 }, env: {}, volumes: {} }, { lanAddress: "192.168.1.10" });
    expect(compose.services.dl.network_mode).toBe("service:vpn");
    expect(compose.services.dl.ports).toBeUndefined();
    expect(compose.services.vpn).toMatchObject({ ports: ["192.168.1.10:8080:8080"], cap_drop: ["ALL"], cap_add: ["CAP_NET_ADMIN"], devices: ["/dev/net/tun:/dev/net/tun"] });
    expect(compose.services.dl.depends_on).toEqual(["vpn"]);
    expect(validateManifest({ ...base, networkVia: "nope" }).errors).toContainEqual(expect.stringContaining("networkVia"));
    expect(validateManifest({ ...base, network: "host", networkVia: "vpn", sidecars: [{ id: "vpn", image: "q/g:1" }] }).errors).toContainEqual(expect.stringContaining("host networking"));
    expect(validateManifest({ ...base, sidecars: [{ id: "vpn", image: "q/g:1", capabilities: ["net_admin"] }] }).errors).toContainEqual(expect.stringContaining("CAP_NET_ADMIN"));
  });

  it("substitutes plain app settings into sidecar env and keeps secrets as .env references", () => {
    const { manifest } = validateManifest({ ...base, env: [{ name: "PROVIDER", default: "mullvad" }, { name: "KEY", type: "password", generate: true }], sidecars: [{ id: "vpn", image: "q/g:1", env: { VPN_SERVICE_PROVIDER: "${PROVIDER}", WIREGUARD_PRIVATE_KEY: "${KEY}", MISSING: "${NOPE}", FIXED: "x" } }] });
    const { compose } = renderCompose(manifest, { ports: { web: 8080 }, env: { PROVIDER: "protonvpn" }, volumes: {} });
    expect(compose.services.vpn.environment).toEqual({ VPN_SERVICE_PROVIDER: "protonvpn", WIREGUARD_PRIVATE_KEY: "${KEY}", MISSING: "", FIXED: "x" });
  });

  it("renders net.* sysctls and rejects anything else", () => {
    const { manifest, errors } = validateManifest({ ...base, sysctls: ["net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1"] });
    expect(errors).toEqual([]);
    expect(renderCompose(manifest, { ports: { web: 8080 }, env: {}, volumes: {} }).compose.services.dl.sysctls).toEqual({ "net.ipv4.ip_forward": "1", "net.ipv4.conf.all.src_valid_mark": "1" });
    expect(validateManifest({ ...base, sysctls: ["kernel.shmmax=1"] }).errors).toContainEqual(expect.stringContaining("sysctls"));
  });

  it("lets a setup choice run inside a sidecar", () => {
    const { manifest, errors } = validateManifest({ ...base, sidecars: [{ id: "ollama", image: "o/o:1" }], setup: { title: "Models", choices: [{ id: "llama", label: "Llama", exec: ["ollama", "pull", "llama3.2"], service: "ollama" }] } });
    expect(errors).toEqual([]);
    expect(manifest.setup.choices[0].service).toBe("ollama");
    expect(validateManifest({ ...base, setup: { title: "Models", choices: [{ id: "llama", label: "Llama", exec: ["x"], service: "missing" }] } }).errors).toContainEqual(expect.stringContaining("service"));
  });
});
