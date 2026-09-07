import { describe, expect, it, vi } from "vitest";
import { invalidateOperationEvidence } from "./diagnostic-invalidation.mjs";
function deps(readOnly = false) { return { registry: { get: () => ({ readOnly }) }, inventory: { forget: vi.fn() }, prerequisites: { forget: vi.fn() }, helper: { invalidate: vi.fn() } }; }
describe("evidence after operations", () => {
  it("leaves read-only operations and expensive disk-usage scans alone", () => {
    const services = deps(true);
    invalidateOperationEvidence({ type: "op:app.inspect" }, services);
    expect(services.inventory.forget).not.toHaveBeenCalled();
    expect(services.helper.invalidate).not.toHaveBeenCalled();
  });
  it("refreshes app evidence after a mutation without restarting unrelated scans", () => {
    const services = deps();
    invalidateOperationEvidence({ type: "op:app.install" }, services);
    expect(services.inventory.forget).toHaveBeenCalledOnce();
    expect(services.prerequisites.forget).not.toHaveBeenCalled();
    expect(services.helper.invalidate).toHaveBeenCalledWith(["app.inspect", "container.docker.inventory", "app.backups.counts"]);
  });
  it("refreshes prerequisites after package changes, including failed jobs", () => {
    const services = deps();
    invalidateOperationEvidence({ type: "op:apt.upgrade", state: "failed" }, services);
    expect(services.prerequisites.forget).toHaveBeenCalledOnce();
    expect(services.helper.invalidate.mock.calls[0][0]).toContain("prerequisite.docker.inspect");
    expect(services.helper.invalidate.mock.calls[0][0]).not.toContain("app.data.usage");
  });
});
