import { describe, expect, it, vi } from "vitest";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
import { hashPassword, renderAutoinstall, validateAutoinstallInput } from "./autoinstall.mjs";

const base = { hostname: "garage-box", username: "owner", password: "correct horse battery", sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHexample owner@laptop"], network: { mode: "dhcp" }, disk: { layout: "lvm" } };

describe("Ubuntu autoinstall generator", () => {
  it("renders a NoCloud user-data that installs BoxPilot on first boot", () => {
    const { userData, metaData, ref } = renderAutoinstall(base, { passwordHash: "$6$salt$hash", defaultRef: "v0.62.5" });
    expect(userData.startsWith("#cloud-config\n")).toBe(true);
    expect(userData).toContain("hostname: garage-box");
    expect(userData).toContain('password: "$6$salt$hash"');
    expect(userData).toContain("allow-pw: false");
    expect(userData).toContain('- "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHexample owner@laptop"');
    expect(userData).toContain("dhcp4: true");
    expect(userData).toContain("name: lvm");
    expect(userData).toContain("sizing-policy: all");
    expect(userData).toContain("boxpilot-install.sh | sh -s -- --ref v0.62.5 --access lan --no-token");
    expect(metaData).toBe("instance-id: boxpilot-garage-box\nlocal-hostname: garage-box\n");
    expect(ref).toBe("v0.62.5");
  });

  it("renders static networking and password logins when no key is given", () => {
    const { userData } = renderAutoinstall({ ...base, sshKeys: [], network: { mode: "static", address: "192.168.1.20/24", gateway: "192.168.1.1", nameservers: ["192.168.1.1", "1.1.1.1"] }, disk: { layout: "direct" }, boxpilotRef: "v0.63.0" }, { passwordHash: "$6$x" });
    expect(userData).toContain("allow-pw: true");
    expect(userData).not.toContain("authorized-keys");
    expect(userData).toContain("- 192.168.1.20/24");
    expect(userData).toContain("via: 192.168.1.1");
    expect(userData).toContain("- 1.1.1.1");
    expect(userData).toContain("name: direct");
    expect(userData).toContain("--ref v0.63.0");
  });

  it("rejects unsafe or malformed input before rendering", () => {
    expect(validateAutoinstallInput({ ...base, hostname: "Bad Host" })).toContain("hostname must be lower-case letters, digits, and hyphens");
    expect(validateAutoinstallInput({ ...base, username: "root" })).toContain("username must be a Unix user name (not root)");
    expect(validateAutoinstallInput({ ...base, password: "short" })).toContain("password must be 12 to 256 characters");
    expect(validateAutoinstallInput({ ...base, sshKeys: ["not a key"] })).toContain("sshKeys must be a list of OpenSSH public keys");
    expect(validateAutoinstallInput({ ...base, network: { mode: "static", address: "nope", gateway: "x", nameservers: [] } })).toEqual(expect.arrayContaining([expect.stringContaining("network.address"), expect.stringContaining("network.gateway"), expect.stringContaining("network.nameservers")]));
    expect(validateAutoinstallInput({ ...base, boxpilotRef: "../../etc" })).toContain("boxpilotRef must be a release tag like v1.2.3");
    expect(() => renderAutoinstall({ ...base, disk: { layout: "zfs" } }, { passwordHash: "$6$x" })).toThrow("disk.layout");
  });

  it("hashes the password with openssl sha512-crypt and never echoes it", async () => {
    const run = vi.fn(async (binary, args, options) => ({ ok: true, stdout: "$6$abc$def\n", stderr: "", received: options.input }));
    await expect(hashPassword("correct horse battery", { run })).resolves.toBe("$6$abc$def");
    expect(run).toHaveBeenCalledWith("openssl", ["passwd", "-6", "-stdin"], expect.objectContaining({ input: "correct horse battery\n" }));
    await expect(hashPassword("x", { run: async () => ({ ok: false, stdout: "", stderr: "boom" }) })).rejects.toThrow("hashing with openssl failed");
  });
});
