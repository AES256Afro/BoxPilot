import { useEffect, useState } from "react";

/**
 * The other machines on the owner's tailnet, as address suggestions for any host field (an SSH
 * backup destination, a NAS to mount). Names first — they survive address churn — online first,
 * this server excluded because pointing a backup or mount at yourself is never the intent.
 */
export function useTailnetHosts(): string[] {
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    fetch("/api/v1/network/tailnet")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { available?: boolean; peers?: Array<{ dnsName: string | null; address: string | null; online: boolean; isSelf: boolean }> } | null) => {
        if (!active || !body?.available || !Array.isArray(body.peers)) return;
        const peers = [...body.peers].filter((peer) => !peer.isSelf).sort((left, right) => Number(right.online) - Number(left.online));
        setHosts([...new Set(peers.flatMap((peer) => [peer.dnsName, peer.address].filter((entry): entry is string => Boolean(entry))))]);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return hosts;
}
