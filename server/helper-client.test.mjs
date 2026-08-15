import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createHelperClient } from "./helper-client.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async ({ server, directory }) => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("restricted helper client", () => {
  test("keeps the request socket open for a delayed operation response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-helper-client-"));
    const socketPath = path.join(directory, "helper.sock");
    const server = net.createServer((connection) => {
      connection.setEncoding("utf8");
      let payload = "";
      connection.on("data", (chunk) => {
        payload += chunk;
        if (!payload.includes("\n")) return;
        const request = JSON.parse(payload.slice(0, payload.indexOf("\n")));
        setTimeout(() => {
          connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { delayed: true } })}\n`);
        }, 25);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanup.push({ server, directory });

    const client = createHelperClient({ socketPath, timeoutMs: 1000 });

    await expect(client.request("canary.verify", {})).resolves.toEqual({ delayed: true });
  });
});
