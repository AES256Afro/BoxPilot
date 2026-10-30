import { describe, expect, it } from "vitest";
import { firmwarePaths, makerOf, powerOnGuidance, readBoardVendor } from "./power-on-guidance.mjs";

describe("powering on after an outage", () => {
  it("knows the common makers by the names their boards report", () => {
    expect(makerOf("ASUSTeK COMPUTER INC.")).toBe("asus");
    expect(makerOf("Micro-Star International Co., Ltd.")).toBe("msi");
    expect(makerOf("Gigabyte Technology Co., Ltd.")).toBe("gigabyte");
    expect(makerOf("ASRock")).toBe("asrock");
    expect(makerOf("Dell Inc.")).toBe("dell");
    expect(makerOf("HP")).toBe("hp");
    expect(makerOf("LENOVO")).toBe("lenovo");
    expect(makerOf("Intel Corporation")).toBe("intel");
    expect(makerOf("Acme Boards")).toBeNull();
    expect(makerOf(null)).toBeNull();
  });

  it("puts this board's maker first and still lists the others", () => {
    const guidance = powerOnGuidance({ boardVendor: "Micro-Star International Co., Ltd." });
    expect(guidance.steps[0]).toMatchObject({ maker: "MSI", thisBoard: true, value: "Power On" });
    expect(guidance.steps[0].text).toBe("MSI: press Del while it starts, then Settings › Advanced › Power Management Setup › Restore after AC Power Loss, and choose Power On.");
    expect(guidance.steps).toHaveLength(firmwarePaths.length);
    expect(guidance.steps.filter((step) => step.thisBoard)).toHaveLength(1);
    expect(guidance.board).toEqual({ vendor: "Micro-Star International Co., Ltd.", maker: "msi" });
  });

  it("names the four makers the owner asked for, Gigabyte by its own word", () => {
    const guidance = powerOnGuidance();
    const byMaker = Object.fromEntries(guidance.steps.map((step) => [step.id, step]));
    expect(byMaker.asus.path.at(-1)).toBe("Restore AC Power Loss");
    expect(byMaker.msi.path.at(-1)).toBe("Restore after AC Power Loss");
    expect(byMaker.gigabyte).toMatchObject({ value: "Always On" });
    expect(byMaker.asrock.path.at(-1)).toBe("Restore On AC/Power Loss");
    expect(guidance.board).toBeNull();
    expect(guidance.steps.every((step) => !step.thisBoard)).toBe(true);
  });

  it("says why Last State is not enough, and what the UPS does, in the owner's situation", () => {
    expect(powerOnGuidance().why[0]).toContain("Last State");
    expect(powerOnGuidance({ upsConfigured: true }).why[1]).toContain("the UPS then switches its outlets off");
    expect(powerOnGuidance({ upsConfigured: false }).why[1]).toContain("With a UPS");
    expect(powerOnGuidance().other).toContain("AC power loss");
  });

  it("reads the board's maker, skipping the placeholders boards ship with", async () => {
    const files = { "/sys/class/dmi/id/board_vendor": "To Be Filled By O.E.M.\n", "/sys/class/dmi/id/sys_vendor": "ASRock\n" };
    await expect(readBoardVendor({ read: async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); } })).resolves.toBe("ASRock");
    await expect(readBoardVendor({ read: async () => { throw new Error("ENOENT"); } })).resolves.toBeNull();
  });
});
