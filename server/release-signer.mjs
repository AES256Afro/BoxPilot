/**
 * The key a BoxPilot release must be signed with before this server builds it.
 *
 * The catalog, and everything else BoxPilot runs, ships inside the release. Without a key set, an
 * update builds whatever commit the GitHub tag points at, so whoever controls the GitHub account
 * controls every server. With one set, the upgrade script fetches the tag with git and runs
 * `git verify-tag` against this key (an SSH key: git's `gpg.format=ssh`), and refuses to change
 * anything unless the owner's own key signed it. The private key never comes near this server.
 *
 * The file is git's allowed-signers format, one line, written by the helper (root):
 *   boxpilot-release namespaces="git" ssh-ed25519 AAAA…
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { replaceFileWithoutFollowing } from "./durable-file.mjs";

export const releaseSignersPath = process.env.BOXPILOT_RELEASE_SIGNERS ?? "/var/lib/boxpilot/release-signers";

const keyTypes = ["ssh-ed25519", "sk-ssh-ed25519@openssh.com", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-rsa"];
const signerKeyPattern = /^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(?:256|384|521)|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa) ([A-Za-z0-9+/]{40,2048}={0,2})(?: [^\r\n]{0,200})?$/;

/**
 * A public key line as `ssh-keygen` prints it (`ssh-ed25519 AAAA… comment`), or null when it is not
 * one. The base64 must name the same key type it is labelled with, so a key cannot be pasted under
 * another type's label.
 */
export function parseSignerKey(text) {
  const match = signerKeyPattern.exec(String(text ?? "").trim());
  if (!match) return null;
  const [, type, blob] = match;
  const bytes = Buffer.from(blob, "base64");
  if (bytes.length < 8) return null;
  const length = bytes.readUInt32BE(0);
  if (length !== Buffer.byteLength(type) || bytes.subarray(4, 4 + length).toString("latin1") !== type) return null;
  return { type, blob, fingerprint: `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}` };
}

/** The allowed-signers line for a key. The comment is dropped: git does not need it, and it may name a person. */
export function signerFileText(key) {
  return `boxpilot-release namespaces="git" ${key.type} ${key.blob}\n`;
}

/** The key set on this server, or null when releases are not checked. */
export async function readReleaseSigner({ file = releaseSignersPath, read = readFile } = {}) {
  const text = await read(file, "utf8").catch(() => "");
  const line = text.split("\n").find((entry) => entry.trim() && !entry.trim().startsWith("#"));
  if (!line) return null;
  const key = parseSignerKey(line.replace(/^\S+\s+namespaces="git"\s+/, ""));
  return key ? { type: key.type, fingerprint: key.fingerprint } : { type: null, fingerprint: null, unreadable: true };
}

/** Set the key (a public key line), or clear it (null), and return what is now set. */
export async function setReleaseSigner({ publicKey }, { file = releaseSignersPath, write = replaceFileWithoutFollowing, remove = rm } = {}) {
  if (publicKey === null || publicKey === undefined || publicKey === "") {
    await remove(file, { force: true });
    return { signer: null };
  }
  const key = parseSignerKey(publicKey);
  if (!key) throw new Error(`Not an SSH public key. Paste one line as ssh-keygen prints it (${keyTypes.slice(0, 3).join(", ")} …)`);
  await write(file, signerFileText(key), { mode: 0o644 });
  return { signer: { type: key.type, fingerprint: key.fingerprint } };
}
