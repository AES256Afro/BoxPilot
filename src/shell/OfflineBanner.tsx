import { checkConnection, useConnection } from "../pwa/connection";
import { Button, Notice } from "../ui";
import "./offline.css";

/**
 * Said under the bar while this device cannot reach BoxPilot (M25.1): whether the phone is offline
 * or BoxPilot is not answering (a phone away from home, off the tailnet), when BoxPilot last
 * answered, and what that means - what is on screen was read before, and nothing can be approved or
 * run until it answers. Today shows its own last known state, marked the same way.
 */
export function OfflineBanner({ now = Date.now }: { now?: () => number }) {
  const connection = useConnection();
  if (connection.online && connection.reachable) return null;
  const heard = connection.lastHeardAt ? new Date(connection.lastHeardAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const since = heard && now() - (connection.lastHeardAt ?? 0) < 24 * 60 * 60_000 ? ` BoxPilot last answered at ${heard}.` : "";
  return (
    <Notice
      tone="warning"
      className="offline-banner"
      live
      title={connection.online ? "BoxPilot is not answering" : "You are offline"}
      action={connection.online ? <Button onClick={() => void checkConnection()}>Try again</Button> : undefined}
    >
      {connection.online
        ? `What is on screen was read before.${since} Away from home? Check that Tailscale is connected on this device. Approvals and actions wait until BoxPilot answers.`
        : `What is on screen was read before you went offline.${since} Approvals and actions wait until you are back online.`}
    </Notice>
  );
}
