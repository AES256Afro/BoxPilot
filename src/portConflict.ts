export interface PortHolder {
  name: string | null
  app: string | null
  composeProject: string | null
}

export interface PortConflict {
  label: string
  port: number
  protocol: string
  listeners: string[]
  containers?: PortHolder[]
}

/** What to tell the owner when an install's port is taken: who holds it, and how to free it. */
export function describePortConflict(conflict: PortConflict, appName: (id: string) => string | null = () => null): string {
  const held = conflict.listeners.join(", ")
  // "Pick another port" is useless advice for a DNS server, and resolved is the usual culprit.
  if (conflict.port === 53 && held.includes("127.0.0.53")) {
    return `Port 53 is held by Ubuntu's own resolver (${held}). Set DNSStubListener=no in /etc/systemd/resolved.conf, restart systemd-resolved, then install again.`
  }
  const where = `${conflict.label}: port ${conflict.port}/${conflict.protocol} is already in use on this server`
  const holder = conflict.containers?.[0]
  if (!holder?.name) return `${where} (${held}). Pick another port.`
  if (holder.app) {
    return `${where} by ${appName(holder.app) ?? holder.app}, installed through BoxPilot (container ${holder.name}). Pick another port, or uninstall that app first.`
  }
  if (holder.composeProject) {
    return `${where} by container ${holder.name}, part of the Docker Compose project "${holder.composeProject}" that BoxPilot didn't create. Pick another port, or stop that project with \`docker compose -p ${holder.composeProject} down\`.`
  }
  return `${where} by container ${holder.name}, which BoxPilot didn't create. Pick another port, or stop it with \`docker stop ${holder.name}\`.`
}
