import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/**
 * A browser's side of a Web Push subscription, for tests (M25.2): its P-256 key pair and auth
 * secret, and `read`, which opens an aes128gcm body (RFC 8291) the way the browser does - so a test
 * can say exactly what a push carried, and that only this device could have read it.
 */
export function pushDevice() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  function read(body) {
    const bytes = Buffer.from(body);
    const salt = bytes.subarray(0, 16);
    const length = bytes[20];
    const senderKey = bytes.subarray(21, 21 + length);
    const sealed = bytes.subarray(21 + length);
    const shared = ecdh.computeSecret(senderKey);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), senderKey]), 32));
    const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    if (record.at(-1) !== 2) throw new Error("The record does not end with the last-record delimiter");
    return record.subarray(0, record.length - 1).toString("utf8");
  }
  return { keys, read };
}
