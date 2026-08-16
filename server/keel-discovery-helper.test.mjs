import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelDiscoveryHelper, keelDiscoveryInternals } from "./keel-discovery-helper.mjs";

const temporaryDirectories = [];

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-discovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function emptyRunner({ listener = "" } = {}) {
  return vi.fn(async (_binary, args) => {
    if (args[0] === "ps") return { stdout: "", stderr: "" };
    if (args[0] === "-H") return { stdout: listener, stderr: "" };
    throw new Error(`Unexpected command ${args.join(" ")}`);
  });
}

describe("Keel read-only discovery helper", () => {
  it("reports a clean absent state without reading application secrets or changing the host", async () => {
    const root = await temporaryRoot();
    const helper = createKeelDiscoveryHelper({
      homeRoot: path.join(root, "home"), rootHome: path.join(root, "root"), optRoot: path.join(root, "opt/keel"), managedRoot: path.join(root, "managed/keel/current"),
      runCommand: emptyRunner(), requestHealth: vi.fn(async () => false),
    });

    await expect(helper.inspect()).resolves.toMatchObject({
      installed: false, state: "not-installed", healthy: false, kind: null, listener: "none", healthIdentityVerified: false,
      native: { candidateCount: 0 }, docker: { available: true, candidateCount: 0 }, risks: [],
      boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false, arbitraryPathAccepted: false, arbitraryPortAccepted: false, serviceChanged: false, containerChanged: false },
    });
  });

  it("recognizes the supported per-user installer layout without returning a username, home, environment, or database content", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home/operator");
    const installRoot = path.join(home, "keel");
    const unitRoot = path.join(home, ".config/systemd/user");
    await mkdir(path.join(installRoot, "data"), { recursive: true });
    await mkdir(path.join(installRoot, "uploads"));
    await mkdir(path.join(installRoot, "backups"));
    await mkdir(path.join(unitRoot, "default.target.wants"), { recursive: true });
    await writeFile(path.join(installRoot, "package.json"), JSON.stringify({ name: "keel", version: "1.2.5" }));
    await writeFile(path.join(installRoot, "data/keel.db"), "must-not-be-read");
    await writeFile(path.join(installRoot, "data/.keel-server-secrets.key"), "must-not-be-read");
    await writeFile(path.join(installRoot, ".env"), "KEEL_BACKUP_PASSPHRASE=must-not-leak\n");
    const unitPath = path.join(unitRoot, "keel.service");
    await writeFile(unitPath, `[Service]\nWorkingDirectory=${installRoot}\nExecStart=/usr/bin/npm start\nEnvironmentFile=${installRoot}/.env\n`);
    await symlink(unitPath, path.join(unitRoot, "default.target.wants/keel.service"));
    const helper = createKeelDiscoveryHelper({
      homeRoot: path.join(root, "home"), rootHome: path.join(root, "root"), optRoot: path.join(root, "opt/keel"), managedRoot: path.join(root, "managed/keel/current"),
      runCommand: emptyRunner({ listener: "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*" }), requestHealth: vi.fn(async () => true),
    });

    const result = await helper.inspect();
    expect(result).toMatchObject({
      installed: true, state: "running", healthy: true, kind: "native-user-service", version: "1.2.5", listener: "loopback", healthIdentityVerified: true,
      native: { candidateCount: 1, candidates: [{ source: "installer-default", packageRecognized: true, unitFilePresent: true, unitTemplateMatched: true, unitEnabled: true, databasePresent: true, managedSecretKeyPresent: true, uploadsPresent: true, backupsPresent: true }] },
      risks: [],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("operator");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("must-not");
    expect(serialized).not.toContain("PASSPHRASE");
  });

  it("recognizes an exact-name Keel Docker service and only reports persistence and loopback posture", async () => {
    const root = await temporaryRoot();
    const runCommand = vi.fn(async (_binary, args) => {
      if (args[0] === "ps") return { stdout: args[3].startsWith("label=") ? "abcdef123456" : "abcdef123456", stderr: "" };
      if (args[0] === "-H") return { stdout: "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*", stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:3000", stderr: "" };
      if (args[0] === "inspect" && args[2].includes(".Mounts")) return { stdout: "volume|true", stderr: "" };
      if (args[0] === "inspect") return { stdout: `"/keel"|"keel:1.2.5"|"keel"|${JSON.stringify({ Running: true, Health: { Status: "healthy" } })}`, stderr: "" };
      throw new Error(`Unexpected command ${args.join(" ")}`);
    });
    const helper = createKeelDiscoveryHelper({
      homeRoot: path.join(root, "home"), rootHome: path.join(root, "root"), optRoot: path.join(root, "opt/keel"), managedRoot: path.join(root, "managed/keel/current"),
      runCommand, requestHealth: vi.fn(async () => true),
    });

    const result = await helper.inspect();
    expect(result).toMatchObject({
      installed: true, state: "running", healthy: true, kind: "docker", version: "1.2.5", listener: "loopback",
      docker: { available: true, candidateCount: 1, candidates: [{ source: "compose-service", running: true, containerHealthy: true, loopbackPortPublished: true, persistentData: true }] },
      risks: [],
    });
    expect(JSON.stringify(result)).not.toContain("abcdef123456");
  });

  it("fails closed for multiple installs, changed user units, wildcard listeners, and nonpersistent Docker data", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home/operator");
    const installRoot = path.join(home, "keel");
    await mkdir(path.join(installRoot, "data"), { recursive: true });
    await mkdir(path.join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(path.join(installRoot, "package.json"), JSON.stringify({ name: "keel", version: "1.2.5" }));
    await writeFile(path.join(home, ".config/systemd/user/keel.service"), `[Service]\nWorkingDirectory=${installRoot}\nExecStart=/bin/sh -c evil\nEnvironmentFile=${installRoot}/.env\n`);
    const runCommand = vi.fn(async (_binary, args) => {
      if (args[0] === "ps") return { stdout: "abcdef123456", stderr: "" };
      if (args[0] === "-H") return { stdout: "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*", stderr: "" };
      if (args[0] === "port") return { stdout: "0.0.0.0:3000", stderr: "" };
      if (args[0] === "inspect" && args[2].includes(".Mounts")) return { stdout: "", stderr: "" };
      if (args[0] === "inspect") return { stdout: `"/keel"|"keel:latest"|"keel"|${JSON.stringify({ Running: true })}`, stderr: "" };
      throw new Error(`Unexpected command ${args.join(" ")}`);
    });
    const helper = createKeelDiscoveryHelper({
      homeRoot: path.join(root, "home"), rootHome: path.join(root, "root"), optRoot: path.join(root, "opt/keel"), managedRoot: path.join(root, "managed/keel/current"),
      runCommand, requestHealth: vi.fn(async () => true),
    });

    const result = await helper.inspect();
    expect(result).toMatchObject({ installed: true, state: "ambiguous", healthy: false, kind: "multiple", listener: "wildcard" });
    expect(result.risks).toEqual(expect.arrayContaining(["docker-data-not-persistent", "docker-non-loopback-publish", "multiple-installations", "native-unit-template-changed", "non-loopback-listener"]));
  });

  it("keeps parser decisions fixed and rejects traversal-like working directories", () => {
    expect(keelDiscoveryInternals.containedPath("/home/alice/notes", "/home/alice")).toBe(true);
    expect(keelDiscoveryInternals.containedPath("/home/alice/../bob/notes", "/home/alice")).toBe(false);
    expect(keelDiscoveryInternals.listenerExposure("LISTEN 0 511 [::]:3000 [::]:*")).toBe("wildcard");
    expect(keelDiscoveryInternals.parsePackage('{"name":"other","version":"1.2.5"}')).toEqual({ recognized: false, version: "1.2.5" });
  });

  it("reports a stale user service instead of falsely declaring Keel absent", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home/operator");
    await mkdir(path.join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(path.join(home, ".config/systemd/user/keel.service"), `[Service]\nWorkingDirectory=${home}/missing-keel\nExecStart=/usr/bin/npm start\nEnvironmentFile=${home}/missing-keel/.env\n`);
    const helper = createKeelDiscoveryHelper({
      homeRoot: path.join(root, "home"), rootHome: path.join(root, "root"), optRoot: path.join(root, "opt/keel"), managedRoot: path.join(root, "managed/keel/current"),
      runCommand: emptyRunner(), requestHealth: vi.fn(async () => false),
    });

    const result = await helper.inspect();
    expect(result).toMatchObject({ installed: true, state: "ambiguous", healthy: false, kind: "native-user-service", native: { candidateCount: 1 } });
    expect(result.risks).toContain("native-unit-install-root-missing");
    expect(JSON.stringify(result)).not.toContain("operator");
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
