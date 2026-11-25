import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobActions } from "./JobActions";
import type { Job } from "./operations";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const failed = (error: string): Job => ({ id: "job-1", type: "op:app.install", title: "Install Immich", state: "failed", risk: "medium", error, result: null, parameters: { id: "immich" }, steps: [], approvals: [] });

describe("Try again on a failed job (M89)", () => {
  it("says what the error asks to do first beside the button, and the button says it was done", () => {
    const onRetry = vi.fn();
    const job = failed("BoxPilot restarted while this job was running. The operation itself may still have finished on its own; check what it changed before retrying.");
    render(<JobActions job={job} role="owner" csrfToken="csrf" onReview={() => undefined} onRetry={onRetry} />);
    expect(screen.getByText("Check what it changed before retrying.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Checked, try again" }));
    expect(onRetry).toHaveBeenCalledWith(job);
  });

  it("keeps plain Try again for an error that asks nothing first", () => {
    render(<JobActions job={failed("The image could not be pulled.")} role="owner" csrfToken="csrf" onReview={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/before retrying/)).toBeNull();
  });

  it("says a dismiss that got no answer in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<JobActions job={failed("The image could not be pulled.")} role="owner" csrfToken="csrf" onReview={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("BoxPilot did not answer. It may be restarting, or this device is off the network.")).toBeTruthy();
  });
});
