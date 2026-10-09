/**
 * Where the model gateway's pieces live (M45.3), in one place for the service, the root tasks that
 * set it up and the tests that hold the unit to them.
 */
export const gatewayUnit = "boxpilot-model-gateway.service";
export const gatewayUser = "boxpilot-model-gateway";
/** The key, root-only; systemd hands it to the gateway by LoadCredential under this name. */
export const keyFile = "/etc/boxpilot/secrets/anthropic-api-key";
export const credentialName = "anthropic-api-key";
/** What the owner set: `{ capUsd }`, readable by the gateway, read on every call. */
export const settingsFile = "/etc/boxpilot/model-gateway.json";
export const defaultGatewaySocket = "/run/boxpilot-model-gateway/gateway.sock";
