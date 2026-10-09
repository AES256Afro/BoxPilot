/**
 * Claude for the agents, as the web service knows it (M45.3, ADR-013): whether the owner connected
 * it, the model they chose and the monthly cap, recorded when those operations finish; what the
 * model gateway says of the month so far; and the call itself, held to the cap here first. The
 * gateway holds every call to the cap a second time, from its own count. The key is never here.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { offeredModels } from "../model-gateway/terms.mjs";
import { createGatewayClient } from "../model-gateway/socket.mjs";

export const cloudSetting = "agentsCloud";
export const cloudSpendSetting = "agentsCloudSpend";

const defaults = Object.freeze({ connected: false, capUsd: null, model: offeredModels[0], connectedAt: null });

const cents = (value) => Math.round(Number(value) * 1_000_000) / 1_000_000;

/**
 * The names that say whose house this is, for the stand-ins a run on Claude gets: this server's
 * host name (and its first label, when it has dots) and the accounts people sign in with (a user id
 * of 1000 or more in /etc/passwd). Private addresses, MACs and local domains are found by shape.
 */
export function houseNames({ hostname = os.hostname(), passwd = () => readFileSync("/etc/passwd", "utf8") } = {}) {
  const hosts = [hostname, String(hostname).split(".")[0]].filter(Boolean);
  let users = [];
  try {
    users = String(passwd()).split("\n").map((line) => line.split(":")).filter((fields) => Number(fields[2]) >= 1000 && Number(fields[2]) < 65534).map((fields) => fields[0]);
  } catch {
    users = [];
  }
  return { hosts: [...new Set(hosts)], domains: String(hostname).includes(".") ? [hostname] : [], users };
}

export function createAgentsCloud({ state, gateway = createGatewayClient(), now = () => Date.now() }) {
  const settings = () => ({ ...defaults, ...(state.getSetting(cloudSetting) ?? {}) });
  const save = (change, actorId) => state.setSetting(cloudSetting, { ...settings(), ...change }, { updatedBy: actorId ?? null });
  const monthNow = () => new Date(now()).toISOString().slice(0, 7);
  /** BoxPilot's own count of the month, apart from the gateway's: the first of the two caps. */
  const spend = () => {
    const saved = state.getSetting(cloudSpendSetting) ?? null;
    return saved?.month === monthNow() ? { month: saved.month, spentUsd: cents(saved.spentUsd ?? 0), calls: Number(saved.calls) || 0 } : { month: monthNow(), spentUsd: 0, calls: 0 };
  };
  const count = (costUsd) => {
    const month = spend();
    state.setSetting(cloudSpendSetting, { month: month.month, spentUsd: cents(month.spentUsd + (Number(costUsd) || 0)), calls: month.calls + 1 });
  };
  const failure = (code, message) => Object.assign(new Error(message), { code });
  // A gateway that just failed to answer (M45.4): runs are not given Claude for a minute after, so
  // each does not wait on it in turn; the first call or status read that gets through clears it.
  const quietMs = 60_000;
  let downUntil = 0;
  const heard = (error) => {
    if (!error) downUntil = 0;
    else if (["gateway-down", "unreachable"].includes(error?.code)) downUntil = now() + quietMs;
  };

  return {
    settings,
    spend,
    /** Whether a run may be given Claude now: connected, and the month not spent. */
    usable() {
      const chosen = settings();
      if (!chosen.connected) return { ok: false, reason: "Claude is not connected" };
      if (!(chosen.capUsd > 0)) return { ok: false, reason: "No monthly cap is set for Claude" };
      if (spend().spentUsd >= chosen.capUsd) return { ok: false, reason: `This month's cap of $${chosen.capUsd} for Claude is spent` };
      if (now() < downUntil) return { ok: false, reason: "The model gateway stopped answering a moment ago" };
      return { ok: true, reason: null };
    },
    /** agents.cloud.connect finished: the gateway took the key and Claude accepted it. */
    connected: (result, { actorId = null } = {}) => save({ connected: true, capUsd: result?.capUsd ?? null, connectedAt: new Date(now()).toISOString() }, actorId),
    capSet: (result, { actorId = null } = {}) => save({ capUsd: result?.capUsd ?? null }, actorId),
    disconnected: ({ actorId = null } = {}) => save({ connected: false }, actorId),

    /**
     * One model call through the gateway, held to the cap here before it goes. Rejects with a coded
     * Error (the gateway's codes, Claude's, `gateway-down`, or `budget` when the month is spent).
     */
    async chat(request, { signal, timeoutMs } = {}) {
      const usable = this.usable();
      if (!usable.ok) throw failure(settings().connected ? "budget" : "not-connected", usable.reason);
      let result;
      try {
        result = await gateway.chat(request, { signal, timeoutMs });
      } catch (error) {
        heard(error);
        throw error;
      }
      heard(null);
      count(result?.costUsd ?? 0);
      return result;
    },

    /** What the Agents section shows: the choice, the cap, and the month as the gateway counts it. */
    async state() {
      const chosen = settings();
      let month = null;
      let problem = null;
      if (chosen.connected) {
        try {
          month = await gateway.status();
          heard(null);
        } catch (error) {
          heard(error);
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
