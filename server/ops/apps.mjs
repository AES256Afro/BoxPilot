import { defineOperation } from "./registry.mjs";

const idField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ };
const valuesField = { type: "object", optional: true, validate: (value) => (Object.keys(value).every((key) => ["ports", "env", "volumes"].includes(key)) ? null : "may only contain ports, env, and volumes") };
const minutes = (value) => value * 60_000;

/** Catalog application operations — one generic implementation for every manifest. */
export function appOperations() {
  return [
    defineOperation({ id: "app.inspect", title: "Inspect catalog applications", risk: "low", readOnly: true, description: "Installed state, container status, and ports for every catalog application.", run: (_p, { apps }) => apps.inspect({}) }),
    defineOperation({ id: "app.updates.inspect", title: "Check application updates", risk: "low", readOnly: true, description: "Compares installed applications with the current catalog.", run: (_p, { apps }) => apps.checkUpdates() }),
    defineOperation({
      id: "app.logs", title: "Read application logs", risk: "low", readOnly: true, timeoutMs: 60_000,
      parameters: { fields: { id: idField, lines: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 1000 ? null : "must be 1-1000") } } },
      run: (parameters, { apps }) => apps.logs(parameters),
    }),
    defineOperation({
      id: "app.install", title: "Install application", risk: "medium", timeoutMs: minutes(25),
      description: "Writes the compose project, pulls the image, starts the container, and waits for it to be healthy; rolls back on failure.",
      parameters: { fields: { id: idField, values: valuesField } },
      run: (parameters, { apps, progress }) => apps.install({ id: parameters.id, values: parameters.values ?? {} }, { progress }),
    }),
    defineOperation({
      id: "app.uninstall", title: "Uninstall application (keep data)", risk: "medium", timeoutMs: minutes(10),
      description: "Stops and removes the container; the application's data directory is kept for reinstall.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: false }, { progress }),
    }),
    defineOperation({
      id: "app.purge", title: "Uninstall application and delete its data", risk: "high", timeoutMs: minutes(10),
      description: "Stops and removes the container and deletes everything under the application's data directory.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: true }, { progress }),
    }),
    defineOperation({
      id: "app.update", title: "Update application", risk: "medium", timeoutMs: minutes(40),
      description: "Pulls the catalog's current image and recreates the container; restores the previous image if it fails to become healthy.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.update({ id: parameters.id }, { progress }),
    }),
    defineOperation({
      id: "app.reconfigure", title: "Change application settings", risk: "medium", timeoutMs: minutes(15),
      description: "Rewrites ports, settings, and volume paths and recreates the container; restores the previous configuration on failure.",
      parameters: { fields: { id: idField, values: valuesField } },
      run: (parameters, { apps, progress }) => apps.reconfigure({ id: parameters.id, values: parameters.values ?? {} }, { progress }),
    }),
    defineOperation({
      id: "app.action", title: "Start, stop, or restart application", risk: "low", timeoutMs: minutes(5),
      parameters: { fields: { id: idField, action: { type: "string", enum: ["start", "stop", "restart"] } } },
      run: (parameters, { apps, progress }) => apps.action(parameters, { progress }),
    }),
  ];
}
