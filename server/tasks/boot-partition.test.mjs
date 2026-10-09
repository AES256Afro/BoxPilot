import { describe, expect, it, vi } from "vitest";
import { bootWritersRunning, clearBootPartitionMark, fsckOutput, parseFsckFat } from "./boot-partition.mjs";

// fsck.fat 4.2's words for a marked FAT32 partition, as Ubuntu 24.04's dosfstools printed them on
// the CI runner. It exits 1, and with nothing on stderr fixedRun puts Node's "Command failed" there.
const version = "fsck.fat 4.2 (2021-01-31)";
const summary = "/dev/nvme0n1p1: 12 files, 1542/130812 clusters";
const markOnly = [version, "There are differences between boot sector and its backup.", "This is mostly harmless. Differences: (offset:original/backup)", "  65:01/00", "  Not automatically fixing this.",
  "Dirty bit is set. Fs was not properly unmounted and some data may be corrupt.", " Automatically removing dirty bit.", "Leaving filesystem unchanged.", summary].join("\n");
const clean = `${version}\n${summary}\n`;
const failed = (command) => `Command failed: /usr/sbin/fsck.fat ${command}`;

describe("reading fsck.fat -n", () => {
  it("calls the mark, and the backup boot sector differing in that one bit, the mark and nothing else", () => {
    expect(parseFsckFat(markOnly)).toMatchObject({ dirty: true, backupDiffers: true, backupIsTheMark: true, onlyTheMark: true, clean: false, beyond: [], summary });
    // Older builds put the byte's offset first.
    expect(parseFsckFat(markOnly.replace("Dirty bit", "0x41: Dirty bit"))).toMatchObject({ onlyTheMark: true });
    // fixedRun's "Command failed" is not fsck.fat's: the runner's own /boot/efi was refused for it once.
    expect(parseFsckFat(`${markOnly}\n${failed("-n /dev/nvme0n1p1")}`)).toMatchObject({ onlyTheMark: true, beyond: [] });
    expect(fsckOutput({ stdout: markOnly, stderr: failed("-n /dev/nvme0n1p1") })).toBe(markOnly);
    expect(fsckOutput({ stdout: "", stderr: "open: No such file or directory" })).toBe("open: No such file or directory");
    // FAT16 keeps the mark at 0x25 and has no backup boot sector.
    expect(parseFsckFat(`${version}\n0x25: Dirty bit is set. Fs was not properly unmounted and some data may be corrupt.\n Automatically removing dirty bit.\nLeaving filesystem unchanged.\n${summary}`)).toMatchObject({ onlyTheMark: true, backupDiffers: false });
  });

  it("is clean when it says nothing but its version and its summary", () => {
    expect(parseFsckFat(clean)).toMatchObject({ dirty: false, clean: true, onlyTheMark: false, beyond: [] });
  });

  it("calls anything else more than the mark, even the harmless free-space count", () => {
    const freeCount = parseFsckFat(markOnly.replace("Leaving filesystem unchanged.", "Free cluster summary wrong (129270 vs. really 129260)\n  Auto-correcting.\nLeaving filesystem unchanged."));
    expect(freeCount).toMatchObject({ dirty: true, onlyTheMark: false });
    expect(freeCount.beyond[0]).toBe("Free cluster summary wrong (129270 vs. really 129260)");
    const lost = parseFsckFat(markOnly.replace("Leaving filesystem unchanged.", "/EFI/ubuntu/grubx64.efi\n  Contains a free cluster (4711). Assuming EOF.\nLeaving filesystem unchanged."));
    expect(lost).toMatchObject({ onlyTheMark: false });
    expect(lost.beyond).toContain("/EFI/ubuntu/grubx64.efi");
    // A backup that differs in more than the mark's bit is a boot sector problem.
    const sector = parseFsckFat(markOnly.replace("65:01/00", "65:01/00, 67:12/34"));
    expect(sector).toMatchObject({ backupIsTheMark: false, onlyTheMark: false });
    expect(sector.beyond).toEqual(["the boot sector differs from its backup copy in more than the mark"]);
    // The backup differing with no mark set is not clean either.
    expect(parseFsckFat(markOnly.split("\n").filter((line) => !/Dirty bit|removing dirty/.test(line)).join("\n"))).toMatchObject({ dirty: false, clean: false, onlyTheMark: false });
  });
});

/**
 * The host as the task sees it: /boot/efi mounted from nvme0n1p1 in PID 1's namespace, marked, and
 * fsck.fat answering from that state. `problems` adds lines the check finds beyond the mark.
 */
function fakeHost({ marked = true, problems = null, busy = false, fstabMount = true, mounts = null, fsckFat = true } = {}) {
  const state = { mounted: true, marked };
  const options = "rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro";
  const commands = [];
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").pop();
    commands.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt") {
      if (mounts) return { ok: true, code: 0, stdout: mounts, stderr: "" };
      return state.mounted ? { ok: true, code: 0, stdout: `/dev/nvme0n1p1 vfat ${options}\n`, stderr: "" } : { ok: false, code: 1, stdout: "", stderr: "" };
    }
    if (name === "umount") { if (busy) return { ok: false, code: 32, stdout: "", stderr: "umount: /boot/efi: target is busy." }; state.mounted = false; return { ok: true, code: 0, stdout: "", stderr: "" }; }
    if (name === "mount") {
      if (args.length === 3 && !fstabMount) return { ok: false, code: 1, stdout: "", stderr: "mount: /boot/efi: can't find in /etc/fstab." };
      state.mounted = true;
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (name === "fsck.fat") {
      if (state.mounted) throw new Error("fsck.fat ran on a mounted partition");
      // As fixedRun answers: exit 1 with nothing on stderr carries Node's "Command failed" there.
      if (args[0] === "-a") { if (!problems) state.marked = false; return { ok: false, code: 1, stdout: `${version}\nDirty bit is set. Fs was not properly unmounted and some data may be corrupt.\n Automatically removing dirty bit.\nPerforming changes.\n${summary}`, stderr: failed(args.join(" ")) }; }
      const out = state.marked ? (problems ? markOnly.replace("Leaving filesystem unchanged.", `${problems}\nLeaving filesystem unchanged.`) : markOnly) : clean;
      return { ok: !state.marked, code: state.marked ? 1 : 0, stdout: out, stderr: state.marked ? failed(args.join(" ")) : "" };
    }
    throw new Error(`unexpected ${binary}`);
  });
  const files = { exists: async () => fsckFat, readdir: async () => ["EFI"] };
  return { state, commands, run, files, writers: async () => [], locks: async () => ({ available: true, holders: [] }), now: () => new Date("2026-09-29T23:00:00Z") };
}
const strip = (commands) => commands.filter((line) => !line.startsWith("findmnt"));

describe("Check and clear the boot partition's mark", () => {
  it("unmounts, reads, clears only the mark, reads again, and mounts it back", async () => {
    const host = fakeHost();
    const result = await clearBootPartitionMark({}, host);
    expect(result).toMatchObject({ target: "/boot/efi", device: "/dev/nvme0n1p1", fstype: "vfat", cleared: true, alreadyClean: false, clean: true, remounted: true, checkedAt: "2026-09-29T23:00:00.000Z" });
    expect(strip(host.commands)).toEqual([
      "umount -N /proc/1/ns/mnt /boot/efi",
      "fsck.fat -n /dev/nvme0n1p1",
      "fsck.fat -a /dev/nvme0n1p1",
      "fsck.fat -n /dev/nvme0n1p1",
      "mount -N /proc/1/ns/mnt /boot/efi",
    ]);
    expect(host.state).toEqual({ mounted: true, marked: false });
  });

  it("clears nothing on a partition that is not marked, and still mounts it back", async () => {
    const host = fakeHost({ marked: false });
    await expect(clearBootPartitionMark({}, host)).resolves.toMatchObject({ cleared: false, alreadyClean: true, clean: true });
    expect(strip(host.commands)).toEqual(["umount -N /proc/1/ns/mnt /boot/efi", "fsck.fat -n /dev/nvme0n1p1", "mount -N /proc/1/ns/mnt /boot/efi"]);
  });

  it("stops at anything beyond the mark, writes nothing, and mounts it back", async () => {
    const host = fakeHost({ problems: "Free cluster summary wrong (129270 vs. really 129260)\n  Auto-correcting." });
    await expect(clearBootPartitionMark({}, host)).rejects.toThrow(/found more than the not-properly-unmounted mark on \/dev\/nvme0n1p1: Free cluster summary wrong.*Nothing was changed\. A free-space count that is off is harmless.*\/boot\/efi was mounted again as it was\./);
    expect(host.commands.some((line) => line.startsWith("fsck.fat -a"))).toBe(false);
    expect(host.state).toEqual({ mounted: true, marked: true });
  });

  it("leaves it mounted and changes nothing when something has a file open on it", async () => {
    const host = fakeHost({ busy: true });
    await expect(clearBootPartitionMark({}, host)).rejects.toThrow(/could not be unmounted \(umount: \/boot\/efi: target is busy\.\).*left mounted and nothing was changed/);
    expect(host.commands.some((line) => line.startsWith("fsck.fat"))).toBe(false);
  });

  it("refuses while packages are installed or the bootloader updated, before unmounting", async () => {
    const busy = { ...fakeHost(), writers: async () => [{ pid: 4242, name: "unattended-upgr" }] };
    await expect(clearBootPartitionMark({}, busy)).rejects.toThrow(/unattended-upgr is running, and may be writing to \/boot\/efi\. Nothing was changed/);
    const locked = { ...fakeHost(), locks: async () => ({ available: true, holders: [{ file: "/var/lib/dpkg/lock-frontend", pid: 4242 }] }) };
    await expect(clearBootPartitionMark({}, locked)).rejects.toThrow(/Package work is in progress \(\/var\/lib\/dpkg\/lock-frontend is locked\)/);
    for (const host of [busy, locked]) expect(host.commands.some((line) => line.startsWith("umount"))).toBe(false);
  });

  it("mounts it back as it was when fstab does not name it", async () => {
    const host = fakeHost({ fstabMount: false });
    await expect(clearBootPartitionMark({}, host)).resolves.toMatchObject({ cleared: true, remounted: true });
    expect(host.commands).toContain("mount -N /proc/1/ns/mnt -t vfat -o rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro /dev/nvme0n1p1 /boot/efi");
  });

  it("leaves an automount alone, and needs fsck.fat and a FAT partition to start", async () => {
    const automount = fakeHost({ mounts: "systemd-1 autofs rw,relatime,fd=48\n/dev/nvme0n1p1 vfat rw,relatime\n" });
    await expect(clearBootPartitionMark({}, automount)).rejects.toThrow(/mounted on demand by systemd.*sudo systemctl stop boot-efi\.automount/);
    await expect(clearBootPartitionMark({}, fakeHost({ fsckFat: false }))).rejects.toThrow(/fsck\.fat is not installed.*dosfstools/);
    await expect(clearBootPartitionMark({}, fakeHost({ mounts: "/dev/nvme0n1p2 ext4 rw,relatime\n" }))).rejects.toThrow(/No FAT boot partition is mounted at \/boot\/efi, \/efi, \/boot/);
    expect(automount.commands.some((line) => line.startsWith("umount"))).toBe(false);
  });

  it("finds bootloader and package writers by process name", async () => {
    const names = { 1: "systemd", 812: "unattended-upgr", 900: "sshd", 901: "grub-install" };
    const running = await bootWritersRunning({ list: async () => [...Object.keys(names), "self", "sys"], read: async (file) => `${names[file.split("/")[2]]}\n` });
    expect(running).toEqual([{ pid: 812, name: "unattended-upgr" }, { pid: 901, name: "grub-install" }]);
  });
});
