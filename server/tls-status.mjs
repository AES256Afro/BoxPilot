/**
 * What the web process can tell about the LAN certificate (M18.2).
 *
 * The unprivileged web process only reads the public certificates (never the keys) to report
 * whether HTTPS on the LAN is set up, which names it covers, and the fingerprints the owner can
 * check against when installing the CA on a device. Parsing is done with Node's built-in
 * X509Certificate so nothing shells out to openssl here.
 */
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";

const tlsDirDefault = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls";

/** The names a certificate is valid for, from its subjectAltName ("DNS:a, IP Address:b"). */
export function parseSubjectAltNames(subjectAltName) {
  if (!subjectAltName) return { dnsNames: [], ipAddresses: [] };
  const dnsNames = [];
  const ipAddresses = [];
  for (const entry of String(subjectAltName).split(",").map((part) => part.trim())) {
    const [kind, ...rest] = entry.split(":");
    const value = rest.join(":").trim();
    if (!value) continue;
    if (kind === "DNS") dnsNames.push(value);
    else if (kind.startsWith("IP")) ipAddresses.push(value);
  }
  return { dnsNames, ipAddresses };
}

/**
 * Read the certificate state from the TLS directory. Returns { provisioned: false } when no leaf
 * exists yet, and never throws — a missing or unreadable file just means "not set up".
 */
export async function readTlsStatus({ dir = tlsDirDefault, files = { readFile }, port } = {}) {
  const tlsPort = Number.parseInt(process.env.BOXPILOT_TLS_PORT ?? String(port ?? 8443), 10);
  let leafPem;
  try {
    leafPem = await files.readFile(`${dir}/leaf.crt`, "utf8");
  } catch {
    return { provisioned: false, port: tlsPort };
  }
  try {
    const leaf = new X509Certificate(leafPem);
    const { dnsNames, ipAddresses } = parseSubjectAltNames(leaf.subjectAltName);
    let caFingerprint = null;
    try { caFingerprint = new X509Certificate(await files.readFile(`${dir}/ca.crt`, "utf8")).fingerprint256; } catch { /* CA optional here */ }
    return {
      provisioned: true,
      port: tlsPort,
      names: dnsNames,
      ipAddresses,
      fingerprint: leaf.fingerprint256,
      notAfter: leaf.validTo,
      caFingerprint,
    };
  } catch {
    // A corrupt leaf is treated as not provisioned so the owner can simply re-run provisioning.
    return { provisioned: false, port: tlsPort };
  }
}
