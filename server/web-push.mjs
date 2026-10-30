/**
 * Web Push (M25.2), with nothing but node:crypto: VAPID (RFC 8292) to say which server is sending,
 * and aes128gcm (RFC 8291) so only the subscribing device can read what is sent. The push service
 * in the middle - Apple's for an iPhone or iPad web app, Google's for Chrome, Mozilla's for Firefox -
 * carries ciphertext it cannot open. BoxPilot still puts nothing in it but a title and a link that
 * names a job id (server/push-approvals.mjs), because the device shows it on a lock screen.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import path from "node:path";

/**
 * Where a subscription may point: the browsers' own push services. The browser names the endpoint,
 * and BoxPilot then POSTs to it, so an endpoint anywhere else - an address on this LAN, this server
 * itself - is refused rather than fetched.
 */
export const pushServiceHosts = Object.freeze([
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
]);

const base64url = /^[A-Za-z0-9_-]+={0,2}$/;
const decode = (value) => (typeof value === "string" && base64url.test(value) ? Buffer.from(value, "base64url") : null);

/**
 * A browser's PushSubscription, checked: an https endpoint on a known push service, a P-256 public
 * key and a 16-byte auth secret. Returns the parts BoxPilot keeps, or throws saying what is wrong.
 */
export function checkSubscription(subscription) {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 1024 || !URL.canParse(endpoint)) throw new Error("The subscription has no endpoint BoxPilot can use");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("The subscription's endpoint must be an https address with no user name, password or port");
  if (!pushServiceHosts.some((host) => host.test(url.hostname.toLowerCase()))) throw new Error("The subscription's endpoint is not a browser push service BoxPilot knows");
  const p256dh = decode(subscription?.keys?.p256dh);
  const auth = decode(subscription?.keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04) throw new Error("The subscription's p256dh key is not a P-256 public key");
  if (!auth || auth.length !== 16) throw new Error("The subscription's auth secret is not 16 bytes");
  return { endpoint: url.href, keys: { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") } };
}

/** The application server's key pair, as VAPID and the browser's applicationServerKey need them. */
export function vapidKeysFrom(privateKey) {
  const key = typeof privateKey === "string" || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("The VAPID key must be an EC P-256 key");
  const { x, y } = createPublicKey(key).export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]).toString("base64url");
  return { privateKey: key, publicKey };
}

/**
 * The VAPID key, kept beside the OIDC signing key and guarded the same way: a 0600 PEM in a 0700
 * directory, created on first use, never in the database (which every controller backup copies).
 * A missing file after a restore just means a new key; every device then subscribes again.
 */
export function loadVapidKey(keyDir) {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(keyDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022)) throw new Error("The Web Push key directory must be a protected real directory");
  const keyPath = path.join(keyDir, "vapid.key");
  const read = () => {
    const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 16 * 1024 || (info.mode & 0o077) || info.uid !== directory.uid) throw new Error("The Web Push key has an unexpected type, size, owner or mode");
      const bytes = Buffer.alloc(info.size);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      return vapidKeysFrom(bytes.subarray(0, length));
    } finally { closeSync(fd); }
  };
  try { return read(); } catch (error) {
    if (error.code !== "ENOENT") throw new Error("The Web Push key could not be read", { cause: error });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    try { writeFileSync(keyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 }); } catch (creation) { if (creation.code !== "EEXIST") throw creation; }
    return read();
  }
}

const b64 = (value) => Buffer.from(value).toString("base64url");

/**
 * The Authorization header for one push service: a JWT for its origin, signed with the VAPID key,
 * good for twelve hours (Apple refuses more than a day), and the public key. `subject` is how the
 * push service can reach whoever runs this server: an https address or a mailto: (Apple checks).
 */
export function vapidAuthorization({ endpoint, vapid, subject, now = Date.now(), lifetimeSeconds = 12 * 3600 }) {
  if (typeof subject !== "string" || !/^(https:\/\/|mailto:)/.test(subject)) throw new Error("The VAPID subject must be an https address or a mailto: address");
  const header = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + lifetimeSeconds, sub: subject }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${signature.toString("base64url")}, k=${vapid.publicKey}`;
}

/** Record size: one record carries the whole message, so it only has to be larger than it. */
const recordSize = 4096;

/**
 * RFC 8291: encrypt `plaintext` for the subscription's keys, as one aes128gcm record. `salt` and
 * `serverPrivateKey` are for the RFC's own test vector; left out, both are fresh each time.
 */
export function encryptPayload(plaintext, keys, { salt = randomBytes(16), serverPrivateKey = null } = {}) {
  const receiverKey = decode(keys?.p256dh);
  const authSecret = decode(keys?.auth);
  if (!receiverKey || receiverKey.length !== 65 || !authSecret || authSecret.length !== 16) throw new Error("The subscription's keys are not usable");
  const message = Buffer.from(plaintext);
  if (message.length + 17 > recordSize) throw new Error("The push is too long to send");
  const ecdh = createECDH("prime256v1");
  if (serverPrivateKey) ecdh.setPrivateKey(serverPrivateKey); else ecdh.generateKeys();
  const senderKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiverKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiverKey, senderKey]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  // The one record, with the delimiter that says it is the last.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([message, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + senderKey.length);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = senderKey.length;
  senderKey.copy(header, 21);
  return Buffer.concat([header, sealed]);
}

/**
 * The HTTP request for one push. `topic` lets the push service replace an undelivered push with a
 * newer one of the same topic (at most 32 URL-safe characters); `ttl` is how long it may wait for a
 * phone that is off; `urgency` "high" asks for it now.
 */
export function pushRequest({ subscription, payload, vapid, subject, ttl = 3600, urgency = "high", topic = null, now = Date.now(), authorization = null }) {
  if (topic !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) throw new Error("A push topic is at most 32 URL-safe characters");
  const body = encryptPayload(JSON.stringify(payload), subscription.keys);
  return {
    url: subscription.endpoint,
    options: {
      method: "POST",
      headers: {
        TTL: String(ttl),
        Urgency: urgency,
        ...(topic ? { Topic: topic } : {}),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: authorization ?? vapidAuthorization({ endpoint: subscription.endpoint, vapid, subject, now }),
      },
      body,
    },
  };
}
