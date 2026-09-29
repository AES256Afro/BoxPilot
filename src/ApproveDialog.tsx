/*
 * The approval dialog lives in the shell now (src/shell/ApproveDialog.tsx, M33.13). This path stays
 * while the pages being rebuilt in wave 2 still import it from here; once they have landed, point
 * them at ../shell/ApproveDialog and delete this file.
 */
export { ApproveDialog, useOperation, type PendingOperation } from "./shell/ApproveDialog";
