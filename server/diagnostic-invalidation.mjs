/** Drop only evidence a settled mutation could have changed, including partial failures. */
export function invalidateOperationEvidence(job, { registry, inventory, prerequisites, helper }) {
  const operation = job.type?.startsWith("op:") ? job.type.slice(3) : null;
  if (operation && registry.get(operation)?.readOnly) return;
  inventory.forget();
  const reads = new Set(["system.controller.inspect"]);
  const system = /^(apt|prerequisite|service|system)\./.test(operation ?? "");
  if (system) {
    prerequisites.forget();
    reads.add("apt.health.inspect");
    for (const name of ["apt.unattended.inspect", "prerequisite.docker.inspect", "prerequisite.restic.inspect", "prerequisite.smartmontools.inspect", "prerequisite.virtualization.inspect", "virtualization.foundation.inspect"]) reads.add(name);
  }
  if (system || /^(app|container)\./.test(operation ?? "")) {
    for (const name of ["app.inspect", "container.docker.inventory", "app.backups.counts"]) reads.add(name);
  }
  if (system || /^(samba|storage|share)\./.test(operation ?? "")) reads.add("samba.inspect");
  if (system || /^nfs\./.test(operation ?? "")) reads.add("nfs.inspect");
  if (/^(firewall|network)\./.test(operation ?? "")) reads.add("firewall.inspect");
  if (/^host\./.test(operation ?? "")) reads.add("host.snapshot.inspect");
  helper.invalidate([...reads]);
}
