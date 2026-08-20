/**
 * Root-side task table for boxpilot-run@.service. Keys are task ids written into the
 * approval spec by the helper; values run as root with network access.
 * Keep this list explicit — it is the only thing the template unit will execute.
 */
import { aptAutoremove, aptInstall, aptRemove, aptUpdate, aptUpgrade } from "./apt.mjs";
import { setHostname, setSwappiness, setTimezone, systemReboot } from "./system.mjs";
import { sshPasswordAuthSet, userAdd, userKeysImport, userSudoSet } from "./users.mjs";
import { ensureCloudImage } from "./cloud-images.mjs";

export const tasks = Object.freeze({
  "apt.update": aptUpdate,
  "apt.upgrade": aptUpgrade,
  "apt.install": aptInstall,
  "apt.remove": aptRemove,
  "apt.autoremove": aptAutoremove,
  "system.reboot": systemReboot,
  "system.hostname": setHostname,
  "system.timezone": setTimezone,
  "system.swappiness": setSwappiness,
  "users.add": userAdd,
  "users.keys-import": userKeysImport,
  "users.sudo": userSudoSet,
  "ssh.password-auth": sshPasswordAuthSet,
  "vm.cloud-image.ensure": ensureCloudImage,
});

export function taskIds() {
  return Object.keys(tasks);
}
