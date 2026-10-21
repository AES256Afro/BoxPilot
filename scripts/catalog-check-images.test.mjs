// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkImage, checkLine, hasTag, pinnedDigest } from "./catalog-check-images.mjs";

const [pinned, other] = [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`];

/** A registry that wants a token first, then answers HEADs from `answers` (URL suffix → digest). */
function registry(answers) {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push(url);
    const headers = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
    if (url.includes("/token?")) return { status: 200, headers: headers({}), json: async () => ({ token: "t" }) };
    if (!options.headers?.Authorization) return { status: 401, headers: headers({ "www-authenticate": 'Bearer realm="https://auth.example/token",service="registry.example"' }) };
    const match = Object.entries(answers).find(([suffix]) => url.endsWith(suffix));
    if (!match) return { status: 404, headers: headers({}) };
    return { status: 200, headers: headers(match[1] ? { "docker-content-digest": match[1] } : {}) };
  };
  return { fetchImpl, seen };
}

describe("reading a reference", () => {
  it("knows a pinned digest and whether there is a tag", () => {
    expect(pinnedDigest(`ghcr.io/o/app:1.0@${pinned}`)).toBe(pinned);
    expect(pinnedDigest("ghcr.io/o/app:1.0")).toBeNull();
    expect(hasTag(`ghcr.io/o/app@${pinned}`)).toBe(false);
    expect(hasTag("localhost:5000/app")).toBe(false);
    expect(hasTag(`localhost:5000/app:2@${pinned}`)).toBe(true);
  });
});

describe("checking a catalog image", () => {
  it("passes a tag that exists, and fails one that does not", async () => {
    const { fetchImpl } = registry({ "/manifests/1.0": other });
    expect(await checkImage("ghcr.io/o/app:1.0", { fetchImpl })).toMatchObject({ ok: true, moved: false, digest: other });
    expect(await checkImage("ghcr.io/o/app:0.9", { fetchImpl })).toMatchObject({ ok: false, status: 404 });
  });

  it("fails a pinned tag that now points at another digest, and says where", async () => {
    const { fetchImpl } = registry({ "/manifests/1.0": other });
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, pinned, digest: other });
    expect(checkLine("app", result)).toBe(`MOVED   app            ghcr.io/o/app:1.0@${pinned} (tag now points to ${other})`);
    expect(await checkImage(`ghcr.io/o/app:1.0@${other}`, { fetchImpl })).toMatchObject({ ok: true, moved: false });
  });

  it("fails a pinned tag the registry gives no digest for, rather than passing it unchecked", async () => {
    const { fetchImpl } = registry({ "/manifests/1.0": null });
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, unverified: true });
    expect(checkLine("app", result)).toContain("NODIGST");
    // A plain tag has nothing to compare, so a missing digest is fine there.
    expect(await checkImage("ghcr.io/o/app:1.0", { fetchImpl })).toMatchObject({ ok: true });
  });

  it("asks for a bare digest itself, since it has no tag that could move", async () => {
    const { fetchImpl, seen } = registry({ [`/manifests/${pinned}`]: pinned });
    expect(await checkImage(`ghcr.io/o/app@${pinned}`, { fetchImpl })).toMatchObject({ ok: true, moved: false });
    expect(seen.some((url) => url.endsWith("/manifests/latest"))).toBe(false);
  });
});
