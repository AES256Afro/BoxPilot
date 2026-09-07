import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";

/** An existing signing identity must survive read errors, corruption and concurrent startup. */
export function loadOidcSigningKeys(keyDir) {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(keyDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022)) throw new Error("OIDC key directory must be a protected real directory");
  const keyPath = path.join(keyDir, "signing.key");
  function readKey() {
    const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 16 * 1024 || (info.mode & 0o077) || info.uid !== directory.uid) throw new Error("OIDC signing key has unexpected type, size, ownership or permissions");
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 16 * 1024) throw new Error("OIDC signing key grew beyond its size limit");
      const key = createPrivateKey(bytes.subarray(0, length));
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("OIDC signing key must use EC P-256");
      return key;
    } finally { closeSync(fd); }
  }
  let privateKey;
  try { privateKey = readKey(); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("OIDC signing key could not be loaded. Preserve the existing file and restore a verified key backup.", { cause: error });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    try {
      writeFileSync(keyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
    } catch (creationError) {
      if (creationError.code !== "EEXIST") throw creationError;
    }
    // A second process may have created the identity first. Always use the file that won.
    privateKey = readKey();
  }
  const publicKey = createPublicKey(privateKey);
  const kid = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("base64url").slice(0, 16);
  return { privateKey, publicKey, kid };
}
