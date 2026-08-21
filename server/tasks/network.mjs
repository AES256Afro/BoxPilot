import dgram from "node:dgram";

/**
 * Wake-on-LAN (root side, in boxpilot-run@ for network access): one magic packet to the
 * broadcast address on UDP 9. Nothing is read back; the device either wakes or it does not.
 */

export const macPattern = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function buildMagicPacket(mac) {
  if (typeof mac !== "string" || !macPattern.test(mac)) throw new Error("MAC address must look like aa:bb:cc:dd:ee:ff");
  const hardware = Buffer.from(mac.split(":").map((part) => Number.parseInt(part, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => hardware)]);
}

export async function networkWake({ mac, broadcast = "255.255.255.255", port = 9 } = {}, { log = null, createSocket = dgram.createSocket } = {}) {
  const packet = buildMagicPacket(mac);
  if (typeof broadcast !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(broadcast)) throw new Error("Broadcast address must be IPv4");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535");
  const socket = createSocket("udp4");
  try {
    await new Promise((resolve, reject) => socket.bind(0, () => { try { socket.setBroadcast(true); resolve(); } catch (error) { reject(error); } }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve, reject) => socket.send(packet, port, broadcast, (error) => (error ? reject(error) : resolve())));
    }
  } finally {
    socket.close();
  }
  log?.(`Sent 3 magic packets for ${mac.toLowerCase()} to ${broadcast}:${port}`, "stdout");
  return { sent: true, mac: mac.toLowerCase(), broadcast, port, packets: 3 };
}
