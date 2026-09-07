import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadOidcSigningKeys } from "./oidc-signing-keys.mjs";
import { createOidcService } from "./oidc.mjs";

const roots = [];
const fixture = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "boxpilot-oidc-keys-")); roots.push(dir); return { dir, file: path.join(dir, "signing.key") }; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("creates a private P-256 identity once and preserves it across restarts", () => {
  const { dir, file } = fixture();
  const first = loadOidcSigningKeys(dir); const bytes = readFileSync(file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadOidcSigningKeys(dir).kid).toBe(first.kid);
  expect(readFileSync(file)).toEqual(bytes);
});

it.each(["corrupt private key", "x".repeat(20 * 1024)])("preserves a damaged or oversized identity instead of replacing it", (data) => {
  const { dir, file } = fixture(); writeFileSync(file, data, { mode: 0o600 });
  expect(() => loadOidcSigningKeys(dir)).toThrow(/Preserve/);
  expect(readFileSync(file, "utf8")).toBe(data);
});

it("refuses a linked key without writing through it", () => {
  const { dir, file } = fixture(); const target = path.join(dir, "original");
  writeFileSync(target, "preserve", { mode: 0o600 }); symlinkSync(target, file);
  expect(() => loadOidcSigningKeys(dir)).toThrow(/Preserve/);
  expect(readFileSync(target, "utf8")).toBe("preserve");
});

it("keeps client administration available while refusing SSO with a broken identity", () => {
  const { dir, file } = fixture(); writeFileSync(file, "broken", { mode: 0o600 });
  const service = createOidcService({ keyDir: dir, store: { listOidcClients: () => [{ id: "existing-client" }] } });
  expect(service.status().ready).toBe(false);
  expect(service.listClients()).toEqual([{ id: "existing-client" }]);
  expect(() => service.jwks()).toThrow(/signing key/);
  expect(() => service.issueCode({})).toThrow(/signing key/);
  expect(readFileSync(file, "utf8")).toBe("broken");
});

it("refuses readable-by-others keys and incompatible curves without changing either", () => {
  const { dir, file } = fixture(); loadOidcSigningKeys(dir); chmodSync(file, 0o644);
  expect(() => loadOidcSigningKeys(dir)).toThrow(/Preserve/);
  expect(statSync(file).mode & 0o777).toBe(0o644);
  const pair = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  chmodSync(file, 0o600); writeFileSync(file, pem);
  expect(() => loadOidcSigningKeys(dir)).toThrow(/Preserve/);
  expect(readFileSync(file, "utf8")).toBe(pem);
});
