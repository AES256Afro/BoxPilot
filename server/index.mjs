import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/api/v1/health", (_request, response) => {
  response.json({
    status: "ok",
    product: "BoxPilot",
    version: "0.1.0",
    mode: "prototype",
    safeMode: true,
    hostMutationsEnabled: false,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/capabilities", (_request, response) => {
  response.json({
    inventory: "demo-data",
    composeInspection: "browser-only",
    supportBundle: "browser-only",
    backups: "planned",
    migrations: "planned",
    privilegedHelper: "not-installed",
  });
});

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
  console.log(`BoxPilot prototype listening on http://${host}:${port}`);
  console.log("Safe mode is active. Host mutations are disabled.");
});
