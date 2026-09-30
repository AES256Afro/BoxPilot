/**
 * Zulip in the catalog (M38): tailnet only by default, its address the Tailscale Serve one, every
 * image pinned, every secret generated and passed by reference, and nothing deployed without a
 * tailnet name to give it.
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createAppHelper } from "../app-helper.mjs";
import { publishedPorts, renderCompose, usesTailnetHost } from "./compose.mjs";
import { createCatalogService, loadCatalog } from "./index.mjs";
import { resolveValues, validateManifest } from "./schema.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function zulip() {
  const { manifests } = await loadCatalog();
  return manifests.find((manifest) => manifest.id === "zulip");
}
const ownerValues = { env: { SETTING_ZULIP_ADMINISTRATOR: "owner@example.com" } };

describe("the Zulip manifest", () => {
  it("is tailnet only by default, pins every image and generates every internal secret", async () => {
    const manifest = await zulip();
    expect(manifest).toBeTruthy();
    expect(manifest.defaultExposure).toBe("tailnet");
    expect(manifest.image.reference).toBe("ghcr.io/zulip/zulip-server:12.3-0");
    // No floating tag anywhere: zulip-postgresql is only published as "14", so it is pinned by digest.
    for (const image of [manifest.image.reference, ...manifest.sidecars.map((sidecar) => sidecar.image)]) {
      expect(image).not.toMatch(/:(latest|alpine|14)$/);
      expect(image).toMatch(/:[0-9][^:]*$|@sha256:[a-f0-9]{64}$/);
    }
    expect(manifest.sidecars.map((sidecar) => sidecar.id)).toEqual(["database", "memcached", "rabbitmq", "redis"]);
    const generated = manifest.env.filter((entry) => entry.generate).map((entry) => entry.name).sort();
    expect(generated).toEqual(["SECRETS_memcached_password", "SECRETS_postgres_password", "SECRETS_rabbitmq_password", "SECRETS_redis_password", "SECRETS_secret_key"]);
    // The mail password is the owner's to give, never made up.
    expect(manifest.env.find((entry) => entry.name === "SECRETS_email_password")).toMatchObject({ secret: true, generate: false, required: false });
    // Push notifications send data out of the server and accept Zulip's terms: off until the owner says.
    expect(manifest.env.find((entry) => entry.name === "SETTING_ZULIP_SERVICE_PUSH_NOTIFICATIONS")).toMatchObject({ type: "boolean", default: false, fixed: false });
    expect(manifest.env.find((entry) => entry.name === "SETTING_ZULIP_SERVICE_PUSH_NOTIFICATIONS").description).toContain("never registers for you");
    expect(manifest.env.find((entry) => entry.name === "SETTING_EMAIL_HOST").description).toMatch(/Without a mail server Zulip sends no email/);
    // The database and uploads are backed up; the cache, queue and Redis are not worth it.
    expect(manifest.volumes.find((volume) => volume.id === "data")).toMatchObject({ backup: true, container: "/data" });
    expect(manifest.sidecars.find((sidecar) => sidecar.id === "database").volumes[0]).toMatchObject({ container: "/var/lib/postgresql/data", backup: true });
    expect(manifest.sidecars.find((sidecar) => sidecar.id === "rabbitmq").volumes[0].backup).toBe(false);
    expect(manifest.sidecars.find((sidecar) => sidecar.id === "redis").volumes[0].backup).toBe(false);
    expect(manifest.health).toMatchObject({ kind: "healthcheck", timeoutSeconds: 900 });
    expect(manifest.actions).toEqual([expect.objectContaining({ id: "create-organization", label: "Create your organization", operation: "app.zulip.organization.link" })]);
  });

  it("uses a port none of the owner's server holds, and no other catalog app", async () => {
    const { manifests } = await loadCatalog();
    const manifest = manifests.find((entry) => entry.id === "zulip");
    const port = manifest.ports[0].host;
    // The owner's server (2026-09-29): Pi-hole, Nextcloud, ntfy, Jellyfin, NFS and the rest.
    const taken = [53, 67, 80, 443, 2049, 3000, 3001, 5001, 7359, 8084, 8093, 8096, 8115, 8134, 8920, 9443, 11434, 32400];
    expect(taken).not.toContain(port);
    const others = manifests.filter((entry) => entry.id !== "zulip").flatMap((entry) => entry.ports.map((candidate) => candidate.host));
    expect(others).not.toContain(port);
  });

  it("asks the owner for their email and nothing else", async () => {
    const manifest = await zulip();
    expect(resolveValues(manifest, {}).errors).toEqual(["values.env.SETTING_ZULIP_ADMINISTRATOR: is required"]);
    expect(resolveValues(manifest, ownerValues).errors).toEqual([]);
  });
});

describe("rendering Zulip", () => {
  it("names the Serve address as its external host and binds its web port to 127.0.0.1 only", async () => {
    const manifest = await zulip();
    const { values } = resolveValues(manifest, { ...ownerValues, exposure: "tailnet" });
    expect(usesTailnetHost(manifest, values)).toBe(true);
    const rendered = renderCompose(manifest, values, { lanAddress: "192.168.1.10", tailnetHost: "homebox.tail1234.ts.net" });
    const service = rendered.compose.services.zulip;
    expect(service.environment.SETTING_EXTERNAL_HOST).toBe("homebox.tail1234.ts.net:8543");
    // #323: a port Serve fronts is never published on every address.
    expect(service.ports).toEqual(["127.0.0.1:8543:80"]);
    expect(publishedPorts(rendered.composeYaml)).toEqual([{ service: "zulip", host: 8543, protocol: "tcp", bind: "127.0.0.1" }]);
    expect(rendered.hostPorts).toEqual([{ id: "web", host: 8543, protocol: "tcp", exposure: "loopback", tailnet: "serve" }]);
    // Zulip trusts forwarded HTTPS headers from Docker's gateway, where Serve's requests arrive.
    expect(service.environment.TRUST_GATEWAY_IP).toBe("True");
    expect(service.environment.AUTO_BACKUP_ENABLED).toBe("False");
    expect(service.depends_on).toEqual(["database", "memcached", "rabbitmq", "redis"]);
  });

  it("follows a port the owner changed, and an address the owner typed", async () => {
    const manifest = await zulip();
    const { values } = resolveValues(manifest, { ...ownerValues, exposure: "tailnet", ports: { web: 8544 } });
    expect(renderCompose(manifest, values, { tailnetHost: "homebox.tail1234.ts.net" }).compose.services.zulip.environment.SETTING_EXTERNAL_HOST).toBe("homebox.tail1234.ts.net:8544");
    const typed = resolveValues(manifest, { env: { ...ownerValues.env, SETTING_EXTERNAL_HOST: "chat.example.com" } }).values;
    expect(usesTailnetHost(manifest, typed)).toBe(false);
    expect(renderCompose(manifest, typed).compose.services.zulip.environment.SETTING_EXTERNAL_HOST).toBe("chat.example.com");
  });

  it("keeps every secret in .env and passes it to the sidecars by reference", async () => {
    const manifest = await zulip();
    const { values } = resolveValues(manifest, { ...ownerValues, exposure: "tailnet" });
    const rendered = renderCompose(manifest, values, { tailnetHost: "homebox.tail1234.ts.net" });
    const env = Object.fromEntries(rendered.envFile.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 2, -1)]));
    expect(Object.keys(env).sort()).toEqual(["SECRETS_memcached_password", "SECRETS_postgres_password", "SECRETS_rabbitmq_password", "SECRETS_redis_password", "SECRETS_secret_key"]);
    for (const value of Object.values(env)) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(rendered.composeYaml).not.toContain(value);
    }
    const parsed = YAML.parse(rendered.composeYaml);
    expect(parsed.services.zulip.environment.SECRETS_postgres_password).toBe("${SECRETS_postgres_password}");
    expect(parsed.services.database.environment.POSTGRES_PASSWORD).toBe("${SECRETS_postgres_password}");
    expect(parsed.services.memcached.environment.MEMCACHED_PASSWORD).toBe("${SECRETS_memcached_password}");
    expect(parsed.services.rabbitmq.environment.RABBITMQ_DEFAULT_PASS).toBe("${SECRETS_rabbitmq_password}");
    expect(parsed.services.redis.environment.REDIS_PASSWORD).toBe("${SECRETS_redis_password}");
    // The sidecars' own shell variables survive Compose's interpolation as $$.
    expect(parsed.services.redis.command.at(-1)).toContain('"$$REDIS_PASSWORD"');
    expect(parsed.services.rabbitmq.command.at(-1)).toContain("$$(RABBITMQ_DEFAULT_PASS)");
    // No mail server given: no mail password is passed at all.
    expect(parsed.services.zulip.environment.SECRETS_email_password).toBeUndefined();
    expect(parsed.services.zulip.environment.SETTING_EMAIL_HOST).toBeUndefined();
    // Nothing published but Zulip's own web port.
    for (const name of ["database", "memcached", "rabbitmq", "redis"]) expect(parsed.services[name].ports).toBeUndefined();
  });
});

describe("the schema around it", () => {
  const base = { schemaVersion: 2, id: "chat", name: "Chat", category: "Communication", description: "d", image: { reference: "example/chat:1" } };
  it("accepts a tailnet default and sheet actions, and refuses what it cannot keep", () => {
    expect(validateManifest({ ...base, defaultExposure: "tailnet", actions: [{ id: "invite", label: "Invite", operation: "app.chat.invite" }] }).errors).toEqual([]);
    expect(validateManifest({ ...base }).manifest).toMatchObject({ defaultExposure: "lan", actions: [] });
    expect(validateManifest({ ...base, defaultExposure: "loopback" }).errors).toEqual(["manifest.defaultExposure: must be one of lan, tailnet"]);
    expect(validateManifest({ ...base, defaultExposure: "tailnet", network: "host", risk: "medium" }).errors[0]).toMatch(/cannot be tailnet for a host-network app/);
    expect(validateManifest({ ...base, actions: [{ id: "Not A Slug", label: "X", operation: "not an id" }] }).errors).toEqual(["manifest.actions[0].id: must be a unique short slug", "manifest.actions[0].operation: must be a registered operation id"]);
    expect(validateManifest({ ...base, actions: [{ id: "one", label: "One", operation: "app.a.b", run: "rm -rf /" }] }).errors).toEqual(["manifest.actions[0].run: is not a recognised field"]);
  });
});

describe("installing Zulip", () => {
  async function helper({ dnsName = "homebox.tail1234.ts.net" } = {}) {
    const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-zulip-cat-")); directories.push(catalogDirectory);
    const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-zulip-root-")); directories.push(catalogRoot);
    await copyFile(path.join(import.meta.dirname, "..", "..", "catalog", "zulip.yaml"), path.join(catalogDirectory, "zulip.yaml"));
    const containers = new Map();
    const calls = [];
    const runDocker = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
      if (args[0] === "inspect") {
        const found = args.slice(3).map((name) => containers.get(name)).filter(Boolean);
        return found.length ? { ok: true, stdout: found.map((entry) => JSON.stringify(entry)).join("\n"), stderr: "" } : { ok: false, stdout: "", stderr: "No such object" };
      }
      if (args[0] === "ps") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "compose" && args.includes("up")) {
        for (const name of ["bp-zulip", "bp-zulip-database", "bp-zulip-memcached", "bp-zulip-rabbitmq", "bp-zulip-redis"]) containers.set(name, { running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:zulip", startedAt: "x", exitCode: 0 });
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "compose") return { ok: true, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    };
    const runCommand = async (_binary, args) => {
      if (args[0] === "status") return dnsName ? { ok: true, stdout: JSON.stringify({ Self: { DNSName: `${dnsName}.` } }), stderr: "" } : { ok: false, stdout: "", stderr: "not running" };
      if (args[0] === "ip") return dnsName ? { ok: true, stdout: "100.101.102.103\n", stderr: "" } : { ok: false, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    };
    let nowMs = Date.parse("2026-09-29T12:00:00.000Z");
    const apps = createAppHelper({ catalogRoot, runDocker, runCommand, catalog: createCatalogService({ directory: catalogDirectory, ttlMs: 0 }), wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), lanAddress: "192.168.1.10", chownDirectory: async () => {} });
    return { apps, calls, catalogRoot };
  }

  it("installs it for the tailnet only, at this server's tailnet name, unless the owner said otherwise", async () => {
    const { apps, catalogRoot } = await helper();
    const installed = await apps.install({ id: "zulip", values: ownerValues });
    expect(installed).toMatchObject({ installed: true, exposure: "tailnet", hostPorts: [{ id: "web", host: 8543, exposure: "loopback", tailnet: "serve" }] });
    const compose = YAML.parse(await readFile(path.join(catalogRoot, "zulip", "compose.yaml"), "utf8"));
    expect(compose.services.zulip.ports).toEqual(["127.0.0.1:8543:80"]);
    expect(compose.services.zulip.environment.SETTING_EXTERNAL_HOST).toBe("homebox.tail1234.ts.net:8543");
    // What is stored is the setting as written, so a renamed tailnet is followed at the next deploy.
    const state = JSON.parse(await readFile(path.join(catalogRoot, "zulip", "boxpilot.json"), "utf8"));
    expect(state.values.exposure).toBe("tailnet");
    expect(state.values.env.SETTING_EXTERNAL_HOST).toBe("${TAILNET_HOST}:${PORT_WEB}");
    expect(JSON.stringify(state)).not.toMatch(/SECRETS_/);
  });

  it("is refused before anything is written or started when Tailscale gives no name", async () => {
    const { apps, calls, catalogRoot } = await helper({ dnsName: null });
    await expect(apps.install({ id: "zulip", values: ownerValues })).rejects.toThrow(/Zulip is reached at this server's tailnet HTTPS address, and Tailscale did not say what that is .* or set Address people use to the address people use\. Nothing was changed\./);
    expect(calls.some((args) => args[0] === "compose" && args.includes("up"))).toBe(false);
    await expect(readFile(path.join(catalogRoot, "zulip", "compose.yaml"), "utf8")).rejects.toThrow();
  });

  it("goes on the home network when the owner chooses it, and needs no tailnet name at an address they typed", async () => {
    const { apps, catalogRoot } = await helper({ dnsName: null });
    const installed = await apps.install({ id: "zulip", values: { exposure: "lan", env: { ...ownerValues.env, SETTING_EXTERNAL_HOST: "chat.example.com" } } });
    expect(installed.exposure).toBe("lan");
    const compose = YAML.parse(await readFile(path.join(catalogRoot, "zulip", "compose.yaml"), "utf8"));
    expect(compose.services.zulip.ports).toEqual(["192.168.1.10:8543:80"]);
  });
});
