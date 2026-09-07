import { describe, expect, it, vi } from "vitest";
import { createNeedrestartScanner } from "./needrestart.mjs";

describe("running-library evidence", () => {
  it("shares an expensive scan and dates the evidence", async () => {
    let clock = 0;
    const scanner = createNeedrestartScanner({ now: () => clock });
    const run = vi.fn(async () => ({ ok: true, stdout: "NEEDRESTART-SVC: z.service\nNEEDRESTART-SVC: systemd-manager\nNEEDRESTART-SVC: z.service\n" }));
    const [a, b] = await Promise.all([scanner.inspect(run), scanner.inspect(run)]);
    expect(a).toEqual(b);
    expect(a).toEqual({ services: ["systemd-manager", "z.service"], checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(run).toHaveBeenCalledTimes(1);
    clock = 600_000;
    expect((await scanner.inspect(run)).checkedAt).toBe("1970-01-01T00:10:00.000Z");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a pre-repair scan or cache a failure", async () => {
    const scanner = createNeedrestartScanner();
    let finish;
    const old = scanner.inspect(() => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    scanner.forget();
    await expect(scanner.inspect(async () => ({ ok: false }))).rejects.toThrow("did not finish");
    const fresh = await scanner.inspect(async () => ({ ok: true, stdout: "" }));
    finish({ ok: true, stdout: "NEEDRESTART-SVC: old.service" });
    expect((await old).services).toEqual(["old.service"]);
    expect(await scanner.inspect(() => { throw new Error("must use fresh cache"); })).toEqual(fresh);
  });
});
