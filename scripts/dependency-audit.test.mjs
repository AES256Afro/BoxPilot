// @vitest-environment node
import { describe, expect, it } from "vitest";
import { advisories, evaluate, failed, report } from "./dependency-audit.mjs";

const now = () => new Date("2026-09-27T12:00:00.000Z");

// The shape `npm audit --json` (report version 2) produces: a package that is vulnerable itself
// carries the advisory object in `via`; a package affected through a dependency names it as a string.
function auditReport(...entries) {
  const vulnerabilities = {};
  for (const { advisory, name, severity = "moderate", through } of entries) {
    vulnerabilities[name] = {
      name,
      severity,
      isDirect: false,
      via: [{ source: 1100001, name, dependency: name, title: `${name} advisory`, url: `https://github.com/advisories/${advisory}`, severity, range: "<1.0.1" }],
      effects: through ? [through] : [],
      range: "<1.0.1",
      nodes: [`node_modules/${name}`],
      fixAvailable: true,
    };
    if (through) vulnerabilities[through] = { name: through, severity, isDirect: true, via: [name], effects: [], range: "*", nodes: [`node_modules/${through}`], fixAvailable: true };
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

const empty = auditReport();

describe("reading an npm audit report", () => {
  it("lists each advisory once and skips the packages that are only affected through another", () => {
    const found = advisories(auditReport({ advisory: "GHSA-82fw-gwwq-j7x9", name: "@vitest/mocker", through: "vitest" }));
    expect(found).toEqual([expect.objectContaining({ id: "GHSA-82fw-gwwq-j7x9", package: "@vitest/mocker", severity: "moderate" })]);
    expect(advisories(empty)).toEqual([]);
    expect(advisories(undefined)).toEqual([]);
  });
});

describe("deciding what fails the run", () => {
  it("fails on an untriaged production advisory at moderate or above", () => {
    const production = auditReport({ advisory: "GHSA-aaaa-bbbb-cccc", name: "qs", severity: "high" });
    const result = evaluate({ production, all: production, triage: { accepted: [] }, now });
    expect(result.blocking.map((advisory) => advisory.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(failed(result)).toBe(true);
  });

  it("reports a low production advisory without failing", () => {
    const production = auditReport({ advisory: "GHSA-aaaa-bbbb-cccc", name: "qs", severity: "low" });
    const result = evaluate({ production, all: production, triage: { accepted: [] }, now });
    expect(result.belowThreshold).toHaveLength(1);
    expect(failed(result)).toBe(false);
  });

  it("accepts a triaged advisory until its expiry date, including the day itself", () => {
    const production = auditReport({ advisory: "GHSA-aaaa-bbbb-cccc", name: "qs" });
    const triage = { accepted: [{ advisory: "GHSA-aaaa-bbbb-cccc", package: "qs", reason: "Only reachable through the owner-only export route.", reviewed: "2026-09-20", expires: "2026-09-27" }] };
    const result = evaluate({ production, all: production, triage, now });
    expect(result.accepted.map((advisory) => advisory.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(failed(result)).toBe(false);
    expect(report(result)[0]).toContain("until 2026-09-27: Only reachable through the owner-only export route.");
  });

  it("fails again once an acceptance has expired", () => {
    const production = auditReport({ advisory: "GHSA-aaaa-bbbb-cccc", name: "qs" });
    const triage = { accepted: [{ advisory: "GHSA-aaaa-bbbb-cccc", package: "qs", reason: "Waiting on upstream.", reviewed: "2026-08-01", expires: "2026-09-26" }] };
    const result = evaluate({ production, all: production, triage, now });
    expect(result.expired).toHaveLength(1);
    expect(failed(result)).toBe(true);
    expect(report(result)[0]).toMatch(/^EXPIRED .*review it again$/);
  });

  it("warns about development-only advisories without failing", () => {
    const all = auditReport({ advisory: "GHSA-82fw-gwwq-j7x9", name: "@vitest/mocker", through: "vitest" });
    const result = evaluate({ production: empty, all, triage: { accepted: [] }, now });
    expect(result.development.map((advisory) => advisory.id)).toEqual(["GHSA-82fw-gwwq-j7x9"]);
    expect(failed(result)).toBe(false);
  });

  it("points out triage entries that no longer match anything", () => {
    const triage = { accepted: [{ advisory: "GHSA-gone-gone-gone", package: "old", reason: "Fixed since.", reviewed: "2026-08-01", expires: "2026-12-01" }] };
    const result = evaluate({ production: empty, all: empty, triage, now });
    expect(result.unused.map((entry) => entry.advisory)).toEqual(["GHSA-gone-gone-gone"]);
    expect(failed(result)).toBe(false);
    expect(report(result)).toEqual(["unused      GHSA-gone-gone-gone is in the triage list but no longer reported; remove it"]);
  });

  it("says plainly when there is nothing to report", () => {
    expect(report(evaluate({ production: empty, all: empty, triage: { accepted: [] }, now }))).toEqual(["No known advisories in production or development dependencies."]);
  });
});
