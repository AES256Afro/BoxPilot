/**
 * Rendering an app's compose.yaml and .env.
 *
 * The values an owner types are data, not template source: these tests pin that a setting value
 * can never reach into another setting, and that a password survives storage exactly as typed.
 */
import { describe, expect, it } from "vitest";
import { envFileLine, renderCompose } from "./compose.mjs";

describe("values the owner typed", () => {
  const manifest = {
    id: "probe", sha256: "x", image: { reference: "example/probe:1" }, network: "bridge", ports: [], volumes: [],
    env: [{ name: "GREETING", secret: false }, { name: "ADMIN_PASSWORD", secret: true }],
    capabilities: [], devices: [], extraHosts: [], sysctls: [], sidecars: [],
  };

  it("never lets a setting value interpolate another setting", () => {
    // Compose would otherwise replace this with the real password on its way to the container.
    const { composeYaml, envFile } = renderCompose(manifest, { env: { GREETING: "${ADMIN_PASSWORD} $HOME", ADMIN_PASSWORD: "s3cret" }, ports: {}, volumes: {} });
    expect(composeYaml).toContain("$${ADMIN_PASSWORD} $$HOME");
    expect(composeYaml).not.toContain("s3cret");
    expect(envFile).toBe("ADMIN_PASSWORD='s3cret'\n");
  });

  it("stores a secret containing a dollar sign or a quote exactly as typed", () => {
    const password = "pa$$w0rd ${NOPE} it's fine";
    const { envFile } = renderCompose(manifest, { env: { ADMIN_PASSWORD: password }, ports: {}, volumes: {} });
    expect(envFile).toBe("ADMIN_PASSWORD='pa$$w0rd ${NOPE} it\\'s fine'\n");
    // The reader is the inverse: what comes back out is what the owner typed.
    expect(envFileLine("ADMIN_PASSWORD", password)).toBe(envFile.trimEnd());
  });
});
