import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createCredentialStore } from "./credentials.mjs";
import { agentsConnectorSync } from "./tasks/agents.mjs";
import { httpRequest } from "./tasks/http-request.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function storeIn() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cred-"));
  directories.push(directory);
  const file = path.join(directory, "credentials.json");
  return { store: createCredentialStore({ file, now: () => new Date("2026-08-28T00:00:00Z") }), file };
}

describe("the credential store", () => {
  // Linux only: POSIX file modes.
  it.skipIf(onWindows)("saves under a name, lists names and dates only, reads the value, and removes", async () => {
    const { store, file } = await storeIn();
    await store.set({ name: "ntfy-token", value: "tk_secret" });
    expect(await store.listNames()).toEqual([{ name: "ntfy-token", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" }]);
    expect(await store.read("ntfy-token")).toBe("tk_secret");
    expect(await store.read("nothing")).toBeNull();
    // The file the value lives in is owner-only.
    expect(((await stat(file)).mode & 0o777)).toBe(0o600);
    // Listing never carries a value, whatever the caller does with it.
    expect(JSON.stringify(await store.listNames())).not.toContain("tk_secret");
    await store.remove({ name: "ntfy-token" });
    expect(await store.listNames()).toEqual([]);
    await expect(store.remove({ name: "ntfy-token" })).rejects.toThrow(/No credential is named/);
  });

  it("refuses bad names and oversized values", async () => {
    const { store } = await storeIn();
    await expect(store.set({ name: "Bad Name", value: "x" })).rejects.toThrow(/lowercase letters/);
    await expect(store.set({ name: "ok", value: "" })).rejects.toThrow(/1 to 4096/);
    await expect(store.set({ name: "ok", value: "y".repeat(4097) })).rejects.toThrow(/1 to 4096/);
  });

  // A value goes into one request header, and a header cannot carry a line break: Node's fetch
  // refused it with an error that quoted the value, and that error became the job's.
  it("refuses a value with a line break inside it, and drops one it ends with", async () => {
    const { store } = await storeIn();
    await expect(store.set({ name: "ok", value: "first-half\nsecond-half" })).rejects.toThrow(/line break/);
    await store.set({ name: "ok", value: "tk_pasted\n" });
    expect(await store.read("ok")).toBe("tk_pasted");
  });

  // The helper runs a Zulip connect and a heartbeat change side by side (different lanes), and each
  // read the file, changed its copy and put it back: the second one back lost the first one's key.
  it("keeps both of two saves made at once", async () => {
    const { store } = await storeIn();
    await Promise.all([store.set({ name: "zulip-bot", value: "key-one" }), store.set({ name: "heartbeat-url", value: "https://hc.example/abc" })]);
    expect((await store.listNames()).map((entry) => entry.name)).toEqual(["heartbeat-url", "zulip-bot"]);
  });

  it("refuses to save over a store it cannot read, rather than starting it again empty", async () => {
    const { store, file } = await storeIn();
    await store.set({ name: "kept", value: "tk_kept" });
    await writeFile(file, "{ damaged");
    await expect(store.set({ name: "new", value: "x" })).rejects.toThrow(/could not be read/);
    expect(await readFile(file, "utf8")).toBe("{ damaged");
  });
});

describe("a credential that cannot be a header", () => {
  const stored = { read: async () => "SENTINEL-first\nsecond" };

  it("is refused before the request, without quoting it", async () => {
    const outcome = await httpRequest({ url: "http://127.0.0.1:9/x", credentialName: "hook" }, { credentials: stored }).catch((error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).not.toMatch(/SENTINEL/);
    const custom = await httpRequest({ url: "http://127.0.0.1:9/x", credentialName: "hook", credentialHeader: "X-Api-Key", credentialPrefix: "" }, { credentials: stored }).catch((error) => error);
    expect(custom.message).not.toMatch(/SENTINEL/);
  });

  it("is refused by a connector sync the same way", async () => {
    const outcome = await agentsConnectorSync({ connector: "notion", credentialName: "notion" }, { credentials: stored, fetcher: fetch }).catch((error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).not.toMatch(/SENTINEL/);
  });
});

describe("the HTTP request task, against a real socket", () => {
  it("sends the method, body, and named credential header, and hands back status, excerpt, and JSON", async () => {
    const seen = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        seen.push({ method: request.method, authorization: request.headers.authorization, contentType: request.headers["content-type"], body });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ delivered: true, echo: body.length }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { store } = await storeIn();
    await store.set({ name: "hook", value: "tk_secret" });
    try {
      const result = await httpRequest(
        { url: `http://127.0.0.1:${port}/notify`, method: "POST", body: '{"title":"Backup done"}', credentialName: "hook" },
        { credentials: store },
      );
      expect(seen[0]).toMatchObject({ method: "POST", authorization: "Bearer tk_secret", contentType: "application/json" });
      expect(result).toMatchObject({ status: 200, ok: true, truncated: false });
      expect(result.json).toEqual({ delivered: true, echo: 23 });
      // The credential value has no path into the result later steps read.
      expect(JSON.stringify(result)).not.toContain("tk_secret");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses an unknown credential name before anything leaves this machine", async () => {
    const { store } = await storeIn();
    await expect(httpRequest({ url: "http://127.0.0.1:9/x", credentialName: "ghost" }, { credentials: store }))
      .rejects.toThrow(/No credential is named ghost/);
  });

  it("refuses the cloud metadata endpoint but allows loopback and LAN", async () => {
    const { store } = await storeIn();
    // Nothing legitimate lives on link-local; the owner's own ntfy on loopback is the point.
    await expect(httpRequest({ url: "http://169.254.169.254/latest/meta-data/" }, { credentials: store })).rejects.toThrow(/link-local metadata/);
    await expect(httpRequest({ url: "http://metadata.google.internal/x" }, { credentials: store })).rejects.toThrow(/link-local metadata/);
    // A loopback target is allowed (it connects, which is not-refused; here nothing listens).
    await expect(httpRequest({ url: "http://127.0.0.1:9/x" }, { credentials: store, timeoutMs: 500 })).rejects.toThrow(/failed|answer/);
  });

  it("does not follow a redirect while carrying a credential, so the token cannot leak cross-origin", async () => {
    const { store } = await storeIn();
    await store.set({ name: "hook", value: "tk_secret" });
    let followed = false;
    const fetcher = async (url, options) => {
      if (options.redirect === "manual") return { status: 302, ok: false, headers: new Map([["content-type", "text/plain"]]), body: null, text: async () => "moved" };
      followed = true; return { status: 200, ok: true, headers: new Map(), body: null, text: async () => "leaked" };
    };
    const result = await httpRequest({ url: "http://example.test/webhook", credentialName: "hook", credentialHeader: "X-Api-Key", credentialPrefix: "" }, { credentials: store, fetcher });
    expect(followed).toBe(false);            // the redirect was returned, not chased
    expect(result.status).toBe(302);
  });

  it("refuses non-http schemes and oversized inputs", async () => {
    const { store } = await storeIn();
    await expect(httpRequest({ url: "file:///etc/passwd" }, { credentials: store })).rejects.toThrow(/http\(s\)/);
    await expect(httpRequest({ url: "http://x/", method: "TRACE" }, { credentials: store })).rejects.toThrow(/method must be one of/);
    await expect(httpRequest({ url: "http://x/", body: "z".repeat(16385) }, { credentials: store })).rejects.toThrow(/16384/);
  });
});
