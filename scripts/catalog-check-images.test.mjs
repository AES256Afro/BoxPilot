// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkImage, checkLine, comparePlatforms, hasTag, pinnedDigest, platformDigests } from "./catalog-check-images.mjs";

const sha = (character) => `sha256:${character.repeat(64)}`;
const [pinned, other] = [sha("a"), sha("b")];
const [amd64, amd64Next] = [sha("c"), sha("d")];
const [arm64, arm64Next] = [sha("e"), sha("f")];
const [ppc64le, ppc64leNext] = [sha("0"), sha("1")];

/** A multi-arch index as a registry serves one, plus the attestation entries real ones carry. */
function index(entries) {
  return {
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      ...entries.map(([platform, digest]) => {
        const [os, architecture, variant] = platform.split("/");
        return { digest, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os, architecture, ...(variant ? { variant } : {}) } };
      }),
      { digest: sha("2"), mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "unknown", architecture: "unknown" } },
    ],
  };
}

/**
 * A registry that wants a token first, then answers from `answers` (URL suffix → the
 * Docker-Content-Digest for a HEAD, or `{ digest, body }` when a GET reads the manifest).
 */
function registry(answers) {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push(url);
    const headers = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
    if (url.includes("/token?")) return { status: 200, headers: headers({}), json: async () => ({ token: "t" }) };
    if (!options.headers?.Authorization) return { status: 401, headers: headers({ "www-authenticate": 'Bearer realm="https://auth.example/token",service="registry.example"' }) };
    const match = Object.entries(answers).find(([suffix]) => url.endsWith(suffix));
    if (!match) return { status: 404, headers: headers({}) };
    const answer = match[1] && typeof match[1] === "object" ? match[1] : { digest: match[1] };
    return { status: 200, headers: headers(answer.digest ? { "docker-content-digest": answer.digest } : {}), json: async () => answer.body ?? null };
  };
  return { fetchImpl, seen };
}

/** A tag that has moved from `pinned` to `other`, with an index behind each digest. */
function drifted(before, after) {
  return registry({ "/manifests/1.0": other, [`/manifests/${pinned}`]: { body: index(before) }, [`/manifests/${other}`]: { body: index(after) } });
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

describe("reading an index's platforms", () => {
  it("drops attestation entries and treats arm64/v8 as linux/arm64", () => {
    const digests = platformDigests(index([["linux/amd64", amd64], ["linux/arm64/v8", arm64]]));
    expect([...digests.keys()]).toEqual(["linux/amd64", "linux/arm64"]);
    expect([...(digests.get("linux/arm64") ?? [])]).toEqual([arm64]);
  });

  it("has no platforms for a single manifest, which is not an index", () => {
    expect(platformDigests({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: {}, layers: [] }).size).toBe(0);
  });

  it("separates the platforms BoxPilot runs from the rest", () => {
    const before = index([["linux/amd64", amd64], ["linux/arm64/v8", arm64], ["linux/ppc64le", ppc64le]]);
    expect(comparePlatforms(before, index([["linux/amd64", amd64], ["linux/arm64/v8", arm64], ["linux/ppc64le", ppc64leNext]]))).toEqual({ changed: [], rebuilt: ["linux/ppc64le"] });
    expect(comparePlatforms(before, index([["linux/amd64", amd64Next], ["linux/arm64/v8", arm64], ["linux/ppc64le", ppc64le]]))).toEqual({ changed: ["linux/amd64"], rebuilt: [] });
    expect(comparePlatforms(index([["linux/amd64", amd64]]), index([["linux/amd64", amd64], ["linux/arm64/v8", arm64]]))).toEqual({ changed: [], rebuilt: ["linux/arm64 (new)"] });
  });
});

describe("checking a catalog image", () => {
  it("passes a tag that exists, and fails one that does not", async () => {
    const { fetchImpl } = registry({ "/manifests/1.0": other });
    expect(await checkImage("ghcr.io/o/app:1.0", { fetchImpl })).toMatchObject({ ok: true, moved: false, digest: other });
    expect(await checkImage("ghcr.io/o/app:0.9", { fetchImpl })).toMatchObject({ ok: false, status: 404 });
  });

  it("passes a pin the tag still names, without reading either index", async () => {
    const { fetchImpl, seen } = registry({ "/manifests/1.0": pinned });
    expect(await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl })).toMatchObject({ ok: true, moved: false, restacked: false });
    expect(seen.some((url) => url.endsWith(`/manifests/${pinned}`))).toBe(false);
  });

  it("reports a restack, and does not fail, when only an arch BoxPilot never runs was rebuilt", async () => {
    const { fetchImpl } = drifted(
      [["linux/amd64", amd64], ["linux/arm64/v8", arm64], ["linux/ppc64le", ppc64le]],
      [["linux/amd64", amd64], ["linux/arm64/v8", arm64], ["linux/ppc64le", ppc64leNext]],
    );
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: true, moved: false, restacked: true, digest: other, platforms: { changed: [], rebuilt: ["linux/ppc64le"] } });
    expect(checkLine("app", result)).toBe(`RESTACK app            ghcr.io/o/app:1.0@${pinned} (tag now points to ${other}; linux/ppc64le rebuilt, nothing BoxPilot runs changed)`);
  });

  it("fails when the amd64 image under the index moved, and says so", async () => {
    const { fetchImpl } = drifted(
      [["linux/amd64", amd64], ["linux/arm64/v8", arm64]],
      [["linux/amd64", amd64Next], ["linux/arm64/v8", arm64]],
    );
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, restacked: false, platforms: { changed: ["linux/amd64"] } });
    expect(checkLine("app", result)).toBe(`MOVED   app            ghcr.io/o/app:1.0@${pinned} (tag now points to ${other}; linux/amd64 changed)`);
  });

  it("fails when the arm64 image under the index moved, whatever its variant is called", async () => {
    const { fetchImpl } = drifted(
      [["linux/amd64", amd64], ["linux/arm64/v8", arm64]],
      [["linux/amd64", amd64], ["linux/arm64", arm64Next]],
    );
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, platforms: { changed: ["linux/arm64"] } });
    expect(checkLine("app", result)).toContain("linux/arm64 changed");
  });

  it("fails when a platform BoxPilot runs has gone from the index", async () => {
    const { fetchImpl } = drifted([["linux/amd64", amd64], ["linux/arm64/v8", arm64]], [["linux/amd64", amd64]]);
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, platforms: { changed: ["linux/arm64 (gone)"] } });
    expect(checkLine("app", result)).toContain("linux/arm64 (gone) changed");
  });

  it("fails a single-platform image with no index, where there are no platforms to compare", async () => {
    const manifest = { mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: amd64 }, layers: [] };
    const { fetchImpl } = registry({ "/manifests/1.0": other, [`/manifests/${pinned}`]: { body: manifest }, [`/manifests/${other}`]: { body: manifest } });
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, restacked: false });
    expect(checkLine("app", result)).toContain("names no linux/amd64 or linux/arm64 image to compare");
  });

  it("fails a pin the registry no longer serves, rather than calling it a restack", async () => {
    const { fetchImpl } = registry({ "/manifests/1.0": other, [`/manifests/${other}`]: { body: index([["linux/amd64", amd64]]) } });
    const result = await checkImage(`ghcr.io/o/app:1.0@${pinned}`, { fetchImpl });
    expect(result).toMatchObject({ ok: false, moved: true, restacked: false });
    expect(checkLine("app", result)).toContain("no longer serves the pinned digest (404)");
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
