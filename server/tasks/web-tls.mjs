/**
 * A trusted certificate for BoxPilot on your LAN (M18.2).
 *
 * M18.1 lets the owner serve the control plane on the network address, but over plain HTTP the
 * password crosses the LAN in the clear. There is no public domain to get a real certificate for a
 * name like boxpilot.lan, so this creates a small local certificate authority once, keeps its
 * private key on the box, and issues a leaf certificate for the server's LAN names and address. The
 * owner installs the CA's public certificate on their devices one time; from then on the browser
 * trusts https://boxpilot.lan with no warning, the password is encrypted on the wire, and the
 * origin is a secure context (the hard prerequisite for passkeys, M19).
 *
 * Root-side (writes /etc/boxpilot/tls, opens the firewall, restarts the service). The CA private
 * key stays root-only; the leaf key is readable by the boxpilot group so the unprivileged web
 * process can present it; the certificates are world-readable because they are public by nature.
 * The restart is deferred like web.bind.set so this task can report success before the web process
 * it belongs to picks up the new listener.
 */
import { readFile, mkdir, chmod, rm } from "node:fs/promises";
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import { fixedRun } from "../exec.mjs";
import { webListenFromEnv } from "../env-file.mjs";
import { isLoopbackHost, setEnvValue } from "./web-bind.mjs";

const envPathDefault = process.env.BOXPILOT_ENV_FILE ?? "/etc/boxpilot/boxpilot.env";
const tlsDirDefault = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls";
const openssl = process.env.BOXPILOT_OPENSSL_BINARY ?? "/usr/bin/openssl";
const chownBin = "/bin/chown";
const ufw = "/usr/sbin/ufw";
const systemctl = "/usr/bin/systemctl";
const systemdRun = "/usr/bin/systemd-run";
const webGroup = "boxpilot";
const tlsPortDefault = "8443";
const caDays = "3650"; // The CA lasts ten years; reissuing it would un-trust every device that installed it.
const leafDays = "397"; // Browsers reject leaf certificates valid for much more than this.

const dnsLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A DNS name is one or more labels; an IPv4 address is four octets 0-255. */
export function isDnsName(value) {
  return typeof value === "string" && value.length <= 253 && value.split(".").every((label) => dnsLabel.test(label));
}
export function isIpv4(value) {
  const match = ipv4.exec(String(value ?? ""));
  return Boolean(match) && match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The OpenSSL v3 extension file for the leaf: the names and addresses the certificate is valid for,
 * marked as a server certificate that is not itself a CA. SANs are authoritative in modern
 * browsers, so every name a device might type has to appear here.
 */
export function buildExtFile({ dnsNames = [], ipAddresses = [] } = {}) {
  const sans = [
    ...dnsNames.map((name) => `DNS:${name}`),
    ...ipAddresses.map((address) => `IP:${address}`),
  ];
  if (!sans.length) throw new Error("a certificate needs at least one name or address");
  return [
    `subjectAltName = ${sans.join(", ")}`,
    "basicConstraints = CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "",
  ].join("\n");
}

/** Pull the SHA-256 fingerprint and the expiry out of `openssl x509 -fingerprint -enddate`. */
export function parseCertMeta(text) {
  const fingerprint = /(?:sha256 )?Fingerprint=([0-9A-F:]+)/i.exec(String(text ?? ""))?.[1] ?? null;
  const notAfter = /notAfter=(.+)/.exec(String(text ?? ""))?.[1]?.trim() ?? null;
  return { fingerprint, notAfter };
}

async function fileExists(files, path) {
  try { await files.readFile(path, "utf8"); return true; } catch { return false; }
}

export async function webTlsProvision(
  { names = [], ipAddresses = [], port = tlsPortDefault } = {},
  {
    run = fixedRun,
    log = null,
    files = { readFile, writeFile, mkdir, chmod, rm },
    dir = tlsDirDefault,
    envPath = envPathDefault,
  } = {},
) {
  const dnsNames = [...new Set(names.map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
  const addresses = [...new Set(ipAddresses.map((address) => String(address).trim()).filter(Boolean))];
  if (!dnsNames.length) throw new Error("provisioning needs at least one DNS name");
  const badName = dnsNames.find((name) => !isDnsName(name));
  if (badName) throw new Error(`not a valid DNS name: ${badName}`);
  const badAddress = addresses.find((address) => !isIpv4(address));
  if (badAddress) throw new Error(`not a valid IPv4 address: ${badAddress}`);
  const tlsPort = String(port).match(/^\d{2,5}$/) ? String(port) : tlsPortDefault;

  const caKey = `${dir}/ca.key`;
  const caCrt = `${dir}/ca.crt`;
  const leafKey = `${dir}/leaf.key`;
  const leafCrt = `${dir}/leaf.crt`;
  const leafCsr = `${dir}/leaf.csr`;
  const extPath = `${dir}/leaf.ext`;

  const step = async (binary, args, label) => {
    const result = await run(binary, args, { timeout: 60_000 });
    if (!result.ok) throw new Error(`${label} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result;
  };

  await files.mkdir(dir, { recursive: true, mode: 0o755 }).catch(() => {});

  // The CA is created once and then reused, so a device that trusted it stays trusted. Reissuing it
  // would silently break every installed certificate, which is worse than a longer-lived key kept
  // root-only on the box.
  const haveCa = (await fileExists(files, caKey)) && (await fileExists(files, caCrt));
  if (!haveCa) {
    log?.("Creating the BoxPilot local certificate authority", "stdout");
    await step(openssl, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKey], "generate CA key");
    // M73: the CA private key signs every certificate a device trusts; it is root's alone or nobody's.
    await files.chmod(caKey, 0o600).catch((error) => { throw new Error(`Could not make the CA key readable by root only: ${error.message}`); });
    await step(openssl, [
      "req", "-x509", "-new", "-nodes", "-key", caKey, "-sha256", "-days", caDays, "-out", caCrt,
      "-subj", "/O=BoxPilot/CN=BoxPilot Local CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], "self-sign CA");
    await files.chmod(caCrt, 0o644).catch(() => {});
  }

  // A fresh leaf every time keeps the SAN list and the expiry current for whatever names were asked.
  log?.(`Issuing a certificate for ${dnsNames.join(", ")}`, "stdout");
  await files.writeFile(extPath, buildExtFile({ dnsNames, ipAddresses: addresses }));
  await step(openssl, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", leafKey], "generate leaf key");
  await step(openssl, ["req", "-new", "-key", leafKey, "-out", leafCsr, "-subj", `/CN=${dnsNames[0]}`], "build CSR");
  await step(openssl, [
    "x509", "-req", "-in", leafCsr, "-CA", caCrt, "-CAkey", caKey, "-CAcreateserial",
    "-out", leafCrt, "-days", leafDays, "-sha256", "-extfile", extPath,
  ], "sign leaf");

  // The web process runs as boxpilot and must read the key it presents; the CA private key never
  // leaves root. Certificates are public, so their mode does not matter.
  // M73: both are essential. Without them the service cannot read its key after the restart, so
  // this fails before the env file points at the key: the plain HTTP path keeps working as it was.
  const handed = await run(chownBin, [`root:${webGroup}`, leafKey], { timeout: 15_000 });
  if (!handed.ok) throw new Error(`Issued the certificate, but could not give its key to the ${webGroup} group (${handed.stderr || "chown failed"}), so the web service could not read it. Nothing was switched to HTTPS.`);
  await files.chmod(leafKey, 0o640).catch((error) => { throw new Error(`Issued the certificate, but could not make its key readable by the ${webGroup} group (${error.message}). Nothing was switched to HTTPS.`); });
  await files.chmod(leafCrt, 0o644).catch(() => {});
  await files.rm(leafCsr, { force: true }).catch(() => {});
  await files.rm(extPath, { force: true }).catch(() => {});

  const leafMeta = parseCertMeta((await run(openssl, ["x509", "-in", leafCrt, "-noout", "-fingerprint", "-sha256", "-enddate"], { timeout: 15_000 })).stdout);
  const caMeta = parseCertMeta((await run(openssl, ["x509", "-in", caCrt, "-noout", "-fingerprint", "-sha256"], { timeout: 15_000 })).stdout);

  // Point the web process at the certificate, and record the port it should open a TLS listener on.
  const before = await files.readFile(envPath, "utf8").catch(() => "");
  let env = setEnvValue(before, "BOXPILOT_TLS_CERT", leafCrt);
  env = setEnvValue(env, "BOXPILOT_TLS_KEY", leafKey);
  env = setEnvValue(env, "BOXPILOT_TLS_PORT", tlsPort);
  await files.writeFile(envPath, env);

  // Open the HTTPS port for the network; harmless if it is already open. HTTPS still works on the
  // tailnet and from the box without it, so a failure is a warning the job shows (M73), not a failure.
  // M90: only while LAN access is on. The HTTPS listener binds the same address as HTTP, so with LAN
  // access off it answers on loopback and an open port reached nothing; turning LAN access on opens it
  // (web-bind.mjs), and a renewal while it is off leaves the firewall as it was.
  /** @type {string[]} */
  const warnings = [];
  const onLan = !isLoopbackHost(webListenFromEnv(before).webHost);
  if (onLan) {
    const opened = await run(ufw, ["allow", `${tlsPort}/tcp`], { timeout: 30_000 });
    if (!opened.ok && !/ENOENT/.test(opened.stderr)) {
      const warning = `HTTPS is set up, but the firewall could not be opened for port ${tlsPort} (${opened.stderr || "ufw failed"}), so other devices on the network may not reach it; allow ${tlsPort}/tcp on the Firewall page.`;
      warnings.push(warning);
      log?.(warning, "stderr");
    }
  } else {
    log?.(`LAN access is off, so port ${tlsPort} stays closed; turning LAN access on opens it`, "stdout");
  }

  // Restart a few seconds out so the response returns first. The plain HTTP path is untouched, so a
  // hiccup here cannot lock the owner out.
  const scheduled = await run(systemdRun, ["--quiet", "--on-active", "5", "--unit", "boxpilot-tls", systemctl, "restart", "boxpilot.service"], { timeout: 30_000 });
  if (!scheduled.ok) throw new Error(`Issued the certificate but could not schedule the restart: ${scheduled.stderr || "systemd-run failed"}. Restart boxpilot.service to apply it.`);

  return {
    names: dnsNames,
    ipAddresses: addresses,
    port: Number(tlsPort),
    leafFingerprint: leafMeta.fingerprint,
    leafNotAfter: leafMeta.notAfter,
    caFingerprint: caMeta.fingerprint,
    caPath: caCrt,
    restartScheduled: true,
    ...(warnings.length ? { warnings } : {}),
  };
}
