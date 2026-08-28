import http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "./credentials.mjs";
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
  it("saves under a name, lists names and dates only, reads the value, and removes", async () => {
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

  it("refuses non-http schemes and oversized inputs", async () => {
    const { store } = await storeIn();
    await expect(httpRequest({ url: "file:///etc/passwd" }, { credentials: store })).rejects.toThrow(/http\(s\)/);
    await expect(httpRequest({ url: "http://x/", method: "TRACE" }, { credentials: store })).rejects.toThrow(/method must be one of/);
    await expect(httpRequest({ url: "http://x/", body: "z".repeat(16385) }, { credentials: store })).rejects.toThrow(/16384/);
  });
});
