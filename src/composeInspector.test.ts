import { describe, expect, it } from "vitest";
import { inspectCompose } from "./composeInspector";

describe("inspectCompose", () => {
  it("counts a basic service and its published resources", () => {
    const result = inspectCompose(`services:
  app:
    image: example/app
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - app-data:/data
volumes:
  app-data:
`);

    expect(result.services).toBe(1);
    expect(result.publishedPorts).toBe(1);
    expect(result.volumeMounts).toBe(1);
    expect(result.risks).toEqual([]);
  });

  it("flags high-risk host access", () => {
    const result = inspectCompose(`services:
  admin:
    image: example/admin
    privileged: true
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host
`);

    expect(result.risks).toContain("Privileged container requested");
    expect(result.risks).toContain("Docker socket mounted");
    expect(result.risks).toContain("Host networking requested");
    expect(result.risks).toContain("Host root filesystem mounted");
  });
});
