/**
 * Sweep 4: what a compose file started exactly as a backup archived it would hand its containers.
 *
 * A restore starts a hand-edited compose file (and one whose saved settings are missing or no longer
 * fit) as it was archived, and an archive is only as trustworthy as whoever last held it. These pin
 * that every setting that reaches past what the catalog grants the app is listed, and that what the
 * catalog itself writes lists nothing.
 */
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { appFolderMounts, composeFindingsText, composeSha256, imageRepository, isSystemLocation, powerfulComposeSettings, sameCompose } from "./compose-review.mjs";
import { renderCompose } from "./compose.mjs";
import { loadCatalog } from "./index.mjs";
import { resolveValues, validateManifest } from "./schema.mjs";

const appDirectory = "/var/lib/boxpilot-managed/catalog/media";
const { manifest } = validateManifest(YAML.parse(`
schemaVersion: 2
id: media
name: Media
category: T
description: d
risk: medium
image:
  reference: lscr.io/linuxserver/jellyfin:10.10.0
capabilities: [CAP_NET_ADMIN]
devices: ["/dev/dri/renderD*"]
optionalDevices: ["/dev/ttyUSB?"]
networkModes: [bridge, host]
sysctls: ["net.ipv4.ip_forward=1"]
gpu: optional
ports:
  - id: web
    container: 8096
    host: 8096
volumes:
  - id: config
    container: /config
    path: config
  - id: library
    container: /library
    hostPath: /srv/media
    configurable: true
  - id: sock
    container: /var/run/docker.sock
    hostPath: /var/run/docker.sock
  - id: proc
    container: /host/proc
    hostPath: /proc
    readOnly: true
sidecars:
  - id: db
    image: postgres:16
    volumes:
      - id: pgdata
        container: /var/lib/postgresql/data
        path: pgdata
      - id: hostsys
        container: /host/sys
        hostPath: /sys
`));
const review = (services, extra = {}) => powerfulComposeSettings(YAML.stringify({ name: "bp-media", services, ...extra }), { manifest, appId: "media", managedRoots: [appDirectory, "/mnt/disk1/films"] });
const base = { image: "lscr.io/linuxserver/jellyfin:10.10.0" };

describe("a compose file BoxPilot did not write", () => {
  // [what, services (or extra top-level), the settings expected to be listed]
  const listed = [
    ["a privileged container", { media: { ...base, privileged: true } }, [["media", "privileged"]]],
    ["privileged written as a string", { media: { ...base, privileged: "yes" } }, [["media", "privileged"]]],
    ["privileged set by a variable", { media: { ...base, privileged: "${PRIV:-false}" } }, [["media", "privileged"]]],
    ["a privileged lifecycle hook", { media: { ...base, post_start: [{ command: "sh", privileged: true }] } }, [["media", "hooks"]]],
    ["a capability the catalog does not give", { media: { ...base, cap_add: ["SYS_ADMIN", "NET_ADMIN"] } }, [["media", "cap_add"]]],
    ["every capability", { media: { ...base, cap_add: ["ALL"] } }, [["media", "cap_add"]]],
    ["a capability on a sidecar that has none", { media: base, db: { image: "postgres:16", cap_add: ["CAP_NET_ADMIN"] } }, [["db", "cap_add"]]],
    ["a device the manifest does not match", { media: { ...base, devices: ["/dev/sda:/dev/sda"] } }, [["media", "devices"]]],
    ["a device in long syntax", { media: { ...base, devices: [{ source: "/dev/mem", target: "/dev/mem" }] } }, [["media", "devices"]]],
    ["device numbers", { media: { ...base, device_cgroup_rules: ["b 8:* rmw"] } }, [["media", "device_cgroup_rules"]]],
    ["GPUs on a sidecar that has none", { media: base, db: { image: "postgres:16", gpus: "all" } }, [["db", "gpus"]]],
    ["a device reservation on a sidecar", { media: base, db: { image: "postgres:16", deploy: { resources: { reservations: { devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }] } } } } }, [["db", "deploy.resources.reservations.devices"]]],
    ["the host network on a sidecar", { media: base, db: { image: "postgres:16", network_mode: "host" } }, [["db", "network_mode"]]],
    ["another container's network", { media: { ...base, network_mode: "container:boxpilot" } }, [["media", "network_mode"]]],
    ["the host's process table", { media: { ...base, pid: "host" } }, [["media", "pid"]]],
    ["the host's shared memory", { media: { ...base, ipc: "host" } }, [["media", "ipc"]]],
    ["the host's host name", { media: { ...base, uts: "host" } }, [["media", "uts"]]],
    ["the host's user namespace", { media: { ...base, userns_mode: "host" } }, [["media", "userns_mode"]]],
    ["the host's control groups", { media: { ...base, cgroup: "host" } }, [["media", "cgroup"]]],
    ["a namespace from a variable", { media: { ...base, pid: "${MODE}" } }, [["media", "pid"]]],
    ["seccomp off", { media: { ...base, security_opt: ["seccomp=unconfined"] } }, [["media", "security_opt"]]],
    ["AppArmor off", { media: { ...base, security_opt: ["no-new-privileges:true", "apparmor:unconfined"] } }, [["media", "security_opt"]]],
    ["SELinux labels off", { media: { ...base, security_opt: ["label:disable"] } }, [["media", "security_opt"]]],
    ["a seccomp profile of its own", { media: { ...base, security_opt: ["seccomp=./allow-all.json"] } }, [["media", "security_opt"]]],
    ["a sysctl the catalog does not set", { media: { ...base, sysctls: { "kernel.core_pattern": "|/tmp/x" } } }, [["media", "sysctls"]]],
    ["a sysctl as a list", { media: { ...base, sysctls: ["net.ipv4.ip_forward=1", "kernel.shmmax=1"] } }, [["media", "sysctls"]]],
    ["a control group of its own", { media: { ...base, cgroup_parent: "/" } }, [["media", "cgroup_parent"]]],
    ["another container's volumes", { media: { ...base, volumes_from: ["boxpilot"] } }, [["media", "volumes_from"]]],
    ["another runtime", { media: { ...base, runtime: "runc-unsafe" } }, [["media", "runtime"]]],
    ["Docker's API socket by name", { media: { ...base, use_api_socket: true } }, [["media", "use_api_socket"]]],
    ["a provider plugin", { media: { ...base, provider: { type: "anything" } } }, [["media", "provider"]]],
    ["a build", { media: { ...base, build: { context: "/" } } }, [["media", "build"]]],
    ["another image", { media: { image: "evil/jellyfin:10.10.0" } }, [["media", "image"]]],
    ["another registry", { media: { image: "ghcr.io/linuxserver/jellyfin:10.10.0" } }, [["media", "image"]]],
    ["an image from a variable", { media: { image: "${IMAGE}" } }, [["media", "image"]]],
    ["another image for a sidecar", { media: base, db: { image: "evil/postgres:16" } }, [["db", "image"]]],
    ["a service the catalog does not have", { media: base, shell: { image: "alpine" } }, [["shell", "service"]]],
    ["the root folder", { media: { ...base, volumes: ["/:/host"] } }, [["media", "volumes"]]],
    ["the root folder read-write where the catalog mounts it read-only", { media: { ...base, volumes: ["/proc:/host/proc"] } }, [["media", "volumes"]]],
    ["/etc", { media: { ...base, volumes: ["/etc:/x:ro"] } }, [["media", "volumes"]]],
    ["/root", { media: { ...base, volumes: ["/root:/x"] } }, [["media", "volumes"]]],
    ["/home", { media: { ...base, volumes: ["/home:/x"] } }, [["media", "volumes"]]],
    ["the Docker socket on a sidecar", { media: base, db: { image: "postgres:16", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] } }, [["db", "volumes"]]],
    ["the Docker socket at /run", { media: { ...base, volumes: ["/run/docker.sock:/var/run/docker.sock"] } }, [["media", "volumes"]]],
    ["/run", { media: { ...base, volumes: ["/run:/x"] } }, [["media", "volumes"]]],
    ["/sys read-write on the sidecar", { media: base, db: { image: "postgres:16", volumes: ["/sys:/host/sys"] } }, [["db", "volumes"]]],
    ["/dev", { media: { ...base, volumes: ["/dev:/dev"] } }, [["media", "volumes"]]],
    ["/boot", { media: { ...base, volumes: ["/boot:/boot"] } }, [["media", "volumes"]]],
    ["Docker's data", { media: { ...base, volumes: ["/var/lib/docker:/x"] } }, [["media", "volumes"]]],
    ["/var, which holds Docker's data", { media: { ...base, volumes: ["/var:/x"] } }, [["media", "volumes"]]],
    ["BoxPilot's own code", { media: { ...base, volumes: ["/opt/boxpilot:/x"] } }, [["media", "volumes"]]],
    ["BoxPilot's own data", { media: { ...base, volumes: ["/var/lib/boxpilot:/x"] } }, [["media", "volumes"]]],
    ["every app's folder", { media: { ...base, volumes: ["/var/lib/boxpilot-managed/catalog:/x"] } }, [["media", "volumes"]]],
    ["a climb out of the app's folder", { media: { ...base, volumes: ["./config/../../other-app:/x"] } }, [["media", "volumes"]]],
    ["the helper's home", { media: { ...base, volumes: ["~/.ssh:/x"] } }, [["media", "volumes"]]],
    ["an ordinary folder outside the app", { media: { ...base, volumes: ["/srv/other:/x"] } }, [["media", "volumes"]]],
    ["a bind in long syntax", { media: { ...base, volumes: [{ type: "bind", source: "/", target: "/host" }] } }, [["media", "volumes"]]],
    ["a long-syntax bind made read-write", { media: { ...base, volumes: [{ type: "bind", source: "/proc", target: "/host/proc", read_only: false }] } }, [["media", "volumes"]]],
    ["a bind from a variable", { media: { ...base, volumes: ["${SRC}:/host"] } }, [["media", "volumes"]]],
    ["mount propagation shared with the server", { media: { ...base, volumes: ["./config:/config:rshared"] } }, [["media", "volumes"]]],
    ["an npipe", { media: { ...base, volumes: [{ type: "npipe", source: "x", target: "/x" }] } }, [["media", "volumes"]]],
    ["an env file read from the server", { media: { ...base, env_file: ["/etc/shadow"] } }, [["media", "env_file"]]],
    ["a named volume that binds a folder", { media: { ...base, volumes: ["data:/data"] } }, [[null, "volumes.data"]], { volumes: { data: { driver: "local", driver_opts: { type: "none", o: "bind", device: "/etc" } } } }],
    ["a named volume on a raw device", { media: base }, [[null, "volumes"]], { volumes: { disk: { driver_opts: { type: "ext4", device: "/dev/sda1" } } } }],
    ["a named volume from another driver", { media: base }, [[null, "volumes"]], { volumes: { x: { driver: "sshfs" } } }],
    ["a volume made outside the app", { media: base }, [[null, "volumes"]], { volumes: { x: { external: true, name: "bp-other_data" } } }],
    ["a secret read from the server", { media: base }, [[null, "secrets.key"]], { secrets: { key: { file: "/root/.ssh/id_ed25519" } } }],
    ["a config read from the server", { media: base }, [[null, "configs.c"]], { configs: { c: { file: "/etc/shadow" } } }],
    ["a privileged setting hidden behind a merge key", null, [["media", "privileged"]], null, "x-power: &power\n  privileged: true\nservices:\n  media:\n    <<: *power\n    image: lscr.io/linuxserver/jellyfin:10.10.0\n"],
  ];

  it.each(listed)("lists %s", (_what, services, expected, extra, text) => {
    const findings = text ? powerfulComposeSettings(text, { manifest, managedRoots: [appDirectory] }) : review(services, extra ?? {});
    expect(findings.map((finding) => [finding.service, finding.setting])).toEqual(expected);
    for (const finding of findings) {
      expect(finding.detail, JSON.stringify(finding)).toMatch(/\S/);
      expect(finding.refuse).toBeUndefined();
    }
  });

  it("marks what hands over the server or BoxPilot", () => {
    const system = (volume) => review({ media: { ...base, volumes: [volume] } })[0]?.system;
    for (const volume of ["/:/host", "/etc:/x", "/root:/x", "/home:/x", "/run:/x", "/proc:/host/proc", "/var/lib/docker:/x", "/opt/boxpilot:/x", "/var:/x"]) expect(system(volume), volume).toBe(true);
    expect(system("/srv/other:/x")).toBe(false);
    expect(review({ media: { ...base, volumes: ["/:/host"] } })[0].detail).toBe("mounts / (the whole server) from the server at /host");
    expect(review({ media: base, db: { image: "postgres:16", volumes: ["/var/run/docker.sock:/s"] } })[0].detail).toContain("Docker itself, which is root on this server");
  });

  // [what, services (or extra top-level), the setting refused]
  const refused = [
    ["a file that pulls in another", { media: base }, [null, "include"], { include: ["/etc/boxpilot/x.yaml"] }],
    ["a service that extends another", { media: { ...base, extends: { file: "/tmp/x.yaml", service: "x" } } }, ["media", "extends"]],
  ];
  it.each(refused)("refuses %s outright", (_what, services, expected, extra) => {
    const findings = review(services, extra ?? {});
    expect(findings.filter((finding) => finding.refuse).map((finding) => [finding.service, finding.setting])).toEqual([expected]);
  });

  it("refuses a file it cannot read, or one with no services", () => {
    for (const text of ["services: [unclosed", "services:\n  a: 1\n  a: 2\n", "---\nservices: {}\n---\nservices: {}\n", "just text", "services: nope\n"]) {
      const findings = powerfulComposeSettings(text, { manifest, managedRoots: [appDirectory] });
      expect(findings, text).toHaveLength(1);
      expect(findings[0].refuse, text).toBe(true);
    }
  });

  // What the catalog gives the app is not listed.
  const allowed = [
    ["its own folder", { media: { ...base, volumes: ["./config:/config", "./:/everything", `${appDirectory}/config:/c`] } }],
    ["a data folder its settings name", { media: { ...base, volumes: ["/mnt/disk1/films:/library", "/mnt/disk1/films/new:/new:ro"] } }],
    ["the folders the manifest mounts", { media: { ...base, volumes: ["/srv/media:/library", "/var/run/docker.sock:/var/run/docker.sock", "/proc:/host/proc:ro", { type: "bind", source: "/proc", target: "/p", read_only: true }] } }],
    ["the sidecar's read-only host folder", { media: base, db: { image: "postgres:16", volumes: ["./pgdata:/var/lib/postgresql/data", "/sys:/host/sys:ro"] } }],
    ["its capabilities", { media: { ...base, cap_drop: ["ALL"], cap_add: ["CAP_NET_ADMIN", "net_admin"] } }],
    ["its devices", { media: { ...base, devices: ["/dev/dri/renderD128:/dev/dri/renderD128", "/dev/ttyUSB0"] } }],
    ["its GPU", { media: { ...base, deploy: { resources: { reservations: { devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }] } } } } }],
    ["the host network it may choose", { media: { ...base, network_mode: "host" } }],
    ["its sysctls", { media: { ...base, sysctls: { "net.ipv4.ip_forward": 1 } } }],
    ["no-new-privileges", { media: { ...base, security_opt: ["no-new-privileges:true"] } }],
    ["its images at another version", { media: { image: "lscr.io/linuxserver/jellyfin:10.11.0@sha256:0123" }, db: { image: "docker.io/library/postgres:17" } }],
    ["another service's network in the same file", { media: base, db: { image: "postgres:16", network_mode: "service:media", ipc: "service:media" } }],
    ["named and anonymous volumes and tmpfs", { media: { ...base, volumes: ["cache:/cache", "/scratch", { type: "tmpfs", target: "/tmp" }, { type: "volume", source: "cache", target: "/c2" }] } }, { volumes: { cache: {} } }],
    ["a literal dollar sign in a folder name", { media: { ...base, volumes: ["./config/$$weird:/w"] } }],
    ["privileged off", { media: { ...base, privileged: false, read_only: true } }],
  ];
  it.each(allowed)("lists nothing for %s", (_what, services, extra) => {
    expect(review(services, extra ?? {})).toEqual([]);
  });

  it("lists nothing in a compose file the catalog writes, for any app", async () => {
    // Every manifest, at its defaults, in each network mode it offers, with a GPU and its devices.
    const { manifests } = await loadCatalog();
    expect(manifests.length).toBeGreaterThan(50);
    const concrete = (pattern) => pattern.replace(/\?/g, "0").replace(/\*/g, "0").replace(/\[[^\]]*\]/g, "0");
    for (const entry of manifests) {
      const required = Object.fromEntries(entry.env.filter((field) => field.required && !field.generate && (field.default === null || field.default === undefined)).map((field) => [field.name, field.options?.[0] ?? (field.type === "number" ? "1" : field.type === "boolean" ? "true" : field.type === "path" ? "/srv/x" : field.type === "timezone" ? "Etc/UTC" : "x")]));
      for (const networkMode of entry.networkModes) {
        const { values, errors } = resolveValues(entry, { env: required, networkMode });
        expect(errors, entry.id).toEqual([]);
        const { composeYaml } = renderCompose(entry, values, { devices: [...entry.devices, ...entry.optionalDevices].map(concrete), gpu: true, tailnetAddress: "100.64.0.1" });
        // Only the folders the owner may choose count as the app's own; the manifest's fixed host
        // folders (/, /proc, Docker's socket) must be accepted as what the manifest grants.
        const chosen = entry.volumes.filter((volume) => volume.configurable).map((volume) => values.volumes[volume.id]);
        const findings = powerfulComposeSettings(composeYaml, { manifest: entry, managedRoots: [`/var/lib/boxpilot-managed/catalog/${entry.id}`, ...chosen] });
        expect(findings, `${entry.id} (${networkMode})`).toEqual([]);
      }
    }
  });

  it("marks what a variable decides, and names what it mounts from the app's own folder", () => {
    const findings = review({ media: { ...base, privileged: "${P}", volumes: ["${SRC}:/x", "/:/host"] } });
    expect(findings.map((finding) => [finding.setting, Boolean(finding.variable)])).toEqual([["privileged", true], ["volumes", true], ["volumes", false]]);
    // The restore checks each of these, in what it unpacked, for a link the archive put there.
    const text = YAML.stringify({ services: { media: { ...base, volumes: ["./config:/config", "/srv/x:/x", "./:/all", "/mnt/disk1/films:/f"], env_file: ["./extra.env"] } } });
    expect(appFolderMounts(text, { manifest, managedRoots: [appDirectory, "/mnt/disk1/films"] }).map((mount) => mount.path)).toEqual([`${appDirectory}/config`, appDirectory, `${appDirectory}/extra.env`]);
  });

  it("is pinned by the compose file's own text", () => {
    const text = "services:\n  media:\n    image: x\n";
    expect(composeSha256(text)).toMatch(/^[a-f0-9]{64}$/);
    expect(composeSha256(text)).toBe(composeSha256(text));
    expect(composeSha256(`${text} `)).not.toBe(composeSha256(text));
    expect(sameCompose(text, text.replace(/\n/g, "\r\n"))).toBe(true);
    expect(sameCompose(text, `${text}#`)).toBe(false);
    expect(sameCompose(text, null)).toBe(false);
  });

  it("says each setting in one line", () => {
    const findings = review({ media: { ...base, privileged: true, volumes: ["/:/host"] }, shell: { image: "alpine" } });
    expect(composeFindingsText(findings)).toBe("media: runs privileged: every device and capability, no confinement - root on this server; media: mounts / (the whole server) from the server at /host; shell: is not part of Media in the catalog");
    expect(composeFindingsText(findings, { limit: 1 })).toMatch(/; and 2 more$/);
  });

  it("reads image repositories as Docker does", () => {
    expect(imageRepository("nginx:1.27")).toBe("docker.io/library/nginx");
    expect(imageRepository("docker.io/library/nginx@sha256:00")).toBe("docker.io/library/nginx");
    expect(imageRepository("index.docker.io/library/NGINX")).toBe("docker.io/library/nginx");
    expect(imageRepository("localhost:5000/app:1")).toBe("localhost:5000/app");
    expect(imageRepository("ghcr.io/a/b:c")).toBe("ghcr.io/a/b");
    expect(isSystemLocation("/var")).toBe(true);
    expect(isSystemLocation("/srv/media")).toBe(false);
  });
});
