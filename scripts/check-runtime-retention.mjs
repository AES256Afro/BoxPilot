/** Local-only churn test. Uses temporary sockets and synthetic identities, never an installed host. */
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { createEmbeddingCache, createKnowledgeIndex, embeddingCacheLimits } from "../server/assistant/knowledge.mjs";
import { createCatalogService } from "../server/catalog/index.mjs";
import { createEventStream, createStreamBudget } from "../server/event-stream.mjs";
import { createHelperClient } from "../server/helper-client.mjs";
import { createLoginThrottle } from "../server/login-throttle.mjs";
import { createOidcService } from "../server/oidc.mjs";
import { registry } from "../server/ops/index.mjs";

if (typeof globalThis.gc !== "function") throw new Error("Run with node --expose-gc scripts/check-runtime-retention.mjs");
const option = (name, fallback, max) => {
  const position = process.argv.indexOf(name);
  const value = position < 0 ? fallback : Number(process.argv[position + 1]);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const batches = option("--batches", 12, 100);
const iterations = option("--iterations", 250, 10_000);
const directory = await mkdtemp(path.join(os.tmpdir(), "bp-retention-"));
const socketPath = path.join(directory, "h.sock");
const connections = new Set();
const text = "synthetic job output ".repeat(1600);
let helperRequests = 0;
const helperServer = net.createServer((connection) => {
  connections.add(connection);
  connection.once("close", () => connections.delete(connection));
  connection.on("error", () => connection.destroy());
  let input = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input); input = "";
    helperRequests += 1;
    connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { text } })}\n`);
  });
});
const streamBudget = createStreamBudget();
let streamClosures = 0;
const webServer = http.createServer((_request, response) => {
  const release = streamBudget.acquire("synthetic-owner");
  if (!release) { response.writeHead(429).end(); return; }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const stream = createEventStream(response);
  stream.onClose(() => { release(); streamClosures += 1; });
  stream.send("output", { text });
  stream.end();
});
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const client = { id: "synthetic-app", redirectUris: ["https://example.invalid/callback"] };
const owner = { id: "synthetic-owner", username: "synthetic", role: "owner" };
const oidc = createOidcService({
  store: { getOidcClient: (id) => id === client.id ? client : null, findOwnerById: (id) => id === owner.id ? owner : null },
  keys: { privateKey: pair.privateKey, publicKey: createPublicKey(pair.privateKey), kid: "synthetic" },
});
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
let clock = 0;
const throttle = createLoginThrottle({ maxEntries: 64, now: () => clock });
const samples = [];
const resources = () => (process.getActiveResourcesInfo?.() ?? []).reduce((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
async function settleAndCollect() {
  await delay(25); await immediate();
  for (let count = 0; count < 3; count += 1) { globalThis.gc(); await immediate(); }
}
try {
  await new Promise((resolve) => helperServer.listen(socketPath, resolve));
  await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const helper = createHelperClient({ socketPath });
  const port = webServer.address().port;
  // The assistant's index of BoxPilot's own documents, registry and catalog (M34.1) is held for the
  // life of the process once built. Measured on its own, over the real corpus, against a budget.
  const catalog = createCatalogService();
  await catalog.all();
  await settleAndCollect();
  const beforeIndex = process.memoryUsage().heapUsed;
  const knowledge = createKnowledgeIndex({ registry, catalog });
  const indexStats = await knowledge.ensure();
  await settleAndCollect();
  const indexRetainedBytes = process.memoryUsage().heapUsed - beforeIndex;
  // The corpus is this repository's documents, which grow every milestone (752 chunks and 2.8 MiB on
  // 2026-09-28, 951 chunks and 4.0 MiB a day later, about 6.7 bytes a character indexed), so the
  // budget is 8 bytes a character: a representation that bloats fails (the postings arrays this
  // replaced kept 2.6 times as much), more documentation does not, up to 8 MiB, where it is time to
  // look again. Never under the 4 MiB it started as.
  const indexBudget = Math.min(8 * 1024 * 1024, Math.max(4 * 1024 * 1024, 8 * (indexStats.characters ?? 0)));
  // Its embedding cache, churned with a 4,096-wide model's vectors under three model names, which
  // is what switching embedding models does: bounded in entries and in bytes whatever the width.
  const embeddings = createEmbeddingCache();
  const wideVector = Array.from({ length: 4096 }, (_, index) => (index % 13) - 6);
  let embedded = 0;
  async function streamOnce(abort) {
    await new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, agent: false }, (response) => {
        assert.equal(response.statusCode, 200);
        response.on("data", () => { if (abort) response.destroy(); });
        response.once("end", resolve); response.once("close", resolve);
        response.on("error", (error) => { if (!abort) reject(error); });
      });
      request.on("error", reject);
    });
  }
  for (let batch = -2; batch < batches; batch += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const before = helperRequests;
      const [first, second] = await Promise.all([helper.request("app.inspect"), helper.request("app.inspect")]);
      assert.equal(first.text.length, text.length); assert.equal(second.text.length, text.length);
      assert.equal(helperRequests - before, 1);
      await streamOnce(iteration % 4 === 0);
      const code = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: client.redirectUris[0], codeChallenge: challenge, scope: "openid" });
      oidc.exchangeCode({ code, codeVerifier: verifier, clientId: client.id, redirectUri: client.redirectUris[0], issuer: "https://example.invalid" });
      clock += 1000;
      throttle.record([`caller-${batch}-${iteration}`], false);
      for (let count = 0; count < 4; count += 1, embedded += 1) embeddings.set(`model-${embedded % 3}`, `chunk-${embedded}`, wideVector);
      assert.ok(knowledge.search("where did the disk space go").length > 0);
    }
    await settleAndCollect();
    assert.equal(helper.diagnostics().active, 0);
    assert.equal(connections.size, 0);
    assert.equal(streamBudget.stats().active, 0);
    assert.equal(oidc.internals.pendingCodeCount(), 0);
    assert.ok(throttle.size() <= 64);
    assert.ok(embeddings.size <= embeddingCacheLimits.maxEntries && embeddings.bytes <= embeddingCacheLimits.maxBytes, `embedding cache ${embeddings.size} entries, ${embeddings.bytes} bytes`);
    if (batch >= 0) samples.push({ batch, ...process.memoryUsage(), resources: resources() });
  }
  const growth = samples.at(-1).heapUsed - samples[0].heapUsed;
  const peakGrowth = Math.max(...samples.map((sample) => sample.heapUsed)) - samples[0].heapUsed;
  const budget = 8 * 1024 * 1024;
  const result = {
    scenario: "Local helper read sharing, SSE close/abort, SSO grant exchange, bounded throttle churn, and the assistant's index and embedding cache",
    node: process.version, platform: process.platform, warmupBatches: 2, batches, iterationsPerBatch: iterations,
    helperRequests, streamClosures, samples, retainedHeapGrowthBytes: growth, peakRetainedHeapGrowthBytes: peakGrowth, heapGrowthBudgetBytes: budget,
    assistantIndex: { chunks: indexStats.chunks, terms: indexStats.terms, retainedHeapBytes: indexRetainedBytes, budgetBytes: indexBudget },
    embeddingCache: { vectorsSet: embedded, entries: embeddings.size, bytes: embeddings.bytes, limits: embeddingCacheLimits },
    passed: peakGrowth <= budget && indexRetainedBytes <= indexBudget,
    limitation: "Synthetic short-run regression budget; not a browser leak test, production load test or 24-72 hour soak. RSS can remain high after allocator reuse.",
  };
  console.log(JSON.stringify(result, null, 2));
  assert.ok(indexRetainedBytes <= indexBudget, `The assistant's index retains ${indexRetainedBytes} bytes of heap (budget ${indexBudget})`);
  assert.ok(result.passed, `Retained heap grew by up to ${peakGrowth} bytes after warmup (budget ${budget})`);
} finally {
  oidc.close();
  for (const connection of connections) connection.destroy();
  webServer.closeAllConnections();
  await Promise.all([new Promise((resolve) => helperServer.close(resolve)), new Promise((resolve) => webServer.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
