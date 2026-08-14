import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireVmActionAuthorization, vmActionsConfiguration } from "./auth.mjs";
import { createLibvirtService, getSetupPlan, validateAction, validateDomainName } from "./libvirt.mjs";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const libvirt = createLibvirtService();
const vmActions = vmActionsConfiguration();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  next();
});

app.get("/api/v1/health", (_request, response) => {
  response.json({
    status: "ok",
    product: "BoxPilot",
    version: "0.2.0",
    mode: "host-aware",
    safeMode: !vmActions.enabled,
    hostMutationsEnabled: vmActions.enabled,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/capabilities", (_request, response) => {
  response.json({
    inventory: "mixed-live-and-demo",
    composeInspection: "browser-only",
    supportBundle: "browser-only",
    backups: "planned",
    migrations: "planned",
    privilegedHelper: "not-installed",
    virtualization: "live-libvirt",
    vmActions: {
      enabled: vmActions.enabled,
      reason: vmActions.reason,
    },
  });
});

app.get("/api/v1/virtualization/status", async (_request, response) => {
  response.json({
    ...(await libvirt.getStatus()),
    actions: { enabled: vmActions.enabled, reason: vmActions.reason },
  });
});

app.get("/api/v1/virtualization/domains", async (_request, response) => {
  const result = await libvirt.listDomains();
  response.status(result.connected ? 200 : 503).json(result);
});

app.get("/api/v1/virtualization/setup-plan", (_request, response) => {
  response.json(getSetupPlan());
});

app.post(
  "/api/v1/virtualization/domains/:name/actions",
  requireVmActionAuthorization(vmActions),
  async (request, response) => {
    const { name } = request.params;
    const { action } = request.body ?? {};
    if (!validateDomainName(name) || !validateAction(action)) {
      response.status(400).json({ error: "Invalid domain name or unsupported action", code: "invalid_action" });
      return;
    }
    try {
      const result = await libvirt.runDomainAction(name, action);
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), event: "vm_action", domain: name, action, result: "accepted" }));
      response.json(result);
    } catch (error) {
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "vm_action", domain: name, action, result: "failed" }));
      response.status(409).json({ error: error.message, code: "libvirt_action_failed" });
    }
  },
);

app.use(express.static(dist, { index: false }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(dist, "index.html"));
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(port, host, () => {
  console.log(`BoxPilot 0.2.0 listening on http://${host}:${port}`);
  console.log(vmActions.enabled ? "Authenticated VM lifecycle actions are enabled." : `Safe mode: ${vmActions.reason}.`);
});
