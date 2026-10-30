import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { parseSignerKey, readReleaseSigner, setReleaseSigner, signerFileText } from "./release-signer.mjs";

// A real ed25519 public key (`ssh-keygen -t ed25519`), and its fingerprint as ssh-keygen -l prints it.
const ed25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("the release key", () => {
  it("reads a public key line, comment or not, and refuses anything else", () => {
    const key = parseSignerKey(`${ed25519} owner@laptop`);
    expect(key).toMatchObject({ type: "ssh-ed25519", blob: ed25519.split(" ")[1] });
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(parseSignerKey(`  ${ed25519}\n`)).toMatchObject({ fingerprint: key.fingerprint });
    // The label has to match the key inside it.
    expect(parseSignerKey(`ssh-rsa ${ed25519.split(" ")[1]}`)).toBeNull();
    expect(parseSignerKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeNull();
    expect(parseSignerKey(`${ed25519}\nssh-ed25519 AAAA`)).toBeNull();
    expect(parseSignerKey("")).toBeNull();
  });

  it("writes git's allowed-signers line without the comment", () => {
    expect(signerFileText(parseSignerKey(`${ed25519} owner@laptop`))).toBe(`boxpilot-release namespaces="git" ${ed25519}\n`);
  });

  it.skipIf(onWindows)("is set, read back by fingerprint, and cleared", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-signer-"));
    directories.push(directory);
    const file = path.join(directory, "release-signers");
    expect(await readReleaseSigner({ file })).toBeNull();
    const { signer } = await setReleaseSigner({ publicKey: `${ed25519} owner@laptop` }, { file });
    expect(await readReleaseSigner({ file })).toEqual(signer);
    expect(await readFile(file, "utf8")).not.toContain("owner@laptop");
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await expect(setReleaseSigner({ publicKey: "not a key" }, { file })).rejects.toThrow("Not an SSH public key");
    expect(await readReleaseSigner({ file })).toEqual(signer);
    expect(await setReleaseSigner({ publicKey: null }, { file })).toEqual({ signer: null });
    expect(await readReleaseSigner({ file })).toBeNull();
  });
});
