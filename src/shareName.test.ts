import { describe, it, expect } from "vitest";
import { validShareName, validSmbShareName } from "./shareName";
// The server module is plain JavaScript; this test exists precisely to hold it and the typed
// browser copy to the same answers, so it reaches across the boundary on purpose.
// @ts-expect-error -- untyped .mjs, imported deliberately to compare the two implementations
import { validSmbShare, nfsExportPattern } from "../server/tasks/shares.mjs";

/**
 * The form and the server have to agree about what a share name is. They did not once: the server
 * learned to take a folder inside a share and the form kept refusing it, so the button stayed
 * disabled while telling the owner to type what they had already typed.
 */
const CASES = [
  "Public", "aes256afro", "aes256afro/BoxPilot-Backup", "Backups/2026", "My Share/Sub Folder",
  "a".repeat(80), "a".repeat(81),
  "../etc", "aes256afro/../../etc", "/leading", "trailing/", "a//b", "", " ", "aes256afro/..",
  "one/two/three/four/five/six/seven/eight/nine",
  "has\\backslash", "has:colon", "has\nnewline", "-startsWithHyphen",
];

describe("share names, as the form and the server each see them", () => {
  it("agrees with the server on every case", () => {
    for (const share of CASES) {
      expect({ share, valid: validSmbShareName(share) }).toEqual({ share, valid: validSmbShare(share) });
    }
  });

  it("takes a folder inside a share, and refuses one that climbs out", () => {
    expect(validShareName("smb", "aes256afro/BoxPilot-Backup")).toBe(true);
    expect(validShareName("smb", "aes256afro/../../etc")).toBe(false);
    expect(validShareName("smb", "trailing/")).toBe(false);
  });

  it("still judges NFS exports as absolute paths", () => {
    expect(validShareName("nfs", "/volume1/media")).toBe(true);
    expect(validShareName("nfs", "volume1/media")).toBe(false);
    expect(nfsExportPattern.test("/volume1/media")).toBe(true);
  });
});
