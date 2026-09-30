import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { pushDevice } from "../test/web-push-device.mjs";
import { checkSubscription, encryptPayload, loadVapidKey, pushRequest, vapidAuthorization, vapidKeysFrom } from "./web-push.mjs";

const device = pushDevice;

describe("encryption (RFC 8291)", () => {
  it("matches the RFC's own worked example byte for byte", () => {
    const body = encryptPayload("When I grow up, I want to be a watermelon", {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    }, { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url") });
    expect(body.toString("base64url")).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("can be read by the subscribing device and by nobody else", () => {
    const phone = device();
    const other = device();
    const body = encryptPayload(JSON.stringify({ title: "Update an app (Jellyfin): approve?" }), phone.keys);
    expect(JSON.parse(phone.read(body))).toEqual({ title: "Update an app (Jellyfin): approve?" });
    expect(() => other.read(body)).toThrow();
    // A fresh salt and key each time: the same words never look the same on the wire.
    expect(encryptPayload("same", phone.keys).equals(encryptPayload("same", phone.keys))).toBe(false);
  });

  it("refuses keys that are not a subscription's, and a message too long for one record", () => {
    expect(() => encryptPayload("x", { p256dh: "short", auth: "short" })).toThrow(/not usable/);
    expect(() => encryptPayload("x".repeat(5000), device().keys)).toThrow(/too long/);
  });
});

describe("which subscriptions BoxPilot will send to", () => {
  const keys = device().keys;
  it("takes the browsers' push services", () => {
    for (const endpoint of ["https://web.push.apple.com/QGuQyavXutnMH", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-par02p.notify.windows.com/w/?token=abc"]) {
      expect(checkSubscription({ endpoint, keys }).endpoint, endpoint).toBe(endpoint);
    }
  });

  it("refuses anything else, so a subscription cannot point BoxPilot at this network or itself", () => {
    for (const endpoint of ["http://web.push.apple.com/x", "https://192.168.1.10/x", "https://localhost/x", "https://127.0.0.1:8787/api/v1/jobs", "https://web.push.apple.com.evil.example/x", "https://user:pass@web.push.apple.com/x", "https://web.push.apple.com:8443/x", "https://evil.example/web.push.apple.com", "not a url"]) {
      expect(() => checkSubscription({ endpoint, keys }), endpoint).toThrow();
    }
    expect(() => checkSubscription({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: keys.p256dh, auth: "AAAA" } })).toThrow(/auth/);
    expect(() => checkSubscription({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: Buffer.alloc(65, 3).toString("base64url"), auth: keys.auth } })).toThrow(/p256dh/);
  });
});

describe("VAPID (RFC 8292)", () => {
  const vapid = vapidKeysFrom(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  const parse = (header) => {
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    const [head, claims, signature] = token.split(".");
    return { key, head: JSON.parse(Buffer.from(head, "base64url")), claims: JSON.parse(Buffer.from(claims, "base64url")), signed: `${head}.${claims}`, signature: Buffer.from(signature, "base64url") };
  };

  it("signs a token for the push service's origin, for less than a day, that the public key verifies", () => {
    const now = Date.parse("2026-09-29T07:00:00Z");
    const token = parse(vapidAuthorization({ endpoint: "https://web.push.apple.com/QGuQyavXutnMH", vapid, subject: "https://homebox.example.ts.net", now }));
    expect(token.head).toEqual({ typ: "JWT", alg: "ES256" });
    expect(token.claims).toEqual({ aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://homebox.example.ts.net" });
    expect(token.key).toBe(vapid.publicKey);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(vapid.publicKey, "base64url").subarray(1, 33).toString("base64url"), y: Buffer.from(vapid.publicKey, "base64url").subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(token.signed), { key: publicKey, dsaEncoding: "ieee-p1363" }, token.signature)).toBe(true);
  });

  it("needs a subject Apple accepts", () => {
    expect(() => vapidAuthorization({ endpoint: "https://web.push.apple.com/x", vapid, subject: "homebox" })).toThrow(/subject/);
    expect(() => vapidAuthorization({ endpoint: "https://web.push.apple.com/x", vapid, subject: "http://homebox" })).toThrow(/subject/);
  });

  it("builds a request with the headers the push services ask for", () => {
    const phone = device();
    const { url, options } = pushRequest({ subscription: { endpoint: "https://web.push.apple.com/abc", keys: phone.keys }, payload: { web_push: 8030 }, vapid, subject: "mailto:owner@example.com", topic: "approval-abc", ttl: 600 });
    expect(url).toBe("https://web.push.apple.com/abc");
    expect(options.headers).toMatchObject({ TTL: "600", Urgency: "high", Topic: "approval-abc", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" });
    expect(JSON.parse(phone.read(options.body))).toEqual({ web_push: 8030 });
    expect(() => pushRequest({ subscription: { endpoint: "https://web.push.apple.com/abc", keys: phone.keys }, payload: {}, vapid, subject: "mailto:a@b.c", topic: "not a topic!" })).toThrow(/topic/);
  });

  // Linux only: POSIX modes on the key file and its directory.
  it.skipIf(onWindows)("keeps its key in a 0600 file it makes once and reads after", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vapid-"));
    try {
      const keyDir = path.join(directory, "push");
      const first = loadVapidKey(keyDir);
      const again = loadVapidKey(keyDir);
      expect(again.publicKey).toBe(first.publicKey);
      expect((await stat(path.join(keyDir, "vapid.key"))).mode & 0o777).toBe(0o600);
      expect((await stat(keyDir)).mode & 0o777).toBe(0o700);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
