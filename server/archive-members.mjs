/**
 * A few small files read out of a .tar.gz without unpacking it (sweep 4).
 *
 * The restore dialogs show what a backup's compose file would hand its containers before anything
 * is restored. That needs its compose.yaml and boxpilot.json, which BoxPilot writes first in every
 * app backup, so this reads the archive as a stream and stops as soon as it has them: a few
 * kilobytes of a multi-gigabyte archive, nothing written to disk, no tar run as root over a file
 * someone else may have made. Only regular files are read; a link or anything else at a wanted
 * name is not followed and not returned.
 *
 * It is a preview. tar keeps the last of two members with one name and this returns the first, so
 * the restore itself checks the files it actually unpacked, and refuses on what it finds there.
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const block = 512;

/** A tar size field: octal text, or GNU's base-256 for large members. */
function sizeOf(field) {
  if (field[0] & 0x80) {
    let value = 0;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  const value = Number.parseInt(text || "0", 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

const text = (field) => field.toString("utf8").replace(/\0.*$/s, "");
/** A member name as tar unpacks it: no leading `./` or `/`, no trailing `/`. */
const normalName = (name) => name.replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");

/** The `path` and `size` a pax extended header sets for the member after it. */
function paxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(buffer.toString("ascii", offset, space), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > buffer.length) break;
    const record = buffer.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * `names` read from the archive at `file`: a Map from each name found, as a regular file of at most
 * `maxBytes`, to its contents. Stops reading once it has them all.
 */
export async function readArchiveMembers(file, names, { maxBytes = 1024 * 1024 } = {}) {
  const wanted = new Set(names.map(normalName));
  const found = new Map();
  const source = createReadStream(file);
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  let pending = Buffer.alloc(0);
  let skip = 0;
  let collecting = null;            // { kind: "file" | "longname" | "pax", name, remaining, padding, chunks }
  let longName = null;
  let pax = {};
  try {
    for await (const chunk of gunzip) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      for (;;) {
        if (skip > 0) {
          const taken = Math.min(skip, pending.length - offset);
          skip -= taken; offset += taken;
          if (skip > 0) break;
          continue;
        }
        if (collecting) {
          const taken = Math.min(collecting.remaining, pending.length - offset);
          collecting.chunks.push(pending.subarray(offset, offset + taken));
          collecting.remaining -= taken; offset += taken;
          if (collecting.remaining > 0) break;
          const body = Buffer.concat(collecting.chunks);
          if (collecting.kind === "file") found.set(collecting.name, body);
          else if (collecting.kind === "longname") longName = text(body);
          else pax = paxRecords(body);
          skip = collecting.padding;
          collecting = null;
          continue;
        }
        if (pending.length - offset < block) break;
        const header = pending.subarray(offset, offset + block);
        offset += block;
        if (header.every((byte) => byte === 0)) continue;
        const type = String.fromCharCode(header[156] || 0x30);
        const size = pax.size !== undefined && !["x", "g", "L"].includes(type) ? Number(pax.size) || 0 : sizeOf(header.subarray(124, 136));
        const padding = (block - (size % block)) % block;
        if (type === "L" || type === "x") {
          // Names and sizes for the member after this one; bounded, as a crafted one can say anything.
          if (size > 64 * 1024) { skip = size + padding; continue; }
          collecting = { kind: type === "L" ? "longname" : "pax", remaining: size, padding, chunks: [] };
          continue;
        }
        if (type === "g") { skip = size + padding; continue; }
        const ustar = header.toString("ascii", 257, 262) === "ustar";
        const prefix = ustar ? text(header.subarray(345, 500)) : "";
        const name = normalName(pax.path ?? longName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100))));
        longName = null; pax = {};
        const regular = type === "0" || type === "7" || header[156] === 0;
        if (regular && wanted.has(name) && !found.has(name) && size <= maxBytes) {
          collecting = { kind: "file", name, remaining: size, padding, chunks: [] };
          continue;
        }
        skip = size + padding;
      }
      pending = pending.subarray(offset);
      if ([...wanted].every((name) => found.has(name))) break;
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  return found;
}
