import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRouterCheckpointService } from "./router-checkpoints.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-router-checkpoint-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
  return { store, owner, service: createRouterCheckpointService({ store }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("router checkpoint evidence", () => {
  it("records browser-local checksum evidence without storing the configuration", async () => {
    const { store, owner, service } = await fixture();
    const checkpoint = service.record({
      modelId: "glinet-flint-2", firmwareVersion: "4.8.2", checksumSha256: "a".repeat(64),
      sizeBytes: 8192, fileRetainedByOperator: true,
    }, owner.id);
    expect(checkpoint).toMatchObject({
      modelId: "glinet-flint-2", firmwareVersion: "4.8.2", sizeBytes: 8192,
      hashOrigin: "operator-browser-reported-sha256", configurationUploaded: false, fileRetainedByOperator: true,
    });
    expect(service.inspect()).toMatchObject({
      checkpoints: [expect.objectContaining({ id: checkpoint.id })],
      latestByModel: { "glinet-flint-2": expect.objectContaining({ id: checkpoint.id }) },
      boundary: { configurationUploaded: false, credentialsAccepted: false, routerMutationSupported: false },
    });
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "router.checkpoint.recorded", subjectId: checkpoint.id })]));
  });

  it("rejects unsupported models, malformed checksums, oversized files, extra fields, and missing retention", async () => {
    const { owner, service } = await fixture();
    const valid = { modelId: "glinet-flint-2", firmwareVersion: "4.8.2", checksumSha256: "b".repeat(64), sizeBytes: 4096, fileRetainedByOperator: true };
    expect(() => service.record({ ...valid, modelId: "custom-router" }, owner.id)).toThrow("supported router");
    expect(() => service.record({ ...valid, checksumSha256: "not-a-checksum" }, owner.id)).toThrow("SHA-256");
    expect(() => service.record({ ...valid, sizeBytes: 65 * 1024 * 1024 }, owner.id)).toThrow("64 MiB");
    expect(() => service.record({ ...valid, fileRetainedByOperator: false }, owner.id)).toThrow("outside BoxPilot");
    expect(() => service.record({ ...valid, password: "forbidden" }, owner.id)).toThrow("accepts only");
  });
});
