import { timingSafeEqual } from "node:crypto";

export function vmActionsConfiguration(env = process.env) {
  const token = env.BOXPILOT_ADMIN_TOKEN ?? "";
  const requested = env.BOXPILOT_VM_ACTIONS_ENABLED === "true";
  const tokenValid = token.length >= 32;
  return {
    enabled: requested && tokenValid,
    requested,
    tokenValid,
    token,
    reason: !requested
      ? "VM actions are disabled by configuration"
      : !tokenValid
        ? "BOXPILOT_ADMIN_TOKEN must contain at least 32 characters"
        : "VM actions require bearer-token authorization",
  };
}

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function requireVmActionAuthorization(configuration) {
  return (request, response, next) => {
    if (!configuration.enabled) {
      response.status(403).json({ error: configuration.reason, code: "vm_actions_disabled" });
      return;
    }
    const authorization = request.get("authorization") ?? "";
    const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenMatches(candidate, configuration.token)) {
      response.status(401).json({ error: "Valid administrator token required", code: "unauthorized" });
      return;
    }
    next();
  };
}
