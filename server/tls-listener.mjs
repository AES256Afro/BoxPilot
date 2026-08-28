/**
 * The optional HTTPS listener for the LAN (M18.2).
 *
 * When BOXPILOT_TLS_CERT and BOXPILOT_TLS_KEY point at a certificate the provisioning task issued,
 * the web process opens a second listener that terminates TLS itself, so a browser reaches
 * https://boxpilot.lan:8443 with an encrypted, trusted connection. The plain HTTP listener is
 * untouched: the Tailscale Serve path keeps working exactly as before, and if the certificate is
 * missing or unreadable this logs and returns null rather than taking the process down.
 */
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";

/**
 * Start the HTTPS listener if a certificate is configured and readable. Injectable for tests.
 * Returns the server, or null when TLS is not set up (the normal default) or cannot start.
 */
export function startTlsListener(
  app,
  {
    host = "127.0.0.1",
    env = process.env,
    readFile = readFileSync,
    createServer = createHttpsServer,
    log = console,
    onError = () => {},
  } = {},
) {
  const certPath = env.BOXPILOT_TLS_CERT;
  const keyPath = env.BOXPILOT_TLS_KEY;
  if (!certPath || !keyPath) return null;
  const port = Number.parseInt(env.BOXPILOT_TLS_PORT ?? "8443", 10);
  let cert;
  let key;
  try {
    cert = readFile(certPath);
    key = readFile(keyPath);
  } catch (error) {
    log.warn?.(`HTTPS is configured but the certificate could not be read (${error.message}); HTTP is still serving.`);
    return null;
  }
  let server;
  try {
    server = createServer({ cert, key }, app);
  } catch (error) {
    log.warn?.(`HTTPS is configured but the certificate could not be loaded (${error.message}); HTTP is still serving.`);
    return null;
  }
  // A listener error (e.g. the port is taken) must not crash the process or the HTTP listener.
  server.on("error", (error) => {
    log.warn?.(`The HTTPS listener on ${host}:${port} failed (${error.message}); HTTP is still serving.`);
    onError(error);
  });
  server.listen(port, host, () => log.log?.(`BoxPilot listening on https://${host}:${port}`));
  return server;
}
