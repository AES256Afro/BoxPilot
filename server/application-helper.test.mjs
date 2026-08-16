import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationHelperInternals, createApplicationHelper } from "./application-helper.mjs";
import { applicationInternals } from "./applications.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("curated Uptime Kuma helper", () => {
  it("reports Docker readiness through one fixed server-version query", async () => {
    const runDocker = vi.fn(async () => ({ stdout: "29.1.3", stderr: "" }));
    const helper = createApplicationHelper({ runDocker, dockerBinary: "/fixed/docker" });

    await expect(helper.inspectDocker()).resolves.toEqual({ available: true, version: "29.1.3" });
    expect(runDocker).toHaveBeenCalledWith("/fixed/docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
  });

  it("returns sanitized Docker inventory without labels, commands, or mount paths", async () => {
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "ps") return { stdout: JSON.stringify({ ID: "1234567890abcdef", Names: "example", Image: "example:1", State: "running", Status: "Up", Ports: "127.0.0.1:3000->3000/tcp", Networks: "example_default", Labels: "secret=value", Mounts: "/host/secret", Command: "token=secret" }), stderr: "" };
      if (args[0] === "image") return { stdout: JSON.stringify({ Repository: "example", Tag: "1", Digest: "sha256:abc", ID: "sha256:1234567890abcdef", Size: "10MB" }), stderr: "" };
      if (args[0] === "network") return { stdout: JSON.stringify({ Name: "example_default", Driver: "bridge", Scope: "local", Internal: "false", IPv6: "false", Labels: "secret=value" }), stderr: "" };
      if (args[0] === "volume") return { stdout: JSON.stringify({ Name: "example_data", Driver: "local", Scope: "local", Mountpoint: "/var/lib/docker/secret" }), stderr: "" };
      return { stdout: JSON.stringify([{ Name: "example", Status: "running(1)", ConfigFiles: "/private/compose.yaml" }]), stderr: "" };
    });
    const helper = createApplicationHelper({ runDocker });

    const result = await helper.inventoryDocker();

    expect(result).toMatchObject({ available: true, containers: [{ id: "1234567890ab", name: "example", state: "running" }], projects: [{ name: "example", status: "running(1)" }] });
    expect(JSON.stringify(result)).not.toMatch(/secret|Mountpoint|ConfigFiles|Command|Labels/);
  });

  it("redacts typed log sources and never returns credential-like values", async () => {
    const runJournal = vi.fn(async () => ({ stdout: JSON.stringify({ __REALTIME_TIMESTAMP: "1786817282000000", _SYSTEMD_UNIT: "boxpilot.service", PRIORITY: "6", MESSAGE: "login token=abcd password: hunter2 https://example.test/path?key=value" }), stderr: "" }));
    const helper = createApplicationHelper({ runJournal, journalctlBinary: "/fixed/journalctl" });

    const result = await helper.inspectLogs({ source: "boxpilot", limit: 25 });

    expect(result.entries[0]).toMatchObject({ unit: "boxpilot.service", priority: 6 });
    expect(result.entries[0].message).toContain("token=[REDACTED]");
    expect(result.entries[0].message).toContain("password=[REDACTED]");
    expect(result.entries[0].message).not.toContain("abcd");
    expect(result.entries[0].message).not.toContain("hunter2");
    expect(runJournal.mock.calls[0][1]).toEqual(["--unit", "boxpilot.service", "--unit", "boxpilot-helper.service", "--lines", "25", "--no-pager", "--output", "json", "--utc"]);
  });

  it("generates a loopback-only digest-pinned Compose definition", () => {
    const compose = applicationHelperInternals.composeDefinition(3101);
    expect(compose).toContain("louislam/uptime-kuma@sha256:");
    expect(compose).toContain('"127.0.0.1:3101:3001"');
    expect(compose).toContain("./data:/app/data");
    expect(compose).not.toContain("privileged:");
    expect(compose).not.toContain("docker.sock");
  });

  it("generates an exact-address digest-pinned Pi-hole stack without DHCP or broad capabilities", () => {
    const compose = applicationHelperInternals.piholeComposeDefinition("192.168.8.10", 8080);
    expect(compose).toContain("pihole/pihole@sha256:f7d1be");
    expect(compose).toContain('"192.168.8.10:53:53/tcp"');
    expect(compose).toContain('"192.168.8.10:53:53/udp"');
    expect(compose).toContain('"192.168.8.10:8080:80/tcp"');
    expect(compose).toContain("cap_drop:\n      - ALL");
    expect(compose).toContain("no-new-privileges:true");
    expect(applicationHelperInternals.piholeCapabilities).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETUID"]);
    expect(compose).not.toMatch(/NET_ADMIN|SYS_TIME|:67:|:123:|0\.0\.0\.0|docker\.sock|privileged:/);
  });

  it("deploys only the fixed adapter and verifies health inside the container", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-app-helper-"));
    directories.push(directory);
    const calls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: "healthy", stderr: "" };
      if (args[0] === "inspect") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:3101", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot: directory, dockerBinary: "/fixed/docker", runDocker, wait: vi.fn() });
    const result = await helper.deploy({ hostPort: 3101 });

    expect(result).toMatchObject({ installed: true, healthy: true, hostPort: 3101, dataPreserved: true });
    expect(await readFile(helper.composePath, "utf8")).toContain("127.0.0.1:3101:3001");
    expect(calls).toContainEqual(["inspect", "--format", "{{.State.Health.Status}}", "boxpilot-uptime-kuma"]);
    expect(calls.some((args) => args[0] === "compose" && args.includes("up"))).toBe(true);
  });

  it("derives lifecycle actions only for the exact managed Uptime Kuma identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-uptime-lifecycle-"));
    directories.push(directory);
    const dataDirectory = path.join(directory, "uptime-kuma", "data");
    await mkdir(dataDirectory, { recursive: true });
    const container = {
      Id: "a".repeat(64), Image: `sha256:${"b".repeat(64)}`, Name: "/boxpilot-uptime-kuma",
      State: { Running: true, Status: "running", Error: "", Health: { Status: "healthy" } },
      Config: { Image: applicationInternals.uptimeKumaImage, Labels: { "com.docker.compose.project": "boxpilot-uptime-kuma", "com.docker.compose.service": "uptime-kuma" } },
      HostConfig: { PortBindings: { "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "3101" }] }, RestartPolicy: { Name: "unless-stopped" }, Privileged: false, Devices: null, CapAdd: null },
      Mounts: [{ Type: "bind", Source: dataDirectory, Destination: "/app/data", RW: true }],
    };
    const runDocker = vi.fn(async () => ({ stdout: JSON.stringify(container), stderr: "" }));
    const helper = createApplicationHelper({ appRoot: directory, runDocker });

    const state = await helper.inspectUptimeKumaLifecycle();

    expect(state).toMatchObject({ installed: true, managed: true, state: "running", healthy: true, port: 3101, allowedActions: ["stop", "restart"], boundary: { loopbackOnly: true, exactDataMount: true, privileged: false, dockerSocketMounted: false, mutationPerformed: false } });
    expect(state.revision).toMatch(/^[a-f0-9]{64}$/);
    delete container.State.Health;
    await expect(helper.inspectUptimeKumaLifecycle()).resolves.toMatchObject({ installed: true, managed: true, healthy: false, allowedActions: ["stop", "restart"] });
    container.State.Health = { Status: "healthy" };
    container.HostConfig.Privileged = true;
    await expect(helper.inspectUptimeKumaLifecycle()).resolves.toMatchObject({ installed: true, managed: false, allowedActions: [] });
  });

  it("executes a revision-bound lifecycle action and preserves persistent data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-uptime-action-"));
    directories.push(directory);
    const dataDirectory = path.join(directory, "uptime-kuma", "data");
    await mkdir(dataDirectory, { recursive: true });
    let running = true;
    const calls = [];
    const container = () => ({
      Id: "c".repeat(64), Image: `sha256:${"d".repeat(64)}`, Name: "/boxpilot-uptime-kuma",
      State: { Running: running, Status: running ? "running" : "exited", Error: "", Health: { Status: running ? "healthy" : "none" } },
      Config: { Image: applicationInternals.uptimeKumaImage, Labels: { "com.docker.compose.project": "boxpilot-uptime-kuma", "com.docker.compose.service": "uptime-kuma" } },
      HostConfig: { PortBindings: { "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "3101" }] }, RestartPolicy: { Name: "unless-stopped" }, Privileged: false, Devices: null, CapAdd: null },
      Mounts: [{ Type: "bind", Source: dataDirectory, Destination: "/app/data", RW: true }],
    });
    const runDocker = vi.fn(async (_binary, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2] === "{{json .}}") return { stdout: JSON.stringify(container()), stderr: "" };
      if (args[0] === "stop") { running = false; return { stdout: "boxpilot-uptime-kuma", stderr: "" }; }
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    });
    const helper = createApplicationHelper({ appRoot: directory, runDocker });
    const before = await helper.inspectUptimeKumaLifecycle();

    const result = await helper.actionUptimeKuma({ action: "stop", expectedRevision: before.revision });

    expect(result).toMatchObject({ applicationId: "uptime-kuma", action: "stop", performed: true, state: "stopped", running: false, healthy: false, port: 3101, dataPreserved: true, boundary: { exactContainerOnly: true, imageChanged: false, composeChanged: false, dataDeleted: false, networkDeleted: false } });
    expect(calls).toContainEqual(["stop", "--time", "30", "boxpilot-uptime-kuma"]);
    await expect(helper.actionUptimeKuma({ action: "start", expectedRevision: before.revision })).rejects.toThrow("state changed");
  });

  it("derives Pi-hole lifecycle actions only for the exact network-critical managed identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-lifecycle-"));
    directories.push(directory);
    const piholeDirectory = path.join(directory, "pi-hole");
    const dataDirectory = path.join(piholeDirectory, "etc-pihole");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(piholeDirectory, "admin-password"), `PIHOLE_PASSWORD=${"A".repeat(43)}\n`, { mode: 0o600 });
    const container = {
      Id: "e".repeat(64), Image: `sha256:${"f".repeat(64)}`, Name: "/boxpilot-pi-hole",
      State: { Running: true, Status: "running", Error: "", Health: { Status: "healthy" } },
      Config: { Image: applicationInternals.piholeImage, Labels: { "com.docker.compose.project": "boxpilot-pi-hole", "com.docker.compose.service": "pi-hole" } },
      HostConfig: {
        PortBindings: { "53/tcp": [{ HostIp: "192.168.8.10", HostPort: "53" }], "53/udp": [{ HostIp: "192.168.8.10", HostPort: "53" }], "80/tcp": [{ HostIp: "192.168.8.10", HostPort: "8080" }] },
        RestartPolicy: { Name: "unless-stopped" }, Privileged: false, Devices: null,
        CapAdd: applicationHelperInternals.piholeCapabilities.map((capability) => `CAP_${capability}`), CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      },
      Mounts: [{ Type: "bind", Source: dataDirectory, Destination: "/etc/pihole", RW: true }],
    };
    const runDocker = vi.fn(async () => ({ stdout: JSON.stringify(container), stderr: "" }));
    const helper = createApplicationHelper({ appRoot: directory, runDocker });

    const state = await helper.inspectPiholeLifecycle();

    expect(state).toMatchObject({
      installed: true, managed: true, state: "running", healthy: true, lanAddress: "192.168.8.10", port: 8080,
      dnsTcpBound: true, dnsUdpBound: true, allowedActions: ["stop", "restart"],
      boundary: { privateLanOnly: true, exactDnsBindings: true, exactWebBinding: true, exactDataMount: true, secretFileReady: true, noNewPrivileges: true, dockerSocketMounted: false, dhcpEnabled: false, routerMutationPerformed: false, dnsCutoverPerformed: false, mutationPerformed: false },
    });
    expect(state.revision).toMatch(/^[a-f0-9]{64}$/);
    container.HostConfig.CapAdd.push("CAP_NET_ADMIN");
    await expect(helper.inspectPiholeLifecycle()).resolves.toMatchObject({ installed: true, managed: false, allowedActions: [] });
  });

  it("executes a revision-bound Pi-hole action while preserving DNS bindings, data, and the administrator secret", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-action-"));
    directories.push(directory);
    const piholeDirectory = path.join(directory, "pi-hole");
    const dataDirectory = path.join(piholeDirectory, "etc-pihole");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(piholeDirectory, "admin-password"), `PIHOLE_PASSWORD=${"B".repeat(43)}\n`, { mode: 0o600 });
    let running = true;
    const calls = [];
    const container = () => ({
      Id: "1".repeat(64), Image: `sha256:${"2".repeat(64)}`, Name: "/boxpilot-pi-hole",
      State: { Running: running, Status: running ? "running" : "exited", Error: "", Health: { Status: running ? "healthy" : "none" } },
      Config: { Image: applicationInternals.piholeImage, Labels: { "com.docker.compose.project": "boxpilot-pi-hole", "com.docker.compose.service": "pi-hole" } },
      HostConfig: {
        PortBindings: { "53/tcp": [{ HostIp: "192.168.8.10", HostPort: "53" }], "53/udp": [{ HostIp: "192.168.8.10", HostPort: "53" }], "80/tcp": [{ HostIp: "192.168.8.10", HostPort: "8080" }] },
        RestartPolicy: { Name: "unless-stopped" }, Privileged: false, Devices: null,
        CapAdd: applicationHelperInternals.piholeCapabilities.map((capability) => `CAP_${capability}`), CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      },
      Mounts: [{ Type: "bind", Source: dataDirectory, Destination: "/etc/pihole", RW: true }],
    });
    const runDocker = vi.fn(async (_binary, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2] === "{{json .}}") return { stdout: JSON.stringify(container()), stderr: "" };
      if (args[0] === "stop") { running = false; return { stdout: "boxpilot-pi-hole", stderr: "" }; }
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    });
    const helper = createApplicationHelper({ appRoot: directory, runDocker });
    const before = await helper.inspectPiholeLifecycle();

    const result = await helper.actionPihole({ action: "stop", expectedRevision: before.revision });

    expect(result).toMatchObject({
      applicationId: "pi-hole", action: "stop", performed: true, state: "stopped", running: false, healthy: false,
      lanAddress: "192.168.8.10", port: 8080, dnsTcpBound: true, dnsUdpBound: true, dataPreserved: true, secretPreserved: true,
      dhcpEnabled: false, routerMutationPerformed: false, dnsCutoverPerformed: false,
      boundary: { exactContainerOnly: true, imageChanged: false, composeChanged: false, dataDeleted: false, secretDeleted: false, networkDeleted: false, routerChanged: false, clientDnsChanged: false, tailscaleChanged: false },
    });
    expect(calls).toContainEqual(["stop", "--time", "30", "boxpilot-pi-hole"]);
  });

  it("removes a new Compose definition on failed first deployment without deleting data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-app-helper-"));
    directories.push(directory);
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "compose" && args.includes("up")) throw new Error("pull failed");
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot: directory, runDocker, wait: vi.fn() });

    await expect(helper.deploy({ hostPort: 3001 })).rejects.toThrow("Automated rollback completed");
    await expect(readFile(helper.composePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages Pi-hole with a root-only generated secret and verifies exact DNS and web bindings", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-helper-"));
    directories.push(directory);
    const calls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: "healthy", stderr: "" };
      if (args[0] === "inspect") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "port" && args[2] === "53/tcp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "53/udp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "80/tcp") return { stdout: "192.168.8.10:8080", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot: directory, dockerBinary: "/fixed/docker", runDocker, wait: vi.fn() });

    const result = await helper.deployPihole({ lanAddress: "192.168.8.10", webPort: 8080 });

    expect(result).toMatchObject({
      installed: true, healthy: true, lanAddress: "192.168.8.10", port: 8080,
      dnsTcpBound: true, dnsUdpBound: true, dhcpEnabled: false,
      routerMutationPerformed: false, dnsCutoverPerformed: false,
      dataPreserved: true, secretPreserved: true, backupProtected: false,
    });
    const secret = await readFile(helper.piholeSecretPath, "utf8");
    const password = secret.trim().split("=")[1];
    expect(JSON.stringify(result)).not.toContain(password);
    expect(await readFile(helper.piholeComposePath, "utf8")).toContain("192.168.8.10:53:53/udp");
    expect(secret).toMatch(/^PIHOLE_PASSWORD=[A-Za-z0-9_-]{43}\n$/);
    expect((await stat(helper.piholeSecretPath)).mode & 0o777).toBe(0o600);
    const composeUp = calls.find((args) => args[0] === "compose" && args.includes("up"));
    expect(composeUp).toEqual(expect.arrayContaining(["--env-file", helper.piholeSecretPath, "--file", helper.piholeComposePath]));
  });

  it("creates an integrity-addressed artifact and verifies an isolated no-network restore", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-backup-helper-"));
    directories.push(directory);
    const appRoot = path.join(directory, "apps");
    const appDirectory = path.join(appRoot, "uptime-kuma");
    await mkdir(path.join(appDirectory, "data"), { recursive: true });
    await writeFile(path.join(appDirectory, "data", "kuma.db"), "fixture");
    await writeFile(path.join(appDirectory, "compose.yaml"), "services: {}\n");
    const dockerCalls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      dockerCalls.push(args);
      if (args[0] === "inspect" && args[2] === "{{json .State}}") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: "healthy", stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:3101", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const runArchive = vi.fn(async (_binary, args) => {
      const fileIndex = args.indexOf("--file") + 1;
      if (args.includes("--create")) await writeFile(args[fileIndex], "verified archive fixture");
      if (args.includes("--extract")) await mkdir(path.join(args[args.indexOf("--directory") + 1], "data"), { recursive: true });
      return { stdout: "", stderr: "" };
    });
    const times = [1000, 1250];
    const helper = createApplicationHelper({ appRoot, runDocker, runArchive, wait: vi.fn(), clock: () => times.shift() });
    const backupId = "11111111-1111-4111-8111-111111111111";

    const result = await helper.backup({ backupId });

    expect(result).toMatchObject({ backupId, applicationId: "uptime-kuma", destination: "local-managed", downtimeMs: 250, sourceRestartVerified: true, restoreDrill: { passed: true, network: "none", publishedPorts: 0 } });
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dockerCalls).toContainEqual(["stop", "--time", "30", "boxpilot-uptime-kuma"]);
    expect(dockerCalls).toContainEqual(["start", "boxpilot-uptime-kuma"]);
    const drillRun = dockerCalls.find((args) => args[0] === "run");
    expect(drillRun).toContain("none");
    expect(drillRun.some((value) => String(value).includes("127.0.0.1:"))).toBe(false);
    expect(runArchive).toHaveBeenCalledTimes(2);
  });

  it("backs up Pi-hole configuration and its secret, restarts the source, and restore-tests without network or ports", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-backup-helper-"));
    directories.push(directory);
    const appRoot = path.join(directory, "apps");
    const appDirectory = path.join(appRoot, "pi-hole");
    await mkdir(path.join(appDirectory, "etc-pihole"), { recursive: true });
    await writeFile(path.join(appDirectory, "etc-pihole", "pihole.toml"), "dns.upstreams = [\"94.140.14.49\"]\n");
    await writeFile(path.join(appDirectory, "compose.yaml"), applicationHelperInternals.piholeComposeDefinition("192.168.8.10", 8080));
    const password = "A".repeat(43);
    await writeFile(path.join(appDirectory, "admin-password"), `PIHOLE_PASSWORD=${password}\n`);
    const dockerCalls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      dockerCalls.push(args);
      if (args[0] === "inspect" && args[2] === "{{json .State}}") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: "healthy", stderr: "" };
      if (args[0] === "port" && args[2] === "53/tcp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "53/udp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "80/tcp") return { stdout: "192.168.8.10:8080", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const runArchive = vi.fn(async (_binary, args) => {
      const filePath = args[args.indexOf("--file") + 1];
      if (args.includes("--create")) await writeFile(filePath, "verified Pi-hole archive fixture");
      if (args.includes("--extract")) {
        const target = args[args.indexOf("--directory") + 1];
        await mkdir(path.join(target, "etc-pihole"), { recursive: true });
        await writeFile(path.join(target, "compose.yaml"), applicationHelperInternals.piholeComposeDefinition("192.168.8.10", 8080));
        await writeFile(path.join(target, "admin-password"), `PIHOLE_PASSWORD=${password}\n`);
      }
      return { stdout: "", stderr: "" };
    });
    const times = [2000, 2450];
    const helper = createApplicationHelper({ appRoot, runDocker, runArchive, wait: vi.fn(), clock: () => times.shift() });
    const backupId = "22222222-2222-4222-8222-222222222222";

    const result = await helper.backupPihole({ backupId });

    expect(result).toMatchObject({
      backupId, applicationId: "pi-hole", destination: "local-managed", downtimeMs: 450,
      sourceRestartVerified: true, routerMutationPerformed: false, dnsCutoverPerformed: false,
      restoreDrill: {
        passed: true, network: "none", publishedPorts: 0, configurationIncluded: true,
        administratorSecretIncluded: true, routerMutationPerformed: false, dnsCutoverPerformed: false,
      },
    });
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(dockerCalls).toContainEqual(["stop", "--time", "30", "boxpilot-pi-hole"]);
    expect(dockerCalls).toContainEqual(["start", "boxpilot-pi-hole"]);
    const archiveCreate = runArchive.mock.calls.find(([, args]) => args.includes("--create"))[1];
    expect(archiveCreate).toEqual(expect.arrayContaining(["etc-pihole", "compose.yaml", "admin-password"]));
    const drillRun = dockerCalls.find((args) => args[0] === "run");
    expect(drillRun).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"]));
    expect(drillRun).not.toEqual(expect.arrayContaining(["--cap-add", "NET_ADMIN"]));
    expect(drillRun.some((value) => String(value).includes(":53:") || String(value).includes(":80:"))).toBe(false);
    const archive = path.join(directory, "backups", "pi-hole", `${backupId}.tar.gz`);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    await expect(stat(path.join(directory, "restore-drills", `pi-hole-${backupId}`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(helper.piholeBackupMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an interrupted Pi-hole backup only after exact source and orphan-drill identity checks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-recovery-helper-"));
    directories.push(directory);
    const appRoot = path.join(directory, "apps");
    const backupId = "33333333-3333-4333-8333-333333333333";
    const drillDirectory = path.join(directory, "restore-drills", `pi-hole-${backupId}`);
    const drillData = path.join(drillDirectory, "etc-pihole");
    await mkdir(path.join(directory, "backups", "pi-hole"), { recursive: true });
    await mkdir(drillData, { recursive: true });
    let sourceRunning = false;
    const dockerCalls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      dockerCalls.push(args);
      if (args[0] === "start" && args[1] === "boxpilot-pi-hole") {
        sourceRunning = true;
        return { stdout: "boxpilot-pi-hole", stderr: "" };
      }
      if (args[0] === "inspect" && args[2] === "{{json .State}}") return { stdout: JSON.stringify({ Running: sourceRunning, Status: sourceRunning ? "running" : "exited", Error: "", Health: { Status: sourceRunning ? "healthy" : "unhealthy" } }), stderr: "" };
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: sourceRunning ? "healthy" : "unhealthy", stderr: "" };
      if (args[0] === "inspect" && args[2] === "{{json .}}") return { stdout: JSON.stringify({
        Config: { Image: applicationHelperInternals.piholeComposeDefinition("192.168.8.10", 8080).match(/image: (.+)/)[1] },
        HostConfig: { NetworkMode: "none", PortBindings: {} },
        Mounts: [{ Source: drillData, Destination: "/etc/pihole" }],
      }), stderr: "" };
      if (args[0] === "port" && args[2] === "53/tcp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "53/udp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "80/tcp") return { stdout: "192.168.8.10:8080", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot, runDocker, wait: vi.fn() });
    await writeFile(helper.piholeBackupMarkerPath, `${JSON.stringify({ version: 1, backupId })}\n`, { mode: 0o600 });

    const recovery = await helper.recoverInterruptedPiholeBackup();

    expect(recovery).toEqual({ recovered: true, sourceRestarted: true, drillRemoved: true });
    expect(dockerCalls).toContainEqual(["start", "boxpilot-pi-hole"]);
    expect(dockerCalls).toContainEqual(["rm", "--force", "boxpilot-pi-hole-restore-drill"]);
    await expect(stat(helper.piholeBackupMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(drillDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without deleting an ambiguous interrupted Pi-hole restore container", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-pihole-recovery-ambiguous-"));
    directories.push(directory);
    const appRoot = path.join(directory, "apps");
    const backupId = "44444444-4444-4444-8444-444444444444";
    const drillDirectory = path.join(directory, "restore-drills", `pi-hole-${backupId}`);
    await mkdir(path.join(directory, "backups", "pi-hole"), { recursive: true });
    await mkdir(path.join(drillDirectory, "etc-pihole"), { recursive: true });
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "inspect" && args[2] === "{{json .State}}") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "inspect" && args[2] === "{{json .}}") return { stdout: JSON.stringify({ Config: { Image: "unreviewed/image:latest" }, HostConfig: { NetworkMode: "bridge", PortBindings: { "80/tcp": [{}] } }, Mounts: [] }), stderr: "" };
      if (args[0] === "port" && args[2] === "53/tcp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "53/udp") return { stdout: "192.168.8.10:53", stderr: "" };
      if (args[0] === "port" && args[2] === "80/tcp") return { stdout: "192.168.8.10:8080", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot, runDocker, wait: vi.fn() });
    await writeFile(helper.piholeBackupMarkerPath, `${JSON.stringify({ version: 1, backupId })}\n`, { mode: 0o600 });

    await expect(helper.recoverInterruptedPiholeBackup()).rejects.toThrow("strict identity checks");

    expect(runDocker).not.toHaveBeenCalledWith(expect.anything(), ["rm", "--force", "boxpilot-pi-hole-restore-drill"], expect.anything());
    await expect(stat(helper.piholeBackupMarkerPath)).resolves.toBeTruthy();
    await expect(stat(drillDirectory)).resolves.toBeTruthy();
  });
});
