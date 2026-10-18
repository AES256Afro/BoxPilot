/**
 * A throwaway self-signed certificate for tests that need a TLS server, built with node:crypto so
 * the test needs no openssl. `der` is the certificate's DER bytes, which is what a fingerprint hashes.
 */
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? Buffer.from([body.length]) : (() => { const bytes = []; for (let n = body.length; n; n >>= 8) bytes.unshift(n & 255); return Buffer.from([0x80 | bytes.length, ...bytes]); })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts) => der(0x30, ...parts);
function objectId(text) {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (let value of rest) { const chunk = [value & 127]; for (value >>= 7; value; value >>= 7) chunk.unshift((value & 127) | 128); bytes.push(...chunk); }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

export function selfSignedCertificate({ commonName = "localhost", now = Date.now() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = sequence(der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from(commonName)))));
  const algorithm = sequence(objectId("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name, sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))), name, publicKey.export({ type: "spki", format: "der" }));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])));
  return {
    der: certificate,
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
