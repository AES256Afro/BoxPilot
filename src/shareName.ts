/**
 * What counts as a share to mount, as the browser sees it.
 *
 * This has to agree with `validSmbShare` in server/tasks/shares.mjs. When the server learned to
 * accept a folder inside a share and this did not, the form went on refusing a name the server
 * would have taken — with the button greyed out and a hint telling the owner to type the very
 * thing they had already typed. `shareName.test.ts` runs both validators over the same cases so
 * the two cannot drift apart again.
 */

const SMB_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 ._$-]{0,79}$/;
const SMB_WHOLE = /^[A-Za-z0-9_][A-Za-z0-9 ._$/-]{0,255}$/;
const NFS_EXPORT = /^\/[A-Za-z0-9._+/-]{0,254}$/;

/** A share, optionally followed by a folder inside it: `Public` or `alex/Backups`. */
export function validSmbShareName(share: string): boolean {
  if (!SMB_WHOLE.test(share)) return false;
  const segments = share.split("/");
  return segments.length <= 8 && segments.every((segment) => SMB_SEGMENT.test(segment));
}

export function validShareName(kind: "smb" | "nfs", share: string): boolean {
  return kind === "nfs" ? NFS_EXPORT.test(share) : validSmbShareName(share);
}
