import { describe, expect, it } from "vitest";
import { suggestFlows, suggestionFacts } from "./flow-suggestions.mjs";

const GiB = 1024 ** 3;

const shelf = [
  { slug: "belt-and-braces", name: "Belt and braces", description: "d", steps: [{ operationId: "controller.backup.create" }, { operationId: "backup.sync" }] },
  { slug: "tidy-docker", name: "Tidy Docker", description: "d", steps: [{ operationId: "housekeeping.remove" }] },
  { slug: "update-night", name: "Update night", description: "d", steps: [{ operationId: "apt.upgrade" }] },
];

const noFacts = { backups: { total: 0 }, offBox: { configured: false, lastSyncAt: null }, reclaimable: 0, updates: { total: 0, security: 0 } };

describe("suggesting an automation", () => {
  it("says nothing at all about a server with nothing wrong", () => {
    expect(suggestFlows({ shelf, flows: [], facts: noFacts })).toEqual([]);
  });

  it("makes the case for mirroring when backups exist and nothing copies them", () => {
    const [suggestion] = suggestFlows({ shelf, flows: [], facts: { ...noFacts, backups: { total: 14 } } });
    expect(suggestion.slug).toBe("belt-and-braces");
    expect(suggestion.because).toBe("14 backups are on this box and nothing copies them anywhere else. A dead disk takes all of them.");
  });

  it("puts it differently when a destination is set up but never used", () => {
    const [suggestion] = suggestFlows({ shelf, flows: [], facts: { ...noFacts, backups: { total: 3 }, offBox: { configured: true, lastSyncAt: null } } });
    expect(suggestion.because).toBe("3 backups are on this box and the off-box destination has never been used.");
  });

  it("stops making the case once the mirror is actually running", () => {
    const facts = { ...noFacts, backups: { total: 9 }, offBox: { configured: true, lastSyncAt: "2026-09-01T04:15:00.000Z" } };
    expect(suggestFlows({ shelf, flows: [], facts }).some((entry) => entry.slug === "belt-and-braces")).toBe(false);
  });

  it("does not tell a server with no backups to protect them", () => {
    const facts = { ...noFacts, offBox: { configured: false, lastSyncAt: null } };
    expect(suggestFlows({ shelf, flows: [], facts })).toEqual([]);
  });

  it("reads properly for a single backup, since \"1 backups ... copies them\" is a bug on screen", () => {
    const [suggestion] = suggestFlows({ shelf, flows: [], facts: { ...noFacts, backups: { total: 1 } } });
    expect(suggestion.because).toBe("1 backup is on this box and nothing copies it anywhere else. A dead disk takes it.");
  });

  it("only mentions Docker when there is enough to be worth a click", () => {
    expect(suggestFlows({ shelf, flows: [], facts: { ...noFacts, reclaimable: 2 * GiB } })).toEqual([]);
    const [suggestion] = suggestFlows({ shelf, flows: [], facts: { ...noFacts, reclaimable: 12 * GiB } });
    expect(suggestion.because).toBe("12 GB of Docker layers and build cache nothing is using. It comes back on its own if it is ever needed.");
  });

  it("mentions security updates when there are any", () => {
    const [suggestion] = suggestFlows({ shelf, flows: [], facts: { ...noFacts, updates: { total: 7, security: 2 } } });
    expect(suggestion.because).toBe("7 updates are waiting, 2 of them security.");
  });

  it("never suggests something already on the shelf", () => {
    const facts = { ...noFacts, backups: { total: 5 } };
    const flows = [{ slug: "belt-and-braces", steps: [] }];
    expect(suggestFlows({ shelf, flows, facts })).toEqual([]);
  });

  it("recognises a renamed copy by what it does, not what it is called", () => {
    // Otherwise renaming a copy of the flow makes BoxPilot start recommending it all over again.
    const facts = { ...noFacts, backups: { total: 5 } };
    const flows = [{ id: "x", name: "My nightly thing", steps: [{ operationId: "controller.backup.create" }, { operationId: "backup.sync" }] }];
    expect(suggestFlows({ shelf, flows, facts })).toEqual([]);
  });

  it("survives a shelf item nobody wrote an argument for", () => {
    const odd = [{ slug: "brand-new", name: "New", description: "d", steps: [{ operationId: "x" }] }];
    expect(suggestFlows({ shelf: odd, flows: [], facts: noFacts })).toEqual([]);
  });

  it("copes with being handed nothing at all", () => {
    expect(suggestFlows()).toEqual([]);
  });
});

describe("reducing the pages' reads to the facts a suggestion needs", () => {
  it("counts only the reclaimable Docker groups, and only the safe ones", () => {
    const housekeeping = { groups: [
      { id: "docker-unused", safe: true, bytes: 8 * GiB },
      { id: "docker-build-cache", safe: true, bytes: 2 * GiB },
      { id: "boxpilot-versions", safe: true, bytes: 40 * GiB },   // not Docker
      { id: "docker-unused-risky", safe: false, bytes: 90 * GiB }, // not safe, and not one of ours
    ] };
    expect(suggestionFacts({ housekeeping }).reclaimable).toBe(10 * GiB);
  });

  it("reads an empty server as an empty server rather than throwing", () => {
    expect(suggestionFacts()).toEqual({ backups: { total: 0 }, offBox: { configured: false, lastSyncAt: null }, reclaimable: 0, updates: { total: 0, security: 0 } });
  });

  it("treats a destination with no sync as configured but unused", () => {
    expect(suggestionFacts({ offBoxDestination: { host: "nas" } })).toMatchObject({ offBox: { configured: true, lastSyncAt: null } });
  });
});
