// What BoxPilot's middleware adds to an Express request (server/security.mjs, server/routes/access.mjs).
import "express-serve-static-core";

declare global {
  namespace BoxPilot {
    type Role = "owner" | "operator" | "viewer" | "disabled";

    /** A signed-in session as `requireSession` attaches it. */
    interface Session {
      id: string;
      token: string;
      tokenHash: string;
      owner: { id: string; username: string; role: Role };
      csrfToken: string;
      expiresAt: string;
      elevatedUntil: string | null;
      address: string | null;
    }
  }
}

declare module "express-serve-static-core" {
  interface Request {
    boxpilotSession?: BoxPilot.Session;
    /** Why a presented session was ended rather than honoured. */
    boxpilotSignedOut?: "address-changed";
    /** The agents runner's identity on its own routes. */
    agentRunner?: { runnerId: string };
  }
}
