import { describe, expect, it } from "vitest";
import { ownerLikeStorage, ownersWrongAnswer } from "../../test/fixtures/agents-storage.mjs";
import { describeApps, describePlaces, describeStorage, locate } from "./tool-text.mjs";
import { claimsOf, correctionMessages, entitiesIn, evidenceFor, unsureNote, valuesIn, verifyAnswer } from "./verify.mjs";

const storage = describeStorage({ storage: ownerLikeStorage() });
const T1 = [{ id: "T1", title: "Drives, filesystems and SMART", text: storage }];

describe("checking an answer against the tool output it cites (M40)", () => {
  it("catches the owner's answer: /dev/sda called the primary drive with the root's 528 GB and 31%", () => {
    const checked = verifyAnswer(ownersWrongAnswer, T1);
    expect(checked.checked).toBeGreaterThanOrEqual(1);
    const kinds = checked.issues.map((issue) => `${issue.kind}:${issue.said}`);
    expect(kinds).toEqual(expect.arrayContaining(["value:528 GB", "value:31%", "attribute:system disk"]));
    const system = checked.issues.find((issue) => issue.said === "system disk");
    expect(system.detail).toMatch(/\/dev\/sda is not the system disk; the system disk is \/dev\/nvme0n1/);
    const size = checked.issues.find((issue) => issue.said === "528 GB");
    expect(size.detail).toMatch(/for something else: "\/ \(the root filesystem\): on \/dev\/nvme0n1/);
    expect(size.detail).toMatch(/not for \/dev\/sda/);
  });

  it("passes a right answer about the same drives, however it rounds and words them", () => {
    const answers = [
      "Two drives are connected: /dev/nvme0n1, an NVMe SSD of 1.02 TB that is the system disk and holds / (528 GB, 31% used) [T1], and /dev/sda, a 16 TB USB drive with /mnt/archive on it, 15% used [T1].",
      "- **/dev/nvme0n1**: NVMe, 1 TB, the system disk [T1]\n- **/dev/sda**: USB, 16.0 TB, holds /mnt/archive (exFAT, 2.4 TB used, 13.6 TB free) [T1]",
      "The root filesystem is 31% full: 162 GB used of 528 GB, 366 GB free [T1].",
      "/dev/sda is not the system disk; it is a USB drive [T1].",
    ];
    for (const answer of answers) expect(verifyAnswer(answer, T1).issues, answer).toEqual([]);
  });

  it("catches a device or a path the output never names, and a size it never gives", () => {
    expect(verifyAnswer("A third drive, /dev/sdc, is 4 TB [T1].", T1).issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining(["unknown", "value"]));
    expect(verifyAnswer("/mnt/backup holds the backups [T1].", T1).issues[0]).toMatchObject({ kind: "unknown", said: "/mnt/backup" });
    expect(verifyAnswer("The USB drive is 20 TB [T1].", T1).issues[0]).toMatchObject({ kind: "value", said: "20 TB" });
  });

  it("catches a drive given the wrong attachment or filesystem", () => {
    expect(verifyAnswer("/dev/sda is an NVMe drive [T1].", T1).issues[0]).toMatchObject({ kind: "attribute", said: "nvme" });
    expect(verifyAnswer("/mnt/archive is ext4 [T1].", T1).issues[0]).toMatchObject({ kind: "attribute", said: "ext4" });
  });

  it("holds an uncited claim to every output, and a claim to the output it cites only", () => {
    const outputs = [...T1, { id: "T2", title: "Server facts", text: "Hostname: box.\nMemory: 8.0 GB used of 32.0 GB (25%)." }];
    expect(verifyAnswer("Memory is 25% used.", outputs).issues).toEqual([]);
    expect(verifyAnswer("Memory is 25% used [T1].", outputs).issues[0]).toMatchObject({ kind: "value", said: "25%" });
  });

  it("checks what an app's state is said to be", () => {
    const apps = describeApps([
      { id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running", health: "healthy", restarts: 0 } },
      { id: "nextcloud", name: "Nextcloud", installed: true, container: { running: false, status: "exited", health: "none", restarts: 0 } },
    ]);
    const outputs = [{ id: "T1", title: "Apps and containers", text: apps }];
    expect(verifyAnswer("nextcloud is stopped [T1].", outputs).issues).toEqual([]);
    expect(verifyAnswer("nextcloud is running [T1].", outputs).issues[0]).toMatchObject({ kind: "attribute", said: "running" });
    expect(verifyAnswer("pi-hole is running and healthy [T1].", outputs).issues).toEqual([]);
  });

  it("reads where.runs' answer as the place, and leaves sentences with nothing to check alone", () => {
    const places = locate("pihole", { applications: [{ id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running" } }], containers: [], units: [] });
    const outputs = [{ id: "T1", title: "Where does it run?", text: describePlaces("pihole", places) }];
    expect(verifyAnswer("Pi-hole runs as a BoxPilot app in the container bp-pi-hole [T1].", outputs).issues).toEqual([]);
    expect(verifyAnswer("All is well, nothing to do [T1].", outputs)).toMatchObject({ checked: 0, issues: [] });
  });

  it("splits an answer into claims, each with the citations of its sentence or its line", () => {
    expect(claimsOf("The root is 31% used. It is on NVMe [T1].\n- /dev/sda: USB [T1, T2]")).toEqual([
      { text: "The root is 31% used.", cites: ["T1"] },
      { text: "It is on NVMe .", cites: ["T1"] },
      { text: "- /dev/sda: USB", cites: ["T1", "T2"] },
    ]);
    expect(valuesIn("528GB and 2,4 TB, 31 %").map((value) => value.text)).toEqual(["528GB", "2,4 TB", "31 %"]);
    expect(entitiesIn("**/dev/sda** and nvme0n1p3 at /mnt/archive, see https://example.com/a/b").map((entity) => entity.key)).toEqual(["/dev/sda", "/dev/nvme0n1p3", "/mnt/archive"]);
  });

  it("gives a correction only the lines it needs, and a plain note when it cannot correct", () => {
    const { issues } = verifyAnswer(ownersWrongAnswer, T1);
    const evidence = evidenceFor(issues, T1);
    expect(evidence.some((line) => line.startsWith("[T1] - /dev/sda: USB drive"))).toBe(true);
    expect(evidence.some((line) => line.startsWith("[T1] / (the root filesystem)"))).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(14);
    const messages = correctionMessages(ownersWrongAnswer, issues, T1);
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toMatch(/Checks that failed:\n- "- \*\*\/dev\/sda\*\* \(primary drive\): 528 GB total, 31% used": T1 gives 528 GB for something else/);
    expect(unsureNote(issues)).toMatch(/^\n\nChecked against the tools, some of this does not match what they said, so I am not sure of it:\n- /);
    expect(unsureNote([])).toBe("");
  });

  it("is fast: a long answer against several outputs in well under a millisecond each", () => {
    const outputs = Array.from({ length: 6 }, (_value, index) => ({ id: `T${index + 1}`, title: "storage", text: storage }));
    const answer = Array.from({ length: 30 }, (_value, index) => `- /dev/sda holds /mnt/archive, ${index % 2 ? 15 : 31}% used [T${(index % 6) + 1}]`).join("\n");
    const started = performance.now();
    for (let round = 0; round < 20; round += 1) verifyAnswer(answer, outputs);
    expect((performance.now() - started) / 20).toBeLessThan(25);
  });
});
