import { describe, expect, it } from "vitest";
import { loadCatalog } from "./index.mjs";
import { resolveValues } from "./schema.mjs";
import { renderCompose } from "./compose.mjs";

describe("Protec independent management portal", () => {
  it("uses a non-root image, persistent data, loopback binding, and a generated sign-in token", async () => {
    const { manifests, problems } = await loadCatalog();
    expect(problems.filter(item => item.file === "protec.yaml")).toEqual([]);
    const manifest = manifests.find(item => item.id === "protec");
    expect(manifest.health.kind).toBe("healthcheck");
    expect(manifest.signIn.passwordEnv).toBe("PROTEC_ADMIN_TOKEN");
    const { values, errors } = resolveValues(manifest, { exposure: "tailnet", env: { PROTEC_PUBLIC_URL: "https://portal.example.com" } });
    expect(errors).toEqual([]);
    const { compose, envFile, composeYaml } = renderCompose(manifest, values);
    expect(compose.services.protec.user).toBe("10001:10001");
    expect(compose.services.protec.ports).toEqual(["127.0.0.1:8765:8765"]);
    expect(compose.services.protec.volumes).toContain("./data:/data");
    const token = envFile.match(/PROTEC_ADMIN_TOKEN='([A-Za-z0-9_-]+)'/)[1];
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(composeYaml).not.toContain(token);
    expect(resolveValues(manifest, {}).errors.length).toBeGreaterThan(0);
  });
});
