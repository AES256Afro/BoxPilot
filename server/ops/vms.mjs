import { defineOperation } from "./registry.mjs";
import { validateCloudVmInput } from "../vm-cloud.mjs";

/** Cloud-init VM operations. Creation is medium risk: it adds a VM, never touches existing ones. */
export function vmOperations() {
  return [
    defineOperation({ id: "vm.cloud.images", title: "List cloud base images", risk: "low", readOnly: true, run: (_p, { vmCloud }) => vmCloud.images() }),
    defineOperation({
      id: "vm.cloud.create", title: "Create VM from cloud image", risk: "medium", timeoutMs: 90 * 60_000,
      description: "Downloads the official cloud image if needed (checksum verified), clones it to a new disk, seeds cloud-init with your user and SSH keys, boots the VM on the default NAT network, and waits for its address.",
      parameters: { exact: false, fields: { name: { type: "string", validate: (_v, all) => { const errors = validateCloudVmInput(all); return errors.length ? errors.join("; ") : null; } }, image: { type: "string" }, vcpus: { type: "number" }, memoryMiB: { type: "number" }, diskGiB: { type: "number" }, sshKeys: { type: "array" }, username: { type: "string", optional: true }, packages: { type: "array", optional: true }, autostart: { type: "boolean", optional: true }, password: { type: "string", optional: true } } },
      run: (parameters, { vmCloud, runUnit, progress, jobLog }) => vmCloud.create(parameters, { progress, runUnit, jobLog }),
    }),
  ];
}
