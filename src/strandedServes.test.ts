import { describe, expect, it } from "vitest";
import { strandedServes } from "./strandedServes";
// @ts-expect-error -- the server copy is plain JavaScript with no declarations
import { strandedServes as serverCopy } from "../server/tailscale-serve.mjs";

/**
 * The browser must not import server code, so this logic exists twice. Two copies drift the moment
 * nothing checks them against each other, which has already cost this repository more than once, so
 * every case runs through both.
 */
const cases: Array<[string, Parameters<typeof strandedServes>[0], Parameters<typeof strandedServes>[1]]> = [
  ["a port its app left behind", [{ dnsName: "h", port: 8084, target: "http://127.0.0.1:8084" }], [{ ports: [{ port: 80 }] }]],
  ["an address that still reaches its app", [{ dnsName: "h", port: 8096, target: "http://127.0.0.1:8096" }], [{ ports: [{ port: 8096 }] }]],
  ["answering on one port, forwarding to another", [{ dnsName: "h", port: 443, target: "http://127.0.0.1:8096" }], [{ ports: [{ port: 8096 }] }]],
  ["forwarding to a port nobody has", [{ dnsName: "h", port: 443, target: "http://127.0.0.1:9999" }], [{ ports: [{ port: 8096 }] }]],
  ["apps carrying urls rather than ports", [{ dnsName: "h", port: 8096, target: "http://127.0.0.1:8096" }], [{ urls: [{ host: 8096 }] }]],
  ["nothing published at all", [], [{ ports: [{ port: 80 }] }]],
  ["published with no apps installed", [{ dnsName: "h", port: 80, target: "http://127.0.0.1:80" }], []],
  ["a target that cannot be read", [{ dnsName: "h", port: 8084, target: null }], [{ ports: [{ port: 8084 }] }]],
];

describe("the browser and the server agree on what is stranded", () => {
  for (const [name, serves, apps] of cases) {
    it(name, () => {
      expect(serverCopy(serves, apps)).toEqual(strandedServes(serves, apps));
    });
  }

  it("finds the case this exists for", () => {
    const found = strandedServes([{ dnsName: "host", port: 8084, target: "http://127.0.0.1:8084" }], [{ ports: [{ port: 80 }, { port: 53 }] }]);
    expect(found.map((serve) => serve.port)).toEqual([8084]);
  });
});
