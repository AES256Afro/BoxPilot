/**
 * Gzipped tar archives written byte by byte, for tests that need members no well-behaved tar would
 * write: a hard link or symbolic link whose target climbs out (`../../x`, `/tmp/x`), a member named
 * `../escape`. A backup or snapshot is only as trustworthy as whoever last held the file, and these
 * are what someone holding it could put there.
 *
 * Each entry is `{ name, type, body, linkname, mode }`: `type` is "file" (default), "dir", "hardlink",
 * "symlink", "fifo" or "chardev"; "longname" (GNU) and "pax" carry, as their body, the name or the
 * extended header of the member after them. Plain ustar headers; names and link targets up to 100 bytes.
 */
import { gzipSync } from "node:zlib";

const typeFlags = { file: "0", hardlink: "1", symlink: "2", chardev: "3", dir: "5", fifo: "6", longname: "L", pax: "x" };
const withBody = new Set(["file", "longname", "pax"]);

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function member({ name, type = "file", body = "", linkname = "", mode = type === "dir" ? 0o755 : 0o644 }) {
  const header = Buffer.alloc(512);
  const content = withBody.has(type) ? Buffer.from(body) : Buffer.alloc(0);
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(linkname) > 100) throw new Error("crafted-tar keeps names and link targets to 100 bytes");
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(content.length, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(Date.UTC(2026, 0, 1) / 1000), 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(typeFlags[type], 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

/** A pax extended header's body: `path=x`, `size=n`, each as one length-prefixed record. */
export function paxBody(records) {
  return Object.entries(records).map(([key, value]) => {
    const line = ` ${key}=${value}
`;
    let length = Buffer.byteLength(line);
    length += String(length + String(length).length).length;
    return `${length}${line}`;
  }).join("");
}

/** The archive, gzipped, as a Buffer. */
export function craftedTarGz(entries) {
  return gzipSync(Buffer.concat([...entries.map(member), Buffer.alloc(1024)]));
}
