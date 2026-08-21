import { describe, expect, it, vi } from "vitest";
import { buildMagicPacket, networkWake } from "./network.mjs";

describe("wake-on-LAN task", () => {
  it("builds the 102-byte magic packet: six 0xff then the MAC sixteen times", () => {
    const packet = buildMagicPacket("aa:bb:cc:dd:ee:ff");
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6).toString("hex")).toBe("ffffffffffff");
    expect(packet.subarray(6, 12).toString("hex")).toBe("aabbccddeeff");
    expect(packet.subarray(96, 102).toString("hex")).toBe("aabbccddeeff");
    expect(() => buildMagicPacket("aa:bb:cc:dd:ee")).toThrow("MAC address");
    expect(() => buildMagicPacket("aa:bb:cc:dd:ee:ff; reboot")).toThrow("MAC address");
  });

  it("broadcasts three packets on UDP 9 and closes the socket", async () => {
    const sent = [];
    const socket = {
      bind: vi.fn((_port, callback) => callback()),
      setBroadcast: vi.fn(),
      send: vi.fn((packet, port, address, callback) => { sent.push({ length: packet.length, port, address }); callback(null); }),
      close: vi.fn(),
    };
    const log = vi.fn();
    await expect(networkWake({ mac: "AA:BB:CC:DD:EE:FF" }, { createSocket: () => socket, log })).resolves.toEqual({ sent: true, mac: "aa:bb:cc:dd:ee:ff", broadcast: "255.255.255.255", port: 9, packets: 3 });
    expect(socket.setBroadcast).toHaveBeenCalledWith(true);
    expect(sent).toEqual([{ length: 102, port: 9, address: "255.255.255.255" }, { length: 102, port: 9, address: "255.255.255.255" }, { length: 102, port: 9, address: "255.255.255.255" }]);
    expect(socket.close).toHaveBeenCalledOnce();
    await expect(networkWake({ mac: "aa:bb:cc:dd:ee:ff", broadcast: "evil.example" }, { createSocket: () => socket })).rejects.toThrow("Broadcast address must be IPv4");
  });
});
