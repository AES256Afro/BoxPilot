import { describe, expect, it } from "vitest";
import { maxNamesPerFile, maxRulesPerFile, maxSourceBytes, parseCloudflaredConfig, parseProxyHostConfig, readHostedSources } from "./hosted-domains-sources.mjs";

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
    expect(parseCloudflaredConfig("just: words")).toEqual({ tunnel: null, ingress: [], cut: false });
    expect(parseCloudflaredConfig("[not: yaml")).toEqual({ tunnel: null, ingress: [], cut: false });
    expect(parseCloudflaredConfig("ingress:\n  - hostname: 'not a name!'\n    service: http://x\n").ingress).toEqual([]);
    expect(parseCloudflaredConfig("")).toEqual({ tunnel: null, ingress: [], cut: false });
  });

  it("reads a proxy host's names and upstream, and leaves a host with no upstream nameless", () => {
    expect(parseProxyHostConfig(proxyHost)).toEqual({ hostnames: ["jellyfin.example.com", "media.example.com"], target: "http://127.0.0.1:8096", cut: false });
    expect(parseProxyHostConfig("server {\n  listen 80;\n  server_name old.example.com;\n  return 301 https://new.example.com$request_uri;\n}\n")).toEqual({ hostnames: ["old.example.com"], target: null, cut: false });
    expect(parseProxyHostConfig("")).toEqual({ hostnames: [], target: null, cut: false });
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
    };
    const read = await readHostedSources({ cloudflaredFiles: ["/etc/cloudflared/config.yml", "/apps/cloudflared/config.yml"], proxyDirectories: ["/apps/nginx-proxy-manager/data/nginx/proxy_host", "/nowhere"], files });
    expect(read.cloudflared).toHaveLength(1);
    expect(read.cloudflared[0]).toMatchObject({ file: "/etc/cloudflared/config.yml", ingress: expect.arrayContaining([expect.objectContaining({ hostname: "news.example.com" })]) });
    expect(read.proxyHosts).toEqual([{ file: "/apps/nginx-proxy-manager/data/nginx/proxy_host/1.conf", hostnames: ["jellyfin.example.com", "media.example.com"], target: "http://127.0.0.1:8096", cut: false }]);
  });
});

/**
 * Per-file bounds (M53.2). The file count was capped and the contents of one file were not, so a
 * big enough configuration took the whole read past the 32 MiB helper reply cap and the page lost
 * every file-derived name to a message about bytes.
 */
describe("what one file may contribute", () => {
  it("cuts a server_name list at the cap and says it was cut", () => {
    const many = `server_name ${Array.from({ length: maxNamesPerFile + 50 }, (_value, index) => `h${index}.example.com`).join(" ")};`;
    const parsed = parseProxyHostConfig(many);
    expect(parsed.hostnames).toHaveLength(maxNamesPerFile);
    expect(parsed.cut).toBe(true);
  });

  it("says nothing was cut when the file fits", () => {
    const parsed = parseProxyHostConfig("server_name a.example.com b.example.com;\nset $server \"10.0.0.5\";\nset $port 8080;");
    expect(parsed.hostnames).toEqual(["a.example.com", "b.example.com"]);
    expect(parsed.cut).toBe(false);
  });

  it("cuts an ingress list at the cap and says it was cut", () => {
    const rules = Array.from({ length: maxRulesPerFile + 25 }, (_value, index) => `  - hostname: h${index}.example.com\n    service: http://localhost:80`).join("\n");
    const parsed = parseCloudflaredConfig(`ingress:\n${rules}\n`);
    expect(parsed.ingress).toHaveLength(maxRulesPerFile);
    expect(parsed.cut).toBe(true);
  });

  it("refuses to parse a file far larger than any real config, rather than spending the event loop on it", () => {
    const huge = `server_name a.example.com;\n${"# padding\n".repeat(maxSourceBytes / 5)}`;
    expect(huge.length).toBeGreaterThan(maxSourceBytes);
    expect(parseProxyHostConfig(huge)).toEqual({ hostnames: [], target: null, cut: true });
    expect(parseCloudflaredConfig(huge)).toEqual({ tunnel: null, ingress: [], cut: true });
  });
});
