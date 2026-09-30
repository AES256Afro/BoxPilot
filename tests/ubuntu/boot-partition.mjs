// Helper for tests/ubuntu/boot-partition-mark.sh: one step, one JSON line out (the last line).
//
//   node boot-partition.mjs detect <server-dir> <target> [checked-at]   Repair's finding, from the kernel's log as storage.unclean.events reads it
//   node boot-partition.mjs fsck <server-dir> <device>                   fsck.fat -n, and what parseFsckFat makes of it
//   node boot-partition.mjs clear <server-dir> <target>                  the task, called directly with this mount point
//   node boot-partition.mjs unit <server-dir>                            the task through boxpilot-run@, as the helper runs it
//   node boot-partition.mjs mark <device>                                set the not-properly-unmounted mark, as a power cut leaves it
//   node boot-partition.mjs freecount <device>                           make FSInfo's free-cluster count wrong
import { openSync, closeSync, readSync, writeSync } from "node:fs";

const [, , step, first, second, third] = process.argv;
const out = (value) => console.log(JSON.stringify(value));

/** Read and write a few bytes of a block device in place. */
function patch(device, edit) {
  const fd = openSync(device, "r+");
  try {
    const sector = Buffer.alloc(512);
    readSync(fd, sector, 0, 512, 0);
    edit(fd, sector);
  } finally { closeSync(fd); }
}

if (step === "detect") {
  const [serverDir, target, checkedAt] = [first, second, third];
  const { storageOperations, parseFindmnt } = await import(`${serverDir}/ops/storage.mjs`);
  const { bootPartitionUnclean } = await import(`${serverDir}/remediations.mjs`);
  const { fixedRun } = await import(`${serverDir}/exec.mjs`);
  const unclean = await storageOperations().find((operation) => operation.id === "storage.unclean.events").run({}, { run: fixedRun });
  const listed = await fixedRun("/usr/bin/findmnt", ["--real", "-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,OPTIONS,FS-OPTIONS"]);
  // Only the partition under test is offered as a boot partition: the runner may have its own.
  const mounts = parseFindmnt(listed.stdout).filter((mount) => mount.target === target || mount.target === "/")
    .map((mount) => ({ ...mount, target: mount.target === target ? "/boot/efi" : mount.target }));
  const partition = mounts.find((mount) => mount.target === "/boot/efi") ?? null;
  const bootChecks = checkedAt && partition ? { [partition.source]: { checkedAt, clean: true } } : {};
  const [found = null] = bootPartitionUnclean({ mounts, unclean, tools: { fsckFat: true }, bootChecks, hostname: "homebox" });
  out({ source: partition?.source ?? null, events: (unclean.events ?? []).filter((event) => event.device === partition?.source), finding: found });
} else if (step === "fsck") {
  const [serverDir, device] = [first, second];
  const { parseFsckFat } = await import(`${serverDir}/tasks/boot-partition.mjs`);
  const { fixedRun } = await import(`${serverDir}/exec.mjs`);
  const result = await fixedRun("/usr/sbin/fsck.fat", ["-n", device], { timeout: 120_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  process.stderr.write(`${text}\n`);
  out({ code: result.code, ...parseFsckFat(text) });
} else if (step === "clear") {
  const [serverDir, target] = [first, second];
  const { clearBootPartitionMark } = await import(`${serverDir}/tasks/boot-partition.mjs`);
  try {
    const result = await clearBootPartitionMark({}, { targets: [target], log: (line) => process.stderr.write(`      | ${line}\n`) });
    out({ ok: true, result });
  } catch (error) {
    out({ ok: false, error: error.message });
  }
} else if (step === "unit") {
  const { createRunUnitClient } = await import(`${first}/run-unit.mjs`);
  try {
    out({ ok: true, result: await createRunUnitClient().runTask("storage.boot-mark-clear", {}, { timeoutMs: 7 * 60_000 }) });
  } catch (error) {
    out({ ok: false, error: error.message });
  }
} else if (step === "mark") {
  // FAT32 keeps its state byte at 0x41 (65), FAT12/16 at 0x25. Bit 0 is the mark the kernel sets
  // while mounted and clears at a clean unmount; a power cut leaves it set.
  patch(first, (fd, sector) => {
    const fat32 = sector.readUInt16LE(22) === 0;
    const offset = fat32 ? 0x41 : 0x25;
    const byte = Buffer.from([sector[offset] | 1]);
    writeSync(fd, byte, 0, 1, offset);
    out({ offset, before: sector[offset], after: byte[0] });
  });
} else if (step === "freecount") {
  // FSInfo's sector is named at 0x30; its free-cluster count sits 488 bytes in. A wrong count is
  // the harmless thing fsck.fat most often finds after an unclean shutdown, and still more than the mark.
  patch(first, (fd, sector) => {
    const bytesPerSector = sector.readUInt16LE(11);
    const fsinfo = sector.readUInt16LE(0x30) * bytesPerSector + 488;
    const count = Buffer.alloc(4);
    count.writeUInt32LE(5);
    writeSync(fd, count, 0, 4, fsinfo);
    out({ fsinfo, written: 5 });
  });
} else {
  console.error("usage: boot-partition.mjs detect|fsck|clear|unit|mark|freecount ...");
  process.exit(2);
}
