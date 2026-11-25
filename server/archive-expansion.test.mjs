import { describe, expect, it } from "vitest";
import { assertArchiveFits, expandedBytes } from "./archive-expansion.mjs";

/**
 * A runner that behaves as fixedRun does: given `onLine` it streams the output a line at a time and
 * keeps only a short tail; without it the output is buffered whole, and a run that prints past
 * `maxBuffer` (fixedRun's default 1 MiB when none is given) is killed and answers ok:false.
 * @param {() => Iterable<string>} lines
 */
function listingRunner(lines) {
  const calls = [];
  const run = async (binary, args, options = {}) => {
    calls.push({ binary, args, options });
    if (typeof options.onLine === "function") {
      for (const line of lines()) options.onLine(line, "stdout");
      options.onLine("tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr' 123", "stderr");
      return { ok: true, stdout: "", stderr: "" };
    }
    const cap = options.maxBuffer ?? 1024 * 1024;
    let stdout = "";
    for (const line of lines()) {
      stdout += `${line}\n`;
      if (stdout.length > cap) return { ok: false, stdout: "", stderr: "stdout maxBuffer length exceeded" };
    }
    return { ok: true, stdout, stderr: "" };
  };
  return { run, calls };
}

// 97 bytes each with the newline, the length of a GNU tar line for a file deep in an app's data.
const fileLine = (index) => `-rw-r--r-- 1000/1000         1234 2026-01-01 00:00 data/library/photos/2026/05/IMG_${String(index).padStart(9, "0")}.jpg`;

describe("expandedBytes", () => {
  // M73: buffered whole under a 64 MiB cap, a listing past ~690k files had tar killed, and the
  // restore was refused as "Could not read the archive". It is summed as it streams now.
  it("adds up a listing larger than 64 MiB", async () => {
    expect(fileLine(0).length + 1).toBe(97);
    const count = 700_000;   // 700k × 97 B ≈ 64.8 MiB
    const lines = function* () { for (let index = 0; index < count; index += 1) yield fileLine(index); };
    const { run, calls } = listingRunner(lines);
    expect(count * 97).toBeGreaterThan(64 * 1024 * 1024);
    await expect(expandedBytes(run, "/usr/bin/tar", "/backups/big.tar.gz")).resolves.toBe(count * 1234);
    expect(typeof calls[0].options.onLine).toBe("function");
    expect(calls[0].options.maxBuffer).toBeUndefined();
  }, 60_000);

  it("counts members' sizes, not directories or tar's warnings", async () => {
    const { run } = listingRunner(() => [
      "drwxr-xr-x 1000/1000            0 2026-01-01 00:00 data/",
      "-rw------- 0/0                612 2026-01-01 00:00 boxpilot.json",
      "-rw-r--r-- 1000/1000         4096 2026-01-01 00:00 data/a b.txt",
    ]);
    await expect(expandedBytes(run, "/usr/bin/tar", "/backups/small.tar.gz", ["data/"])).resolves.toBe(4708);
  });

  it("throws with tar's last words when the archive cannot be read", async () => {
    const run = async () => ({ ok: false, stdout: "", stderr: "gzip: stdin: not in gzip format\ntar: Child returned status 1\n" });
    await expect(expandedBytes(run, "/usr/bin/tar", "/backups/bad.tar.gz")).rejects.toThrow(/Could not read the archive: .*Child returned status 1/);
  });

  it("refuses an archive that would not fit, from the streamed total", async () => {
    const { run } = listingRunner(() => ["-rw-r--r-- 1000/1000   3221225472 2026-01-01 00:00 data/disk.img"]);
    await expect(assertArchiveFits({ run, tarBinary: "/usr/bin/tar", artifactPath: "/b.tar.gz", directory: "/var", free: async () => 2 * 1024 ** 3 })).rejects.toThrow(/unpacks to 3\.0 GiB/);
  });
});
