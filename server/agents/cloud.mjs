/**
 * Claude for the agents, as the web service knows it (M45.3, ADR-013): whether the owner connected
 * it, the model they chose and the monthly cap, recorded when those operations finish, and what the
 * model gateway says of the month so far. The key is never here: the gateway alone holds it.
 */
import { offeredModels } from "../model-gateway/terms.mjs";
import { createGatewayClient } from "../model-gateway/socket.mjs";

export const cloudSetting = "agentsCloud";

const defaults = Object.freeze({ connected: false, capUsd: null, model: offeredModels[0], connectedAt: null });

export function createAgentsCloud({ state, gateway = createGatewayClient(), now = () => Date.now() }) {
  const settings = () => ({ ...defaults, ...(state.getSetting(cloudSetting) ?? {}) });
  const save = (change, actorId) => state.setSetting(cloudSetting, { ...settings(), ...change }, { updatedBy: actorId ?? null });

  return {
    settings,
    /** agents.cloud.connect finished: the gateway took the key and Claude accepted it. */
    connected: (result, { actorId = null } = {}) => save({ connected: true, capUsd: result?.capUsd ?? null, connectedAt: new Date(now()).toISOString() }, actorId),
    capSet: (result, { actorId = null } = {}) => save({ capUsd: result?.capUsd ?? null }, actorId),
    disconnected: ({ actorId = null } = {}) => save({ connected: false }, actorId),

    /** What the Agents section shows: the choice, the cap, and the month as the gateway counts it. */
    async state() {
      const chosen = settings();
      let month = null;
      let problem = null;
      if (chosen.connected) {
        try {
          month = await gateway.status();
        } catch (error) {
          problem = error?.code === "gateway-down" ? "The model gateway is not answering; agents run on the local model until it does" : String(error?.message ?? error);
        }
      }
      return {
        connected: chosen.connected,
        model: chosen.model,
        models: offeredModels,
        capUsd: chosen.capUsd,
        connectedAt: chosen.connectedAt,
        gateway: chosen.connected ? (month ? "answering" : "not answering") : "off",
        month: month?.month ?? null,
        spentUsd: month?.spentUsd ?? null,
        calls: month?.calls ?? null,
        problem,
      };
    },
  };
}
