import { expect, it } from "vitest";
import { dataScanCommand, readScanPressure, scanDeferral } from "./scan-resources.mjs";

it("defers sustained pressure while retaining unknown as unknown", async () => {
  const pressure = await readScanPressure({ read: async (file) => {
    if (file.endsWith("memory")) return "some avg10=2.00 avg60=3.00 avg300=1.00 total=400\nfull avg10=1.00 avg60=1.25 avg300=0.30 total=20\n";
    throw new Error("not supported");
  } });
  expect(pressure.cpu).toBeNull(); expect(pressure.io).toBeNull();
  expect(scanDeferral(pressure)).toContain("MEMORY pressure");
  expect(scanDeferral({})).toBeNull();
  expect(scanDeferral({ io: { full: { avg60: 9.99 } }, cpu: { some: { avg60: 79.99 } } })).toBeNull();
  expect(scanDeferral({ io: { full: { avg60: 10 } } })).toContain("IO pressure");
  expect(scanDeferral({ cpu: { some: { avg60: 80 } } })).toContain("CPU pressure");
});

it("requests idle IO and nice 10 without placing paths in a shell", async () => {
  const folder = "/data/$(touch should-not-run)";
  expect(await dataScanCommand(folder, { platform: "linux", executable: async () => true })).toEqual({
    binary: "/usr/bin/ionice", args: ["-c", "3", "-t", "/usr/bin/nice", "-n", "10", "/usr/bin/du", "-sbx", folder], priority: "idle-io-requested-and-nice-10",
  });
});

it("degrades to available tools without falsely claiming idle IO priority", async () => {
  expect(await dataScanCommand("/data", { platform: "linux", executable: async (file) => file.endsWith("/nice") })).toMatchObject({ binary: "/usr/bin/nice", priority: "nice-10" });
  expect(await dataScanCommand("/data", { platform: "linux", executable: async () => false })).toMatchObject({ binary: "/usr/bin/du", priority: "default" });
  expect(await dataScanCommand("/data", { platform: "darwin", executable: async () => { throw new Error("must not probe Linux tools"); } })).toMatchObject({ binary: "du", priority: "default" });
});
