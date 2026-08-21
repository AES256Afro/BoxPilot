import { describe, expect, it } from "vitest";
import { parseShowmount, parseSmbclientList, subnetHosts } from "./storage.mjs";

describe("storage route helpers", () => {
  it("enumerates a /24 without the server's own address and refuses big subnets", () => {
    const hosts = subnetHosts("192.168.1.10", 24);
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts).not.toContain("192.168.1.10");
    expect(hosts.at(-1)).toBe("192.168.1.254");
    expect(subnetHosts("10.0.0.5", 30)).toEqual(["10.0.0.6"]);
    expect(subnetHosts("10.0.0.5", 16)).toEqual([]);
    expect(subnetHosts("garbage", 24)).toEqual([]);
  });

  it("parses smbclient -g and showmount output", () => {
    expect(parseSmbclientList("Disk|Public|Public Share\nDisk|TimeMachineBackup|\nIPC|IPC$|IPC Service\nDisk|admin$|hidden\nPrinter|HP|")).toEqual([
      { name: "Public", comment: "Public Share" },
      { name: "TimeMachineBackup", comment: null },
    ]);
    expect(parseShowmount("/volume1/media 192.168.1.0/24\n/volume1/backup *\n")).toEqual([
      { name: "/volume1/media", comment: "allowed: 192.168.1.0/24" },
      { name: "/volume1/backup", comment: "allowed: *" },
    ]);
    expect(parseShowmount("")).toEqual([]);
  });
});
