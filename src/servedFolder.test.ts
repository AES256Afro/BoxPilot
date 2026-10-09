import { describe, expect, it } from "vitest";
import { exportPathDenyPrefixes, mayServe, sharePathDenyPrefixes } from "./servedFolder";
// The server modules are plain JavaScript; this test holds the browser's copy of their rule to the
// same lists and the same answers, so it reaches across the boundary on purpose.
// @ts-expect-error -- untyped .mjs, imported deliberately to compare the two
import { sharePathDenyPrefixes as serverShare } from "../server/tasks/samba.mjs";
// @ts-expect-error -- untyped .mjs, imported deliberately to compare the two
import { exportPathDenyPrefixes as serverExport } from "../server/tasks/nfs.mjs";
// @ts-expect-error -- untyped .mjs, imported deliberately to compare the two
import { cleanServedPath } from "../server/tasks/served-folder.mjs";

const CASES = [
  "/srv", "/srv/media", "/mnt", "/mnt/", "/mnt/olddata", "/mnt/boxpilot", "/mnt/boxpilot/backup", "/mnt/boxpilotx",
  "/", "/etc", "/etc/samba", "/var", "/var/lib", "/var/lib/samba", "/var/lib/nfs", "/home/alex", "/opt/media",
  "/srv/./media", "/srv//media", "/srv/../etc", "relative", "",
];

describe("which folders the file servers serve, as the Storage page sees it", () => {
  it("refuses the very prefixes Samba and the NFS server refuse", () => {
    expect([...new Set(sharePathDenyPrefixes)].sort()).toEqual([...new Set(serverShare as string[])].sort());
    expect([...new Set(exportPathDenyPrefixes)].sort()).toEqual([...new Set(serverExport as string[])].sort());
  });

  it("agrees with the servers on every case: a folder both of them take", () => {
    for (const path of CASES) {
      const served = cleanServedPath(path, serverShare) !== null && cleanServedPath(path, serverExport, { forbidden: /[\0\r\n\s"]/ }) !== null;
      expect({ path, served: mayServe(path) }).toEqual({ path, served });
    }
  });
});
