import { randomUUID } from "node:crypto";

export function createLibvirtFoundationService({ helper, newId = randomUUID } = {}) {
  async function inspect() {
    try {
      return await helper.request("virtualization.foundation.inspect", {});
    } catch {
      return {
        connectionUri: "qemu:///system",
        connectionReady: false,
        ready: false,
        revision: null,
        network: { name: "default", exists: false, active: false, autostart: false, compatible: false, bridge: "virbr0" },
        pool: { name: "default", exists: false, active: false, autostart: false, compatible: false, targetPath: "/var/lib/libvirt/images" },
        conflicts: ["The restricted libvirt foundation inspector is unavailable"],
        planAvailable: false,
        changes: [],
        boundary: { mutationPerformed: false, browserResourceAccepted: false },
      };
    }
  }

  /** Pin the current safe-to-initialize revision (staging-time, server-derived). */
  async function prepareOperation() {
    const state = await inspect();
    if (state.ready) throw new Error("The canonical default libvirt network and storage pool are already ready");
    if (!state.planAvailable || !/^[a-f0-9]{64}$/.test(String(state.revision ?? ""))) throw new Error(state.conflicts?.[0] ?? "The canonical libvirt foundation cannot be initialized safely");
    return { foundationId: newId(), expectedRevision: state.revision };
  }


  return { inspect, prepareOperation };
}
