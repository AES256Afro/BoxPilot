import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCloudflaredConfig, parseProxyHostConfig, readHostedSources, readSmallFile, sourceLimits } from "./hosted-domains-sources.mjs";
import { onWindows } from "../test/platform.mjs";

const cloudflared = `tunnel: 6f0c2e9a-4b1d-4c7e-9a3f-2d5b8e1c0a47
credentials-file: /etc/cloudflared/6f0c2e9a.json
ingress:
  - hostname: news.example.com
    service: http://localhost:4321
  - hostname: "*.example.com"
    service: http://127.0.0.1:8080
  - hostname: Share.Example.com.
    service: http://127.0.0.1:3022
    originRequest:
      noTLSVerify: true
  - hostname: nothing.example.com
    service: http_status:404
  - service: http_status:404
`;

const proxyHost = `# ------------------------------------------------------------
# jellyfin.example.com
# ------------------------------------------------------------

server {
  set $forward_scheme http;
  set $server         "127.0.0.1";
  set $port           8096;

  listen 80;
  listen [::]:80;
  server_name jellyfin.example.com media.example.com;
  location / {
    proxy_pass       $forward_scheme://$server:$port$request_uri;
  }
}
`;

describe("the files that say where public names go (M42.2)", () => {
  it("reads a cloudflared config's ingress: one hostname to one service, lower-cased, wildcards marked, the catch-all left out", () => {
    const parsed = parseCloudflaredConfig(cloudflared);
    expect(parsed.tunnel).toBe("6f0c2e9a-4b1d-4c7e-9a3f-2d5b8e1c0a47");
    expect(parsed.ingress).toEqual([
      { hostname: "news.example.com", service: "http://localhost:4321", wildcard: false },
      { hostname: "*.example.com", service: "http://127.0.0.1:8080", wildcard: true },
      { hostname: "share.example.com", service: "http://127.0.0.1:3022", wildcard: false },
    ]);
  });

  it("gives nothing for a file that is not a cloudflared config, rather than an error", () => {
    expect(parseCloudflaredConfig("just: words")).toEqual({ tunnel: null, ingress: [] });
    expect(parseCloudflaredConfig("[not: yaml")).toEqual({ tunnel: null, ingress: [] });
    expect(parseCloudflaredConfig("ingress:\n  - hostname: 'not a name!'\n    service: http://x\n").ingress).toEqual([]);
    expect(parseCloudflaredConfig("")).toEqual({ tunnel: null, ingress: [] });
  });

  it("reads a proxy host's names and upstream, and leaves a host with no upstream nameless", () => {
    expect(parseProxyHostConfig(proxyHost)).toEqual({ hostnames: ["jellyfin.example.com", "media.example.com"], target: "http://127.0.0.1:8096" });
    expect(parseProxyHostConfig("server {\n  listen 80;\n  server_name old.example.com;\n  return 301 https://new.example.com$request_uri;\n}\n")).toEqual({ hostnames: ["old.example.com"], target: null });
    expect(parseProxyHostConfig("")).toEqual({ hostnames: [], target: null });
  });

  it("reads the files that exist and passes over the ones that do not", async () => {
    const files = {
      readFile: async (file) => {
        if (file === "/etc/cloudflared/config.yml") return cloudflared;
        if (file.endsWith("1.conf")) return proxyHost;
        if (file.endsWith("2.conf")) return "garbage";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      readdir: async (directory) => (directory === "/apps/nginx-proxy-manager/data/nginx/proxy_host" ? ["1.conf", "2.conf", "notes.txt"] : (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })()),
      realpath: async (target) => target,
    };
    const read = await readHostedSources({ cloudflaredFiles: ["/etc/cloudflared/config.yml", "/apps/cloudflared/config.yml"], proxyDirectories: ["/apps/nginx-proxy-manager/data/nginx/proxy_host", "/nowhere"], root: "/apps", files });
    expect(read.cloudflared).toHaveLength(1);
    expect(read.cloudflared[0]).toMatchObject({ file: "/etc/cloudflared/config.yml", ingress: expect.arrayContaining([expect.objectContaining({ hostname: "news.example.com" })]) });
    expect(read.proxyHosts).toEqual([{ file: "/apps/nginx-proxy-manager/data/nginx/proxy_host/1.conf", hostnames: ["jellyfin.example.com", "media.example.com"], target: "http://127.0.0.1:8096" }]);
  });

  it("keeps of a service only scheme, host and port, and of an upstream only a bare host", () => {
    const ingress = parseCloudflaredConfig("ingress:\n  - hostname: admin.example.com\n    service: http://user:secret@127.0.0.1:9000/admin/reset?confirm=1\n  - hostname: sock.example.com\n    service: unix:/run/app.sock\n  - hostname: hello.example.com\n    service: hello_world\n").ingress;
    expect(ingress).toEqual([{ hostname: "admin.example.com", service: "http://127.0.0.1:9000", wildcard: false }, { hostname: "sock.example.com", service: null, wildcard: false }, { hostname: "hello.example.com", service: null, wildcard: false }]);
    const site = (server, port = "9000") => parseProxyHostConfig(`server {\n  set $forward_scheme http;\n  set $server "${server}";\n  set $port ${port};\n  server_name x.example.com;\n}\n`);
    for (const server of ["127.0.0.1:9000/admin/reset?", "127.0.0.1/admin", "user@127.0.0.1", "127.0.0.1#x", "127.0.0.1?x", "a..b", "-x", "[::1]"]) expect(site(server), server).toEqual({ hostnames: ["x.example.com"], target: null });
    expect(site("127.0.0.1", "99999").target).toBeNull();
    expect(site("127.0.0.1").target).toBe("http://127.0.0.1:9000");
    expect(site("::1").target).toBe("http://[::1]:9000");
    expect(site("Jellyfin_app").target).toBe("http://jellyfin_app:9000");
    expect(site("media.internal.example").target).toBe("http://media.internal.example:9000");
  });

  it("takes a bounded number of names from one file, however many it lists", () => {
    const many = Array.from({ length: 50_000 }, (_, index) => `n${index}.example.com`);
    expect(parseProxyHostConfig(`server {\n  server_name ${many.join(" ")};\n}\n`).hostnames.length).toBeLessThanOrEqual(sourceLimits.namesPerFile);
    expect(parseProxyHostConfig(many.map((name) => `server_name ${name};`).join("\n")).hostnames).toHaveLength(sourceLimits.namesPerFile);
    expect(parseCloudflaredConfig(`ingress:\n${many.slice(0, 5000).map((name) => `  - hostname: ${name}\n    service: http://127.0.0.1:1\n`).join("")}`).ingress).toHaveLength(sourceLimits.namesPerFile);
  });
});

/** Real files, as an app's container could leave them in its own data folder for root to read. */
describe("reading files an app can write, as root", () => {
  const made = [];
  afterAll(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });
  const scratch = () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "boxpilot-hosted-sources-"));
    made.push(base);
    const root = path.join(base, "catalog");
    const sites = path.join(root, "nginx-proxy-manager", "data", "nginx", "proxy_host");
    mkdirSync(sites, { recursive: true });
    mkdirSync(path.join(root, "cloudflared"), { recursive: true });
    return { base, root, sites };
  };
  const siteFile = (...names) => `server {\n  set $forward_scheme http;\n  set $server "127.0.0.1";\n  set $port 8096;\n  server_name ${names.join(" ")};\n}\n`;

  it("reads a small regular file and nothing over the size limit", async () => {
    const { root, sites } = scratch();
    writeFileSync(path.join(sites, "1.conf"), siteFile("one.example.com"));
    writeFileSync(path.join(sites, "2.conf"), `${siteFile("big.example.com")}${"#".repeat(sourceLimits.fileBytes)}`);
    expect(await readSmallFile(path.join(sites, "1.conf"))).toContain("one.example.com");
    expect(await readSmallFile(path.join(sites, "2.conf"))).toBeNull();
    expect(await readSmallFile(path.join(sites, "1.conf"), { limit: 8 })).toBeNull();
    expect(await readSmallFile(path.join(sites, "missing.conf"))).toBeNull();
    expect(await readSmallFile(sites)).toBeNull();
    const read = await readHostedSources({ cloudflaredFiles: [], proxyDirectories: [sites], root });
    expect(read.proxyHosts.map((site) => site.hostnames)).toEqual([["one.example.com"]]);
    expect(read.proxyHosts[0].file).toBe(path.join(sites, "1.conf"));
  });

  // Needs symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("does not follow a link, whether the file is one or its folder leads out of the catalog", async () => {
    const { base, root, sites } = scratch();
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.conf"), siteFile("secret.example.com"));
    writeFileSync(path.join(outside, "config.yml"), "ingress:\n  - hostname: leaked.example.com\n    service: http://127.0.0.1:1\n");
    symlinkSync(path.join(outside, "secret.conf"), path.join(sites, "1.conf"));
    writeFileSync(path.join(sites, "2.conf"), siteFile("real.example.com"));
    symlinkSync(path.join(outside, "config.yml"), path.join(root, "cloudflared", "config.yml"));
    expect(await readSmallFile(path.join(sites, "1.conf"))).toBeNull();
    const read = await readHostedSources({ cloudflaredFiles: [path.join(root, "cloudflared", "config.yml")], proxyDirectories: [sites], root });
    expect(read).toEqual({ cloudflared: [], proxyHosts: [{ file: path.join(sites, "2.conf"), hostnames: ["real.example.com"], target: "http://127.0.0.1:8096" }] });
    // The site folder itself swapped for a link to somewhere else on the server, and the cloudflared folder too.
    const elsewhere = scratch();
    rmSync(elsewhere.sites, { recursive: true });
    symlinkSync(outside, elsewhere.sites);
    rmSync(path.join(elsewhere.root, "cloudflared"), { recursive: true });
    symlinkSync(outside, path.join(elsewhere.root, "cloudflared"));
    expect(await readHostedSources({ cloudflaredFiles: [path.join(elsewhere.root, "cloudflared", "config.yml")], proxyDirectories: [elsewhere.sites], root: elsewhere.root })).toEqual({ cloudflared: [], proxyHosts: [] });
  });

  // Needs mkfifo and a device file: a POSIX filesystem.
  it.skipIf(onWindows)("passes over a pipe and a device at once, rather than waiting on one or reading one without end", async () => {
    const { root, sites } = scratch();
    execFileSync("mkfifo", [path.join(sites, "1.conf")]);
    writeFileSync(path.join(sites, "2.conf"), siteFile("real.example.com"));
    const started = Date.now();
    expect(await readSmallFile(path.join(sites, "1.conf"))).toBeNull();
    expect(await readSmallFile("/dev/zero")).toBeNull();
    const read = await readHostedSources({ cloudflaredFiles: [], proxyDirectories: [sites], root });
    expect(read.proxyHosts.map((site) => site.hostnames)).toEqual([["real.example.com"]]);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 5000);

  it("stops at a bounded number of files and of names in all", async () => {
    const { root, sites } = scratch();
    writeFileSync(path.join(sites, "0000.conf"), `server {\n  server_name ${Array.from({ length: 50_000 }, (_, index) => `n${index}.example.com`).join(" ")};\n}\n`); // over the size limit
    for (let index = 1; index <= 40; index += 1) writeFileSync(path.join(sites, `${String(index).padStart(4, "0")}.conf`), siteFile(...Array.from({ length: 30 }, (_, name) => `s${index}-${name}.example.com`)));
    const read = await readHostedSources({ cloudflaredFiles: [], proxyDirectories: [sites], root });
    const names = read.proxyHosts.flatMap((site) => site.hostnames);
    expect(names).toHaveLength(sourceLimits.names);
    expect(names[0]).toBe("s1-0.example.com");
    const listed = [];
    const counting = { readFile: async (file) => { listed.push(file); return siteFile(); }, readdir: async () => Array.from({ length: 3000 }, (_, index) => `${index}.conf`), realpath: async (target) => target };
    await readHostedSources({ cloudflaredFiles: [], proxyDirectories: ["/apps/sites"], root: "/apps", files: counting });
    expect(listed).toHaveLength(sourceLimits.proxyFiles);
  });
});
