import { randomUUID } from "node:crypto";
import net from "node:net";

export function createHelperClient({ socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock", timeoutMs = 5000 } = {}) {
  function request(operation, parameters = {}) {
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      const id = randomUUID();
      let payload = "";
      let settled = false;

      function fail(error) {
        if (settled) return;
        settled = true;
        connection.destroy();
        reject(error);
      }

      connection.setEncoding("utf8");
      connection.setTimeout(timeoutMs);
      connection.on("connect", () => connection.write(`${JSON.stringify({ version: 1, id, operation, parameters })}\n`));
      connection.on("data", (chunk) => { payload += chunk; });
      connection.on("end", () => {
        if (settled) return;
        try {
          const response = JSON.parse(payload.trim());
          if (response.id !== id) throw new Error("Helper response id did not match the request");
          if (!response.ok) throw new Error(response.error ?? "Helper operation failed");
          settled = true;
          resolve(response.result);
        } catch (error) {
          fail(error);
        }
      });
      connection.on("timeout", () => fail(new Error("Helper request timed out")));
      connection.on("error", (error) => fail(new Error(`Helper unavailable: ${error.message}`)));
    });
  }

  return { socketPath, request };
}
