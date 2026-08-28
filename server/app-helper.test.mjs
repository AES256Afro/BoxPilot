import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppHelper } from "./app-helper.mjs";
import { createCatalogService } from "./catalog/index.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function setup({ healthKind = "running", exitOnUp = false, failUp = false, crashLoop = false, networkGone_ = false, listDevices = undefined, chownDirectory = undefined, runCommand = undefined, execTable = { vpn: "running", leaks: false, noCurl: false } } = {}) {
  const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cat-")); directories.push(catalogDirectory);
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-approot-")); directories.push(catalogRoot);
  await writeFile(path.join(catalogDirectory, "demo.yaml"), `schemaVersion: 2\nid: demo\nname: Demo\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nports:\n  - id: web\n    container: 80\n    host: 8080\nvolumes:\n  - id: data\n    container: /data\n    path: data\n  - id: docker\n    container: /var/run/docker.sock\n    hostPath: /var/run/docker.sock\nenv:\n  - name: ADMIN_PASSWORD\n    type: password\n    generate: true\n  - name: TZ\n    default: Etc/UTC\nhealth:\n  kind: ${healthKind}\n  stableSeconds: 4\n  timeoutSeconds: 30\n`);
  const containers = new Map();
  const calls = [];
  const networkGone = { value: networkGone_ };
  const runDocker = vi.fn(async (_binary, args) => {
    calls.push(args.join(" "));
    if (args[0] === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
    if (args[0] === "inspect") {
      // Like the real CLI: any number of names, one line each, found ones printed even when
      // others are missing. The name is included only when the format asks for it.
      const wantsName = String(args[2] ?? "").includes('"name"');
      const lines = [];
      for (const name of args.slice(3)) {
        const container = containers.get(name);
        if (!container) continue;
        // A crash loop as Docker reports it: Running stays true through restart backoff while the
        // status reads "restarting" and RestartCount climbs.
        if (crashLoop && container.running) { container.status = "restarting"; container.restarts += 1; }
        lines.push(JSON.stringify(wantsName ? { name: `/${name}`, ...container } : container));
      }
      if (!lines.length) return { ok: false, stdout: "", stderr: "No such object" };
      return { ok: true, stdout: lines.join("\n"), stderr: "" };
    }
    if (args[0] === "logs") return { ok: true, stdout: "line1\npassword=hunter2", stderr: "" };
    if (args[0] === "exec") {
      // The kill-switch drill speaks to gluetun's control endpoint and probes the internet from
      // inside the app's namespace; the table scripts both, keyed by URL substring.
      const url = args[args.length - 1];
      const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
      const body = args.includes("-d") ? args[args.indexOf("-d") + 1] : null;
      if (url === "--version") return { ok: !execTable.noCurl, stdout: "curl 8", stderr: execTable.noCurl ? "no such file" : "" };
      if (url.includes("/v1/vpn/status") && method === "PUT") { execTable.vpn = JSON.parse(body).status; return { ok: true, stdout: JSON.stringify({ outcome: execTable.vpn }), stderr: "" }; }
      if (url.includes("/v1/vpn/status")) return { ok: true, stdout: JSON.stringify({ status: execTable.vpn }), stderr: "" };
      if (url.includes("/v1/publicip/ip")) return { ok: true, stdout: JSON.stringify(execTable.vpn === "running" ? { public_ip: "212.92.104.227", country: "Netherlands" } : {}), stderr: "" };
      if (url.includes("1.1.1.1")) return execTable.leaks || execTable.vpn === "running" ? { ok: true, stdout: "204", stderr: "" } : { ok: false, stdout: "000", stderr: "curl: (28) timed out" };
      return { ok: false, stdout: "", stderr: `unexpected exec ${url}` };
    }
    if (args[0] === "compose" && args[1] === "ls") {
      return { ok: true, stdout: JSON.stringify([
        { Name: "bp-jellyfin", Status: "running(1)", ConfigFiles: "/var/lib/boxpilot-managed/catalog/jellyfin/compose.yaml" },
        { Name: "boxpilot", Status: "running(2)", ConfigFiles: "/opt/boxpilot/docker-compose.yml" },
        { Name: "old-wordpress", Status: "exited(2)", ConfigFiles: "/opt/wordpress/docker-compose.yml" },
        { Name: "handmade", Status: "running(3)", ConfigFiles: "/home/user/stack/compose.yaml,/home/user/stack/compose.override.yaml" },
      ]), stderr: "" };
    }
    if (args[0] === "compose") {
      const name = args[args.indexOf("--project-name") + 1];
      const verb = args.find((arg, index) => index > 0 && ["up", "down", "pull", "start", "stop", "restart"].includes(arg));
      if (verb === "up") {
        if (args.includes("--force-recreate")) networkGone.value = false;
        if (failUp) return { ok: false, stdout: "", stderr: "Error response from daemon: port is already allocated" };
        containers.set(name, exitOnUp ? { running: false, status: "exited", health: "none", restarts: 0, image: "sha256:new", startedAt: "x", exitCode: 1 } : { running: true, status: "running", health: healthKind === "healthcheck" ? "healthy" : "none", restarts: 0, image: "sha256:new", startedAt: "x", exitCode: 0 });
      }
      if (verb === "down") containers.delete(name);
      if (verb === "stop") { const c = containers.get(name); if (c) Object.assign(c, { running: false, status: "exited" }); }
      // Docker's own message when the network a stopped container was created on has been pruned.
      if (verb === "start" && networkGone.value) return { ok: false, stdout: "", stderr: "Error response from daemon: failed to set up container networking: network 9c881bc331af929502fadc16d50ecf14b935a8b161ccf213589cfca7d7651dec not found" };
      if (verb === "start" || verb === "restart") { const c = containers.get(name); if (c) Object.assign(c, { running: true, status: "running" }); }
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  });
  let nowMs = Date.parse("2026-08-19T12:00:00.000Z");
  const clock = () => new Date(nowMs);
  const wait = vi.fn(async (ms) => { nowMs += ms; });
  const catalog = createCatalogService({ directory: catalogDirectory, ttlMs: 0 });
  const backupRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-appbk-")); directories.push(backupRoot);
  const apps = createAppHelper({ catalogRoot, backupRoot, runDocker, catalog, wait, clock, lanAddress: "192.168.1.10", ...(listDevices ? { listDevices } : {}), ...(chownDirectory ? { chownDirectory } : {}), ...(runCommand ? { runCommand } : {}) });
  const advance = (ms) => { nowMs += ms; };
  return { apps, calls, containers, catalogRoot, catalogDirectory, backupRoot, advance };
}

describe("generic app deployer", () => {
  it("resolves device globs against the host when writing the project, and refuses when nothing matches", async () => {
    const manifestYaml = "schemaVersion: 2\nid: smart\nname: Smart\ncategory: Disks\ndescription: d\nimage:\n  reference: x/smart:1\ndevices:\n  - /dev/sd?\n  - /dev/nvme?\nhealth:\n  kind: running\n  stableSeconds: 4\n  timeoutSeconds: 30\n";
    const bare = await setup({ listDevices: async () => ["tty", "zero"] });
    await writeFile(path.join(bare.catalogDirectory, "smart.yaml"), manifestYaml);
    await expect(bare.apps.install({ id: "smart" })).rejects.toThrow("needs a device matching /dev/sd?, /dev/nvme?");
    // The web process can hand over the devices it resolved; only paths matching the manifest survive.
    await expect(bare.apps.install({ id: "smart", devices: ["/dev/sdb", "/dev/null"] })).resolves.toMatchObject({ installed: true });
    await expect(bare.apps.reconfigure({ id: "smart", devices: ["/dev/null"] })).rejects.toThrow("needs a device matching");

    const host = await setup({ listDevices: async () => ["nvme0", "nvme0n1", "sda", "sda1"] });
    await writeFile(path.join(host.catalogDirectory, "smart.yaml"), manifestYaml);
    await expect(host.apps.install({ id: "smart" })).resolves.toMatchObject({ installed: true });
    const compose = await readFile(path.join(host.catalogRoot, "smart", "compose.yaml"), "utf8");
    expect(compose).toContain("/dev/sda:/dev/sda");
    expect(compose).toContain("/dev/nvme0:/dev/nvme0");
    expect(compose).not.toContain("nvme0n1");
    expect(compose).not.toContain("sda1");
  });

  it("installs without an optional device, and passes it through when the server has one", async () => {
    // A GPU render node speeds an app up; it is not what the app is for. Tdarr declares one as
    // optional, so a server with no /dev/dri/renderD* still installs it and transcodes on the CPU.
    const manifest = "schemaVersion: 2\nid: gpu\nname: Gpu\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\noptionalDevices:\n  - /dev/dri/renderD*\nvolumes:\n  - id: data\n    container: /data\n    path: data\n";
    const without = await setup({ listDevices: async () => ["card0"] });
    await writeFile(path.join(without.catalogDirectory, "gpu.yaml"), manifest);
    await expect(without.apps.install({ id: "gpu" })).resolves.toMatchObject({ id: "gpu" });
    expect(await readFile(path.join(without.catalogRoot, "gpu", "compose.yaml"), "utf8")).not.toContain("devices");

    const withGpu = await setup({ listDevices: async () => ["card0", "renderD128"] });
    await writeFile(path.join(withGpu.catalogDirectory, "gpu.yaml"), manifest);
    await withGpu.apps.install({ id: "gpu" });
    expect(await readFile(path.join(withGpu.catalogRoot, "gpu", "compose.yaml"), "utf8")).toContain("/dev/dri/renderD128:/dev/dri/renderD128");
  });

  it("changes the sign-in password and nothing else", async () => {
    // The generated password sat behind the elevated Secrets view and could only be changed by
    // finding the right variable in Settings. For Pi-hole that is also the only change that
    // sticks: the container sets the password from its environment on every start.
    const { apps, catalogDirectory, catalogRoot } = await setup();
    await writeFile(path.join(catalogDirectory, "hole.yaml"), "schemaVersion: 2\nid: hole\nname: Hole\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nports:\n  - id: web\n    container: 80\n    host: 8084\nenv:\n  - name: ADMIN_PASSWORD\n    type: password\n    generate: true\n  - name: API_TOKEN\n    type: password\n    generate: true\n  - name: TZ\n    default: Etc/UTC\nsignIn:\n  path: /admin/\n  passwordEnv: ADMIN_PASSWORD\n");
    await apps.install({ id: "hole", values: { env: { TZ: "Europe/London" } } });
    const before = Object.fromEntries(((await readFile(path.join(catalogRoot, "hole", ".env"), "utf8")).match(/^[A-Z_]+=.*$/gm) ?? []).map((line) => line.split("=")));
    expect(before.ADMIN_PASSWORD.length).toBeGreaterThan(10);

    await expect(apps.setPassword({ id: "hole", password: "short" })).rejects.toThrow("8 to 128");
    await expect(apps.setPassword({ id: "hole", password: "correct horse battery" })).resolves.toMatchObject({ id: "hole", changed: true });
    const after = Object.fromEntries(((await readFile(path.join(catalogRoot, "hole", ".env"), "utf8")).match(/^[A-Z_]+=.*$/gm) ?? []).map((line) => line.split("=")));
    expect(after.ADMIN_PASSWORD).toBe("'correct horse battery'");
    expect(after.API_TOKEN).toBe(before.API_TOKEN); // the other secret survives
    expect(after.TZ).toBe(before.TZ); // and so does every ordinary setting
    // The sign-in link carries the page.
    const { applications } = await apps.inspect({});
    expect(applications.find((entry) => entry.id === "hole").urls).toEqual([{ id: "web", label: "web", host: 8084, exposure: "lan", path: "/admin/" }]);
  });

  it("creates the folder layout a manifest promises inside a data volume, only where missing", async () => {
    // Sonarr's first act is to look for /data/tv; qBittorrent's is to write /data/torrents.
    // The manifest promises the layout, the install delivers it, and folders that already
    // exist stay exactly as the owner had them, ownership included.
    const chowned = [];
    const { apps, catalogDirectory } = await setup({ chownDirectory: async (target, uid, gid) => { chowned.push([target, uid, gid]); } });
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-media-")); directories.push(mediaRoot);
    await mkdir(path.join(mediaRoot, "torrents"));   // the owner already has this one
    await writeFile(path.join(catalogDirectory, "arr.yaml"), [
      "schemaVersion: 2", "id: arr", "name: Arr", "category: T", "description: d",
      "image:", "  reference: nginx:1.27",
      "ports:", "  - id: web", "    container: 8989", "    host: 8989",
      "env:", "  - name: PUID", "    default: \"1000\"", "    fixed: true", "  - name: PGID", "    default: \"1000\"", "    fixed: true",
      "volumes:", "  - id: media", "    container: /data", "    hostPath: /srv/media", "    configurable: true", "    backup: false",
      "    subdirectories:", "      - torrents", "      - tv",
      "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
    ].join("\n") + "\n");
    await apps.install({ id: "arr", values: { volumes: { media: mediaRoot } } });
    // The layout is created through the RESOLVED base (macOS tmpdirs sit behind /var -> /private/var),
    // which is also what keeps a symlinked base from being written through before validation.
    const { realpath } = await import("node:fs/promises");
    const resolvedRoot = await realpath(mediaRoot);
    expect(await stat(path.join(resolvedRoot, "tv")).then((entry) => entry.isDirectory())).toBe(true);
    // Only the folder that was missing got created and handed over; the existing one was left alone.
    expect(chowned.filter(([target]) => target === path.join(resolvedRoot, "tv"))).toHaveLength(1);
    expect(chowned.filter(([target]) => target.endsWith("torrents"))).toHaveLength(0);
  });

  it("a sidecar in a crash loop fails the health wait and shows on the card", async () => {
    // qBittorrent "ran" for an hour while its VPN container crash-looped: the deploy that broke
    // it passed the health check (which watched only the app container) and the card said
    // Running. A sidecar that exists and is restarting or exited is the app being broken.
    const { apps, catalogDirectory, containers } = await setup();
    await writeFile(path.join(catalogDirectory, "tun2.yaml"), [
      "schemaVersion: 2", "id: tun2", "name: Tun2", "category: T", "description: d",
      "image:", "  reference: nginx:1.27",
      "ports:", "  - id: web", "    container: 8080", "    host: 8095",
      "env: []", "volumes: []",
      "sidecars:", "  - id: vpn", "    image: gluetun:3",
      "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
    ].join("\n") + "\n");
    await apps.install({ id: "tun2", values: {} });

    containers.set("bp-tun2-vpn", { running: true, status: "restarting", health: "none", restarts: 5, image: "sha256:vpn", startedAt: "x", exitCode: 1 });
    const { applications } = await apps.inspect({ id: "tun2" });
    expect(applications[0].sidecars).toEqual([{ id: "vpn", running: true, status: "restarting", restarts: 5 }]);
    await expect(apps.reconfigure({ id: "tun2", values: {} }, { checkpoint: false })).rejects.toThrow(/vpn container keeps restarting \(5 times\)/);

    containers.set("bp-tun2-vpn", { running: false, status: "exited", health: "none", restarts: 0, image: "sha256:vpn", startedAt: "x", exitCode: 1 });
    await expect(apps.reconfigure({ id: "tun2", values: {} }, { checkpoint: false })).rejects.toThrow(/vpn container exited/);

    containers.set("bp-tun2-vpn", { running: true, status: "running", health: "none", restarts: 0, image: "sha256:vpn", startedAt: "x", exitCode: 0 });
    await expect(apps.reconfigure({ id: "tun2", values: {} }, { checkpoint: false })).resolves.toMatchObject({ reconfigured: true });
  });

  it("the kill-switch drill holds, restores, and reports; a leak is named and still restored", async () => {
    const tunnelManifest = [
      "schemaVersion: 2", "id: qbt", "name: Qbt", "category: T", "description: d",
      "image:", "  reference: qbt:5", "networkVia: vpn",
      "ports:", "  - id: web", "    container: 8080", "    host: 8095",
      "env: []", "volumes: []",
      "sidecars:", "  - id: vpn", "    image: gluetun:3",
      "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
    ].join("\n") + "\n";

    const held = await setup();
    await writeFile(path.join((held).catalogDirectory, "qbt.yaml"), tunnelManifest);
    await held.apps.install({ id: "qbt", values: {} });
    const result = await held.apps.vpnKillSwitchDrill({ id: "qbt" });
    expect(result).toMatchObject({ held: true, leaked: false, restored: true, exitBefore: "212.92.104.227" });
    expect(result.verdict).toMatch(/kill switch held.*came back on its own/);

    const leaky = await setup({ execTable: { vpn: "running", leaks: true, noCurl: false } });
    await writeFile(path.join(leaky.catalogDirectory, "qbt.yaml"), tunnelManifest);
    await leaky.apps.install({ id: "qbt", values: {} });
    const bad = await leaky.apps.vpnKillSwitchDrill({ id: "qbt" });
    expect(bad).toMatchObject({ held: false, leaked: true, restored: true });
    expect(bad.verdict).toMatch(/LEAKED.*Do not rely on this tunnel/);

    const plain = await setup();
    await writeFile(path.join(plain.catalogDirectory, "plain.yaml"), tunnelManifest.replace("id: qbt", "id: plain").replace("networkVia: vpn\n", ""));
    await plain.apps.install({ id: "plain", values: {} });
    await expect(plain.apps.vpnKillSwitchDrill({ id: "plain" })).rejects.toThrow(/does not run through a VPN tunnel/);
  });

  it("writes a manifest's config files into the project directory on install", async () => {
    const { apps, catalogDirectory, catalogRoot } = await setup();
    await writeFile(path.join(catalogDirectory, "conf.yaml"), [
      "schemaVersion: 2", "id: conf", "name: Conf", "category: T", "description: d",
      "image:", "  reference: nginx:1.27",
      "ports:", "  - id: web", "    container: 80", "    host: 8080",
      "env:", "  - name: GREETING", "    default: hello",
      "files:", "  - path: app.conf", "    container: /etc/app/app.conf", "    content: |", "      say=${GREETING}",
      "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
    ].join("\n") + "\n");
    await apps.install({ id: "conf", values: {} });
    const written = await readFile(path.join(catalogRoot, "conf", "app.conf"), "utf8");
    expect(written.trim()).toBe("say=hello");                 // interpolated and written where compose mounts it
    // Non-secret config is world-readable, so a non-root container reads it on a first install
    // before its image (and uid) is even known.
    expect(((await stat(path.join(catalogRoot, "conf", "app.conf"))).mode & 0o777)).toBe(0o644);
    const compose = await readFile(path.join(catalogRoot, "conf", "compose.yaml"), "utf8");
    expect(compose).toContain("./app.conf:/etc/app/app.conf:ro");
  });

  it("installs a manifest whose sidecar mounts the host read-only, without crashing on the null path", async () => {
    const { apps, catalogDirectory, catalogRoot } = await setup();
    await writeFile(path.join(catalogDirectory, "mon.yaml"), [
      "schemaVersion: 2", "id: mon", "name: Mon", "category: T", "description: d",
      "image:", "  reference: nginx:1.27",
      "ports:", "  - id: web", "    container: 9090", "    host: 9090",
      "files:", "  - path: mon.yml", "    container: /etc/mon.yml", "    content: |", "      target: node:9100",
      "sidecars:", "  - id: node", "    image: nginx:1.27",
      "    volumes:", "      - id: rootfs", "        container: /host", "        hostPath: /",
      "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
    ].join("\n") + "\n");
    await expect(apps.install({ id: "mon", values: {} })).resolves.toMatchObject({ installed: true });
    const compose = await readFile(path.join(catalogRoot, "mon", "compose.yaml"), "utf8");
    expect(compose).toContain("/:/host:ro");
    expect(compose).toContain("./mon.yml:/etc/mon.yml:ro");
  });

  it("starts, stops, and restarts a foreign compose stack by its own resolved files", async () => {
    const { apps, calls } = await setup();
    await apps.foreignProjectAction({ name: "handmade", action: "restart" });
    // The name is resolved against `compose ls`, and its own two compose files are passed by -f.
    const call = calls.find((c) => c.includes("--project-name handmade") && c.endsWith(" restart"));
    expect(call).toContain("--file /home/user/stack/compose.yaml --file /home/user/stack/compose.override.yaml");
    await expect(apps.foreignProjectAction({ name: "old-wordpress", action: "stop" })).resolves.toMatchObject({ action: "stop", done: true });
  });

  it("refuses to act on BoxPilot's own projects or an unknown name", async () => {
    const { apps } = await setup();
    // bp-* and boxpilot are managed from their cards, never as foreign stacks.
    await expect(apps.foreignProjectAction({ name: "bp-jellyfin", action: "stop" })).rejects.toThrow(/No compose project named/);
    await expect(apps.foreignProjectAction({ name: "boxpilot", action: "stop" })).rejects.toThrow(/No compose project named/);
    // A name compose does not report is refused, so nothing runs against an arbitrary path.
    await expect(apps.foreignProjectAction({ name: "ghost", action: "start" })).rejects.toThrow(/No compose project named/);
    await expect(apps.foreignProjectAction({ name: "handmade", action: "delete" })).rejects.toThrow(/start, stop, or restart/);
  });

  it("reads a foreign stack's logs through its own compose files", async () => {
    const { apps, calls } = await setup();
    await apps.foreignProjectLogs({ name: "handmade", lines: 50 });
    expect(calls.find((c) => c.includes("--project-name handmade") && c.includes("logs --no-color --tail 50"))).toBeTruthy();
  });

  it("lists compose projects BoxPilot did not create, and only those", async () => {
    const { apps } = await setup();
    const { available, projects } = await apps.foreignProjects();
    expect(available).toBe(true);
    // Its own bp- projects are not "foreign"; multiple config files split cleanly.
    expect(projects).toEqual([
      { name: "old-wordpress", status: "exited(2)", configFiles: ["/opt/wordpress/docker-compose.yml"] },
      { name: "handmade", status: "running(3)", configFiles: ["/home/user/stack/compose.yaml", "/home/user/stack/compose.override.yaml"] },
    ]);
  });

  it("changing one setting leaves every other choice standing, secrets included", async () => {
    // The exposure toggle used to hand reconfigure only { exposure }, and everything else fell
    // back to catalog defaults: the owner's VPN provider reset to mullvad, their WireGuard key
    // blanked (the tunnel then crash-looped on "private key is not set"), their media folder
    // reverted. Found live. What a request does not name must stay as it is.
    const { apps, catalogDirectory, catalogRoot } = await setup();
    await writeFile(path.join(catalogDirectory, "tun.yaml"), [
      "schemaVersion: 2", "id: tun", "name: Tun", "category: T", "description: d",
      "image:", "  reference: nginx:1.27",
      "ports:", "  - id: web", "    container: 8080", "    host: 8095",
      "volumes:", "  - id: media", "    container: /data", "    hostPath: /srv/media", "    configurable: true", "    backup: false",
      "env:", "  - name: PROVIDER", "    default: mullvad", "  - name: WG_KEY", "    type: password",
    ].join("\n") + "\n");
    await apps.install({ id: "tun", values: { ports: { web: 9001 }, env: { PROVIDER: "protonvpn", WG_KEY: "the-private-key" }, volumes: { media: "/mnt/media" } } });

    await apps.reconfigure({ id: "tun", values: { exposure: "tailnet" } }, { checkpoint: false });

    const envFile = await readFile(path.join(catalogRoot, "tun", ".env"), "utf8");
    expect(envFile).toContain("WG_KEY='the-private-key'");             // the secret survives untyped
    const compose = await readFile(path.join(catalogRoot, "tun", "compose.yaml"), "utf8");
    expect(compose).toContain("PROVIDER: protonvpn");                  // not reset to mullvad
    expect(compose).toContain("/mnt/media:/data");                     // the owner's folder, not the default
    expect(compose).toContain(":9001:8080");                           // the owner's port, not the default
  });

  it("offers an Open link only for ports a browser can open", async () => {
    // Every TCP port used to get one, so Forgejo's card offered to open git-over-SSH in a tab and
    // Pi-hole's first link — the one the Overview uses — was DNS on port 53.
    const { apps, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "forge.yaml"), "schemaVersion: 2\nid: forge\nname: Forge\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nports:\n  - id: ssh\n    label: Git over SSH\n    container: 22\n    host: 2222\n    tailnet: address\n  - id: web\n    label: Web UI\n    container: 3000\n    host: 3002\n  - id: quic\n    label: QUIC\n    container: 443\n    host: 4433\n    protocol: udp\n");
    await apps.install({ id: "forge" });
    const { applications } = await apps.inspect({});
    expect(applications.find((entry) => entry.id === "forge").urls).toEqual([{ id: "web", label: "Web UI", host: 3002, exposure: "lan", path: null }]);
  });

  it("hands managed volume folders to the user the manifest runs as", async () => {
    const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cat-")); directories.push(catalogDirectory);
    const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-approot-")); directories.push(catalogRoot);
    await writeFile(path.join(catalogDirectory, "owned.yaml"), "schemaVersion: 2\nid: owned\nname: Owned\ncategory: T\ndescription: d\nimage:\n  reference: x/owned:1\nuser: \"1883:1883\"\nvolumes:\n  - id: data\n    container: /data\n    path: data\n  - id: logs\n    container: /logs\n    path: logs\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    const chowns = [];
    const runDocker = vi.fn(async (_binary, args) => (args[0] === "inspect" ? { ok: true, stdout: JSON.stringify({ running: true, status: "running", health: "none", restarts: 0, image: "sha256:x", startedAt: "x", exitCode: 0 }), stderr: "" } : { ok: true, stdout: args[0] === "version" ? "28.0.0" : "", stderr: "" }));
    let nowMs = Date.parse("2026-08-21T12:00:00Z");
    const apps = createAppHelper({ catalogRoot, runDocker, catalog: createCatalogService({ directory: catalogDirectory, ttlMs: 0 }), wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), chownDirectory: async (target, uid, gid) => { chowns.push([path.basename(target), uid, gid]); } });
    await apps.install({ id: "owned" });
    expect(chowns).toEqual([["data", 1883, 1883], ["logs", 1883, 1883]]);
  });

  it("hands managed folders to the user the image itself declares", async () => {
    // Plenty of images neither declare `user:` nor read PUID — AnythingLLM runs as `anythingllm`,
    // Wiki.js as `node`. Their managed folders were created root-owned and the app could not write
    // a byte: an install that reports success and then fails at the first upload.
    const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cat-")); directories.push(catalogDirectory);
    const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-approot-")); directories.push(catalogRoot);
    await writeFile(path.join(catalogDirectory, "named.yaml"), "schemaVersion: 2\nid: named\nname: Named\ncategory: T\ndescription: d\nimage:\n  reference: x/named:1\nvolumes:\n  - id: store\n    container: /store\n    path: store\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    const chowns = [];
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "inspect") return { ok: true, stdout: JSON.stringify({ running: true, status: "running", health: "none", restarts: 0, image: "sha256:1", startedAt: "x", exitCode: 0 }), stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") return { ok: true, stdout: "appuser\n", stderr: "" };   // a name, not a number
      if (args[0] === "run" && args.includes("id")) return { ok: true, stdout: args.includes("-g") ? "2000\n" : "1500\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    let nowMs = Date.parse("2026-08-25T12:00:00Z");
    const apps = createAppHelper({ catalogRoot, runDocker, catalog: createCatalogService({ directory: catalogDirectory, ttlMs: 0 }), wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), chownDirectory: async (target, uid, gid) => { chowns.push([path.basename(target), uid, gid]); } });
    await apps.install({ id: "named" });
    expect(chowns).toEqual([["store", 1500, 2000]]); // resolved against the image's own passwd file
  });

  it("leaves ownership alone when the image runs as root or cannot be asked", async () => {
    const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cat-")); directories.push(catalogDirectory);
    const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-approot-")); directories.push(catalogRoot);
    await writeFile(path.join(catalogDirectory, "rooty.yaml"), "schemaVersion: 2\nid: rooty\nname: Rooty\ncategory: T\ndescription: d\nimage:\n  reference: x/rooty:1\nvolumes:\n  - id: store\n    container: /store\n    path: store\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    const chowns = [];
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "inspect") return { ok: true, stdout: JSON.stringify({ running: true, status: "running", health: "none", restarts: 0, image: "sha256:1", startedAt: "x", exitCode: 0 }), stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") return { ok: true, stdout: "\n", stderr: "" }; // no USER: runs as root
      return { ok: true, stdout: "", stderr: "" };
    });
    let nowMs = Date.parse("2026-08-25T12:00:00Z");
    const apps = createAppHelper({ catalogRoot, runDocker, catalog: createCatalogService({ directory: catalogDirectory, ttlMs: 0 }), wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), chownDirectory: async (target, uid, gid) => { chowns.push([path.basename(target), uid, gid]); } });
    await apps.install({ id: "rooty" });
    expect(chowns).toEqual([]); // nothing guessed
  });

  it("runs the chosen setup commands inside the container after install and settings changes", async () => {
    const { apps, calls, catalogDirectory, catalogRoot } = await setup();
    await writeFile(path.join(catalogDirectory, "lists.yaml"), `schemaVersion: 2\nid: lists\nname: Lists\ncategory: DNS\ndescription: d\nimage:\n  reference: x/lists:1\nhealth:\n  kind: running\n  stableSeconds: 4\n  timeoutSeconds: 30\nsetup:\n  title: Blocklists\n  finalize: [pihole, -g]\n  choices:\n    - id: big\n      label: Big\n      recommended: true\n      exec: [sh, -c, "echo big"]\n    - id: small\n      label: Small\n      exec: [sh, -c, "echo small"]\n`);
    const installed = await apps.install({ id: "lists" });
    expect(installed.setup).toEqual({ applied: ["big"], failed: [] });
    const execCalls = calls.filter((call) => call.includes(" exec -T lists "));
    expect(execCalls.map((call) => call.split(" exec -T lists ")[1])).toEqual(["sh -c echo big", "pihole -g"]);
    expect(calls.indexOf(execCalls[0])).toBeGreaterThan(calls.findIndex((call) => call.includes("up --detach")));
    const state = JSON.parse(await readFile(path.join(catalogRoot, "lists", "boxpilot.json"), "utf8"));
    expect(state.values.setup).toEqual(["big"]);
    const { applications } = await apps.inspect({ id: "lists" });
    expect(applications[0].state.values.setup).toEqual(["big"]);

    calls.length = 0;
    const reconfigured = await apps.reconfigure({ id: "lists", values: { setup: ["big", "small"] } }, { checkpoint: false });
    expect(reconfigured.setup).toEqual({ applied: ["big", "small"], failed: [] });
    expect(calls.filter((call) => call.includes(" exec -T lists ")).map((call) => call.split(" exec -T lists ")[1])).toEqual(["sh -c echo big", "sh -c echo small", "pihole -g"]);

    calls.length = 0;
    await apps.reconfigure({ id: "lists", values: { setup: [] } }, { checkpoint: false });
    expect(calls.some((call) => call.includes(" exec -T lists "))).toBe(false);
  });

  it("runs a setup choice inside the sidecar it names", async () => {
    const { apps, calls, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "chat.yaml"), "schemaVersion: 2\nid: chat\nname: Chat\ncategory: AI\ndescription: d\nimage:\n  reference: x/chat:1\nsidecars:\n  - id: ollama\n    image: o/ollama:1\nhealth:\n  kind: running\n  stableSeconds: 4\n  timeoutSeconds: 30\nsetup:\n  title: Models\n  choices:\n    - id: llama\n      label: Llama\n      recommended: true\n      service: ollama\n      exec: [ollama, pull, \"llama3.2:3b\"]\n");
    await expect(apps.install({ id: "chat" })).resolves.toMatchObject({ setup: { applied: ["llama"], failed: [] } });
    expect(calls.filter((call) => call.includes(" exec -T ")).map((call) => call.split(" exec -T ")[1])).toEqual(["ollama ollama pull llama3.2:3b"]);
  });

  it("installs, inspects, acts on, reconfigures, updates, and uninstalls an app from its manifest", async () => {
    const { apps, calls, catalogRoot } = await setup();
    const installed = await apps.install({ id: "demo", values: { ports: { web: 9090 } } });
    expect(installed).toMatchObject({ installed: true, id: "demo", hostPorts: [{ id: "web", host: 9090 }], secretsGenerated: ["ADMIN_PASSWORD"] });
    expect(calls).toContainEqual(expect.stringMatching(/^compose --project-name bp-demo --file .*compose\.yaml --env-file .*\.env up --detach --remove-orphans$/));
    const compose = await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8");
    expect(compose).toContain("192.168.1.10:9090:80");
    expect(compose).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    const env = await readFile(path.join(catalogRoot, "demo", ".env"), "utf8");
    expect(env).toMatch(/^ADMIN_PASSWORD=\S+\n$/);
    expect(await readdir(path.join(catalogRoot, "demo"))).toEqual(expect.arrayContaining(["compose.yaml", ".env", "boxpilot.json", "data"]));

    const { applications } = await apps.inspect({});
    expect(applications[0]).toMatchObject({ id: "demo", installed: true, container: { running: true }, urls: [{ id: "web", host: 9090 }], updateAvailable: false, installedImage: "nginx:1.27" });
    expect(JSON.stringify(applications)).not.toContain(env.trim().split("=")[1]);

    await expect(apps.install({ id: "demo" })).rejects.toThrow("already installed");
    await expect(apps.action({ id: "demo", action: "stop" })).resolves.toMatchObject({ running: false });
    await expect(apps.action({ id: "demo", action: "start" })).resolves.toMatchObject({ running: true });
    await expect(apps.action({ id: "demo", action: "explode" })).rejects.toThrow("start, stop, restart, pause, or unpause");

    const logs = await apps.logs({ id: "demo", lines: 5 });
    expect(logs.lines.join("\n")).toContain("password=[REDACTED]");

    const effective = await apps.config({ id: "demo" });
    expect(effective.compose).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    expect(effective.env).toContainEqual({ name: "ADMIN_PASSWORD", value: "••••••••", secret: true });
    expect(JSON.stringify(effective)).not.toContain(env.trim().split("=")[1]); // masked, never the real secret

    await expect(apps.reconfigure({ id: "demo", values: { ports: { web: 9191 }, env: { TZ: "Europe/Berlin" } } })).resolves.toMatchObject({ reconfigured: true, hostPorts: [{ host: 9191 }] });
    expect(await readFile(path.join(catalogRoot, "demo", ".env"), "utf8")).toBe(env); // secret preserved
    expect(await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8")).toContain("TZ: Europe/Berlin");

    // Non-configurable volumes are rendered into compose but never persisted as operator settings.
    expect(await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8")).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(JSON.parse(await readFile(path.join(catalogRoot, "demo", "boxpilot.json"), "utf8")).values.volumes).toEqual({});

    const updated = await apps.update({ id: "demo" });
    expect(updated).toMatchObject({ updated: true, checkpoint: { artifact: expect.stringMatching(/\.tar\.gz$/), checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(calls).toContainEqual(expect.stringMatching(/compose .* pull$/));
    // The checkpoint is a regular backup the card can restore from; it happens before the pull.
    expect((await apps.listAppBackups({ id: "demo" })).backups.map((entry) => entry.artifact)).toContain(updated.checkpoint.artifact);
    expect(calls.findIndex((call) => / stop$/.test(call))).toBeLessThan(calls.findIndex((call) => / pull$/.test(call)));
    await expect(apps.update({ id: "demo" }, { checkpoint: false })).resolves.toMatchObject({ updated: true, checkpoint: null });

    await expect(apps.uninstall({ id: "demo", purge: false })).resolves.toMatchObject({ uninstalled: true, dataRemoved: false });
    expect(await readdir(path.join(catalogRoot, "demo"))).toEqual(expect.arrayContaining(["data", "boxpilot.json"]));
    expect((await apps.inspect({})).applications[0]).toMatchObject({ installed: false, dataPresent: true });
    await apps.install({ id: "demo" });
    await expect(apps.uninstall({ id: "demo", purge: true })).resolves.toMatchObject({ purged: true, dataRemoved: true });
    await expect(readdir(path.join(catalogRoot, "demo"))).rejects.toThrow();
  });

  it("lists, downloads and removes models for an app that runs them", async () => {
    // Downloads live outside install deliberately: a 20 GB model cannot finish inside the install
    // operation's idle timeout, so it gets its own job, its own budget, and streamed progress.
    const { apps, calls, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "engine.yaml"), "schemaVersion: 2\nid: engine\nname: Engine\ncategory: AI\ndescription: d\nimage:\n  reference: x/engine:1\nmodelRunner:\n  kind: ollama\n  service: engine\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    await apps.install({ id: "engine" });

    const models = await apps.listModels({ id: "engine" });
    expect(models.available).toBe(true);
    expect(calls.some((call) => /exec -T engine ollama list$/.test(call))).toBe(true);

    const lines = [];
    await apps.pullModel({ id: "engine", model: "hermes3:8b" }, { progress: (line) => lines.push(line) });
    expect(calls.some((call) => /exec -T engine ollama pull hermes3:8b$/.test(call))).toBe(true);
    expect(lines.join(" ")).toMatch(/Downloading hermes3:8b/);

    await apps.removeModel({ id: "engine", model: "hermes3:8b" });
    expect(calls.some((call) => /exec -T engine ollama rm hermes3:8b$/.test(call))).toBe(true);

    // Parsing `ollama list` is the fragile part — SIZE and MODIFIED both contain single spaces, so
    // columns split on runs of two or more. Pinned against real output from ollama 0.32.15.
    const listing = "NAME                 ID              SIZE     MODIFIED\nhermes3:8b           1b226e2802db    4.7 GB   2 days ago\nqwen3:30b-a3b        aabbccddeeff    19 GB    Less than a second ago\n";
    expect(apps.internals.parseModelList(listing)).toEqual([
      { name: "hermes3:8b", id: "1b226e2802db", size: "4.7 GB", modified: "2 days ago", bytes: 4_700_000_000 },
      { name: "qwen3:30b-a3b", id: "aabbccddeeff", size: "19 GB", modified: "Less than a second ago", bytes: 19_000_000_000 },
    ]);
  });

  it("refuses model commands for an app that does not run models", async () => {
    const { apps } = await setup();
    await apps.install({ id: "demo" });
    await expect(apps.listModels({ id: "demo" })).rejects.toThrow("does not manage models");
  });

  it("says what to do when the runner is stopped or paused, instead of relaying Docker's error", async () => {
    // Docker refuses an exec into a stopped or paused container quickly, but its message names a
    // container id and tells the owner nothing they can act on.
    const { apps, containers, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "engine2.yaml"), "schemaVersion: 2\nid: engine2\nname: Engine2\ncategory: AI\ndescription: d\nimage:\n  reference: x/engine2:1\nmodelRunner:\n  kind: ollama\n  service: engine2\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    await apps.install({ id: "engine2" });

    Object.assign(containers.get("bp-engine2"), { running: true, status: "paused" });
    await expect(apps.pullModel({ id: "engine2", model: "hermes3:8b" })).rejects.toThrow("is paused. Resume it");
    // Listing reports rather than throws: the panel opens on click and should explain itself.
    expect(await apps.listModels({ id: "engine2" })).toMatchObject({ available: false, reason: expect.stringContaining("paused") });

    Object.assign(containers.get("bp-engine2"), { running: false, status: "exited" });
    await expect(apps.removeModel({ id: "engine2", model: "hermes3:8b" })).rejects.toThrow("is not running. Start it");
    expect(await apps.listModels({ id: "engine2" })).toMatchObject({ available: false, reason: expect.stringContaining("not running") });
  });

  it("pauses and resumes a container without stopping it", async () => {
    // Pause freezes the process and keeps its memory, which is what makes it right for a heavy
    // model: no reload on the way back. Stop would free the memory and cost a cold start.
    const { apps, calls } = await setup();
    await apps.install({ id: "demo" });
    calls.length = 0;
    await expect(apps.action({ id: "demo", action: "pause" })).resolves.toMatchObject({ action: "pause" });
    expect(calls.some((call) => / pause$/.test(call))).toBe(true);
    expect(calls.some((call) => / (stop|down)\b/.test(call))).toBe(false); // never a stop in disguise
    calls.length = 0;
    await expect(apps.action({ id: "demo", action: "unpause" })).resolves.toMatchObject({ action: "unpause" });
    expect(calls.some((call) => / unpause$/.test(call))).toBe(true);
  });

  it("builds the container again when its network was pruned while it was stopped", async () => {
    // `docker system prune` (or Portainer, or a compose UI the owner runs) removes the network a
    // stopped container was created on, because nothing running is joined to it. Starting then
    // fails on a network ID that no longer exists, and plain `up` fails the same way — only
    // recreating the container recovers, which costs nothing: its data lives in volumes.
    const { apps, calls } = await setup({ networkGone_: true });
    await apps.install({ id: "demo" });
    await apps.action({ id: "demo", action: "stop" });
    calls.length = 0;
    await expect(apps.action({ id: "demo", action: "start" })).resolves.toMatchObject({ running: true });
    expect(calls.some((call) => call.includes("up --detach --force-recreate"))).toBe(true);
  });

  it("edits the raw compose file with validation and rollback", async () => {
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo" });
    const composePath = path.join(catalogRoot, "demo", "compose.yaml");
    const original = await readFile(composePath, "utf8");

    await expect(apps.editCompose({ id: "demo", compose: "not: [valid" })).rejects.toThrow("Not valid YAML");
    await expect(apps.editCompose({ id: "demo", compose: "just: scalars" })).rejects.toThrow("must define services");
    expect(await readFile(composePath, "utf8")).toBe(original);

    const edited = original.replace("restart: unless-stopped", "restart: always");
    await expect(apps.editCompose({ id: "demo", compose: edited })).resolves.toMatchObject({ edited: true, rawEdited: true, checkpoint: { artifact: expect.stringMatching(/\.tar\.gz$/) } });
    expect((await apps.listAppBackups({ id: "demo" })).backups).toHaveLength(1);
    expect(await readFile(composePath, "utf8")).toBe(edited);
    expect(JSON.parse(await readFile(path.join(catalogRoot, "demo", "boxpilot.json"), "utf8")).rawEdited).toBe(true);
  });

  it("updates an app whose stored state echoes values the manifest does not accept", async () => {
    // Older releases persisted every hostPath volume (docker socket included) into
    // boxpilot.json; updates then failed validation. Stored state is sanitized instead.
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo" });
    const statePath = path.join(catalogRoot, "demo", "boxpilot.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.values.volumes = { docker: "/var/run/docker.sock" };
    state.values.env.REMOVED_SETTING = "stale";
    await writeFile(statePath, JSON.stringify(state));

    await expect(apps.update({ id: "demo" })).resolves.toMatchObject({ updated: true });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(after.values.volumes).toEqual({});
    expect(after.values.env.REMOVED_SETTING).toBeUndefined();
  });

  it("does not call a crash-looping container steady, and says so before the timeout", async () => {
    // Docker keeps State.Running=true while a container waits to restart, so the steady-for-N-
    // seconds check counted the backoff as uptime and declared the app up. Pocket ID's first
    // smoke run on the real host was reported "is up" while its container was restarting.
    const { apps, catalogRoot } = await setup({ crashLoop: true });
    await expect(apps.install({ id: "demo" })).rejects.toThrow(/keeps restarting/);
    await expect(readdir(path.join(catalogRoot, "demo")).catch(() => [])).resolves.toEqual([]);
  });

  it("rolls back a failed fresh install and reports the container's last log lines", async () => {
    const { apps, catalogRoot } = await setup({ exitOnUp: true });
    await expect(apps.install({ id: "demo" })).rejects.toThrow(/rolled back.*Container exited/);
    await expect(readdir(path.join(catalogRoot, "demo"))).rejects.toThrow();
    const failing = await setup({ failUp: true });
    await expect(failing.apps.install({ id: "demo" })).rejects.toThrow("port is already allocated");
  });

  it("refuses unknown apps and invalid settings before touching docker", async () => {
    const { apps, calls } = await setup();
    await expect(apps.install({ id: "nope" })).rejects.toThrow("not in the catalog");
    await expect(apps.install({ id: "demo", values: { ports: { web: 70000 } } })).rejects.toThrow("Invalid settings");
    await expect(apps.install({ id: "../x" })).rejects.toThrow("invalid");
    expect(calls.filter((call) => call.startsWith("compose"))).toEqual([]);
  });

  it("populates Homepage with installed apps, keeps operator groups, and refreshes after uninstall", async () => {
    const { apps, catalogRoot, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "homepage.yaml"), "schemaVersion: 2\nid: homepage\nname: Homepage\ncategory: Dashboard\ndescription: dash\nimage:\n  reference: ghcr.io/gethomepage/homepage:v1\nports:\n  - id: web\n    container: 3000\n    host: 3000\nvolumes:\n  - id: config\n    container: /app/config\n    path: config\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    await expect(apps.syncHomepage({ host: "192.168.1.10" })).rejects.toThrow("not installed");
    await apps.install({ id: "homepage" });
    const configDirectory = path.join(catalogRoot, "homepage", "config");
    await writeFile(path.join(configDirectory, "services.yaml"), "- Mine:\n    - Router:\n        href: http://192.168.1.1\n");
    await apps.install({ id: "demo" }); // no host remembered yet: the auto-refresh is skipped, not fatal

    const result = await apps.syncHomepage({ host: "192.168.1.10" });
    expect(result).toMatchObject({ synced: true, services: 1, groupsKept: 1, host: "192.168.1.10" });
    const services = await readFile(path.join(configDirectory, "services.yaml"), "utf8");
    expect(services).toContain("- BoxPilot:");
    expect(services).toContain("href: http://192.168.1.10:8080");
    expect(services).toContain("container: bp-demo");
    expect(services).toContain("- Mine:");
    expect(services.indexOf("- BoxPilot:")).toBeLessThan(services.indexOf("- Mine:"));
    expect(await readFile(path.join(configDirectory, "docker.yaml"), "utf8")).toContain("socket: /var/run/docker.sock");

    await apps.uninstall({ id: "demo", purge: false });
    const after = await readFile(path.join(configDirectory, "services.yaml"), "utf8");
    expect(after).not.toContain("bp-demo");
    expect(after).toContain("- Mine:");
  });

  it("lists a backup's files and restores one path over the current data after a checkpoint", async () => {
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo" });
    const dataDirectory = path.join(catalogRoot, "demo", "data");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(dataDirectory, "settings.json"), '{"theme":"dark"}');
    await writeFile(path.join(dataDirectory, "notes.txt"), "keep me");
    const backupResult = await apps.backup({ id: "demo" });

    const listing = await apps.listAppBackupFiles({ id: "demo", backup: backupResult.artifact });
    expect(listing.files.map((entry) => entry.path)).toEqual(expect.arrayContaining(["boxpilot.json", "data", "data/settings.json", "data/notes.txt"]));
    expect(listing.files.find((entry) => entry.path === "data/settings.json")).toMatchObject({ type: "file", sizeBytes: 16 });

    await writeFile(path.join(dataDirectory, "settings.json"), '{"theme":"broken"}');
    await writeFile(path.join(dataDirectory, "notes.txt"), "changed later");
    const restored = await apps.restoreAppBackupPath({ id: "demo", backup: backupResult.artifact, path: "data/settings.json" });
    expect(restored).toMatchObject({ restored: true, path: "data/settings.json", checkpoint: { artifact: expect.stringMatching(/\.tar\.gz$/) } });
    expect(await readFile(path.join(dataDirectory, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
    expect(await readFile(path.join(dataDirectory, "notes.txt"), "utf8")).toBe("changed later");
    await expect(apps.restoreAppBackupPath({ id: "demo", backup: backupResult.artifact, path: "../etc/passwd" })).rejects.toThrow("relative path");
    await expect(apps.restoreAppBackupPath({ id: "demo", backup: backupResult.artifact, path: "data/missing.txt" })).rejects.toThrow("is not in");
  });

  it("backs up, prunes, restores, and deletes app data with a real archive", async () => {
    const { apps, calls, catalogRoot, backupRoot, advance } = await setup();
    await apps.install({ id: "demo" });
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "precious");

    const first = await apps.backup({ id: "demo" });
    expect(first).toMatchObject({ backedUp: true, artifact: expect.stringMatching(/^\d{8}T\d{6}Z\.tar\.gz$/), contents: expect.arrayContaining(["boxpilot.json", "compose.yaml", ".env", "data"]), pruned: [] });
    expect(typeof first.checksumSha256).toBe("string");
    expect(first.downtimeMs).not.toBeNull(); // it was running: stop + start around the archive
    expect(calls).toContainEqual(expect.stringMatching(/compose .* stop$/));
    expect(calls).toContainEqual(expect.stringMatching(/compose .* start$/));
    expect(await readdir(path.join(backupRoot, "demo"))).toEqual(expect.arrayContaining([first.artifact, first.artifact.replace(/\.tar\.gz$/, ".json")]));

    advance(60_000);
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "changed since backup");
    const second = await apps.backup({ id: "demo", keep: 1 });
    expect(second.pruned).toEqual([first.artifact]);
    const listed = await apps.listAppBackups({ id: "demo" });
    expect(listed.backups).toHaveLength(1);
    expect(listed.backups[0]).toMatchObject({ artifact: second.artifact, checksumSha256: second.checksumSha256 });

    advance(60_000);
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "broken state");
    const restored = await apps.restoreAppBackup({ id: "demo", backup: second.artifact });
    expect(restored).toMatchObject({ restored: true, backup: second.artifact });
    expect(await readFile(path.join(catalogRoot, "demo", "data", "file.txt"), "utf8")).toBe("changed since backup");
    // The restore first saved the broken state as a safety copy alongside the restored one.
    expect((await apps.listAppBackups({ id: "demo" })).backups.length).toBe(2);

    await expect(apps.restoreAppBackup({ id: "demo", backup: "evil/../../x.tar.gz" })).rejects.toThrow("invalid");
    await expect(apps.deleteAppBackup({ id: "demo", backup: second.artifact })).resolves.toMatchObject({ deleted: true });
    await expect(apps.deleteAppBackup({ id: "demo", backup: second.artifact })).rejects.toThrow("does not exist");
  });
});

describe("folders an app is pointed at", () => {
  it("creates a missing data folder and gives it to the user the app runs as", async () => {
    const chowns = [];
    const { apps, catalogDirectory } = await setup({ chownDirectory: async (target, uid, gid) => { chowns.push(`${target}:${uid}:${gid}`); } });
    const media = path.join(await mkdtemp(path.join(os.tmpdir(), "boxpilot-media-")), "srv", "media");
    // A manifest that runs as PUID 1000 and mounts a folder the owner has not created yet.
    await writeFile(path.join(catalogDirectory, "grabber.yaml"), [
      "schemaVersion: 2", "id: grabber", "name: Grabber", "category: Media automation", "description: d",
      "image:", "  reference: x/grabber:1", "env:", "  - name: PUID", "    default: '1000'", "  - name: PGID", "    default: '1000'",
      "volumes:", "  - id: media", "    container: /data", `    hostPath: ${media}`, "    configurable: true",
      "health:", "  kind: running", "  stableSeconds: 1", "  timeoutSeconds: 30",
    ].join("\n"));

    await apps.install({ id: "grabber", values: { setup: [] } });
    const created = await stat(media).then((info) => info.isDirectory(), () => false);
    expect(created).toBe(true);
    expect(chowns.some((entry) => entry.startsWith(`${media}:1000:1000`))).toBe(true);
  });

  it("leaves a folder that already exists alone, whatever owns it", async () => {
    const chowns = [];
    const { apps, catalogDirectory } = await setup({ chownDirectory: async (target) => { chowns.push(target); } });
    const library = await mkdtemp(path.join(os.tmpdir(), "boxpilot-library-"));
    await writeFile(path.join(catalogDirectory, "reader.yaml"), [
      "schemaVersion: 2", "id: reader", "name: Reader", "category: Books", "description: d",
      "image:", "  reference: x/reader:1", "env:", "  - name: PUID", "    default: '1000'",
      "volumes:", "  - id: books", "    container: /books", `    hostPath: ${library}`, "    configurable: true",
      "health:", "  kind: running", "  stableSeconds: 1", "  timeoutSeconds: 30",
    ].join("\n"));

    await apps.install({ id: "reader", values: { setup: [] } });
    // Someone's existing library keeps its own ownership; BoxPilot does not take it over.
    expect(chowns).not.toContain(library);
  });
});

describe("restoring an application backup", () => {
  it("replaces the app directory rather than unpacking over it", async () => {
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo", values: { setup: [] } });
    const appDir = path.join(catalogRoot, "demo");
    const made = await apps.backup({ id: "demo", keep: 5 });

    // Something written after the backup — a database segment, a new upload — must not survive a restore.
    await writeFile(path.join(appDir, "written-later.txt"), "written after the backup");
    await apps.restoreAppBackup({ id: "demo", backup: made.artifact });

    // What the archive holds is back...
    expect(await readFile(path.join(appDir, "compose.yaml"), "utf8")).toContain("services:");
    await expect(readFile(path.join(appDir, "written-later.txt"), "utf8")).rejects.toThrow();
    // No staging directories are left behind.
    const siblings = await readdir(catalogRoot);
    expect(siblings.filter((entry) => entry.includes(".restoring") || entry.includes(".replaced"))).toEqual([]);
  });
});

describe("dashboard links for an app bound to the server itself", () => {
  const loopbackManifest = "schemaVersion: 2\nid: files\nname: Files\ncategory: Files\ndescription: Browse files\nimage:\n  reference: x/files:1\nports:\n  - id: web\n    container: 80\n    host: 8085\n    exposure: loopback\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n";
  const homepageManifest = "schemaVersion: 2\nid: homepage\nname: Homepage\ncategory: Dashboard\ndescription: dash\nimage:\n  reference: ghcr.io/gethomepage/homepage:v1\nports:\n  - id: web\n    container: 3000\n    host: 3000\nvolumes:\n  - id: config\n    container: /app/config\n    path: config\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n";

  it("never sends the reader to their own machine, and links the tailnet address once it is published", async () => {
    const serveStatus = JSON.stringify({ Web: { "box.tail1234.ts.net:8085": { Handlers: { "/": { Proxy: "http://127.0.0.1:8085" } } } } });
    let published = false;
    const runCommand = vi.fn(async (_binary, args) => (args[0] === "serve" ? { ok: published, stdout: published ? serveStatus : "", stderr: "" } : { ok: false, stdout: "", stderr: "" }));
    const { apps, catalogRoot, catalogDirectory } = await setup({ runCommand });
    await writeFile(path.join(catalogDirectory, "files.yaml"), loopbackManifest);
    await writeFile(path.join(catalogDirectory, "homepage.yaml"), homepageManifest);
    await apps.install({ id: "homepage" });
    await apps.install({ id: "files" });
    const servicesPath = path.join(catalogRoot, "homepage", "config", "services.yaml");

    // On the LAN there is no address that works for the reader, so the entry says where it lives.
    await apps.syncHomepage({ host: "192.168.1.10" });
    let services = await readFile(servicesPath, "utf8");
    expect(services).not.toContain("href: http://127.0.0.1"); // the reader's own machine, not the server
    expect(services).not.toContain("href: http://192.168.1.10:8085"); // not reachable on the LAN either
    expect(services).toContain("on the server itself at 127.0.0.1:8085");

    // Published on the tailnet and read from the tailnet: the HTTPS address is the right link.
    published = true;
    await apps.syncHomepage({ host: "box.tail1234.ts.net" });
    services = await readFile(servicesPath, "utf8");
    expect(services).toContain("href: https://box.tail1234.ts.net:8085");
    expect(services).not.toContain("on the server itself");
  });
});

describe("inspecting the whole catalog", () => {
  it("asks Docker only about apps that have a project directory", async () => {
    const { apps, calls, catalogDirectory } = await setup();
    // Two more manifests that were never installed, as the real catalog is mostly uninstalled apps.
    for (const id of ["spare-one", "spare-two"]) {
      await writeFile(path.join(catalogDirectory, `${id}.yaml`), `schemaVersion: 2\nid: ${id}\nname: ${id}\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n`);
    }
    await apps.install({ id: "demo" });
    calls.length = 0;
    const result = await apps.inspect({});
    // Every manifest is still described...
    expect(result.applications.map((item) => item.id).sort()).toEqual(["demo", "spare-one", "spare-two"]);
    expect(result.applications.filter((item) => item.installed)).toHaveLength(1);
    expect(result.applications.find((item) => item.id === "demo")).toMatchObject({ installed: true });
    // ...but the one docker inspect names only the app that exists, not all 128 catalog ids.
    const inspects = calls.filter((call) => call.startsWith("inspect "));
    expect(inspects).toHaveLength(1);
    expect(inspects[0].split(" ").filter((argument) => argument.startsWith("bp-"))).toEqual(["bp-demo"]);
  });
});
