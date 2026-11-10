import { afterEach, describe, expect, it, vi } from "vitest";
import { onPageRefresh, refreshEvent, requestRefresh } from "./refresh";

/** A job ended somewhere: what the feed sends the page in front. */
const jobEnded = () => window.dispatchEvent(new CustomEvent(refreshEvent, { cancelable: true, detail: "job" }));
/** A read the test lets land when it chooses. */
function held() {
  const landing: Array<() => void> = [];
  const read = vi.fn(() => new Promise<void>((resolve) => { landing.push(resolve); }));
  return { read, land: async () => { landing.shift()?.(); await Promise.resolve(); await Promise.resolve(); } };
}
const hide = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => { Reflect.deleteProperty(document, "hidden"); });

describe("a page's reads when a job ends, and when the bar's Refresh is pressed", () => {
  it("gives the bar's Refresh the page's own Check again, and a job its quiet read", () => {
    const asked = vi.fn(); const job = vi.fn();
    const stop = onPageRefresh({ asked, job });
    expect(requestRefresh({ reload: () => { throw new Error("reloaded"); } })).toBe("refreshed");
    expect(asked).toHaveBeenCalledTimes(1); expect(job).not.toHaveBeenCalled();
    jobEnded();
    expect(job).toHaveBeenCalledTimes(1); expect(asked).toHaveBeenCalledTimes(1);
    stop();
    jobEnded();
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("never has two job reads out at once: jobs that end during one make one more, after it lands", async () => {
    const { read, land } = held();
    const stop = onPageRefresh({ asked: vi.fn(), job: read });
    jobEnded(); jobEnded(); jobEnded();
    expect(read).toHaveBeenCalledTimes(1);
    await land();
    // The read that was out may have been answered before the later jobs ended: one more, and only one.
    expect(read).toHaveBeenCalledTimes(2);
    await land();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("waits for the page's own Check again too, when that is the read that is out", async () => {
    const asked = held(); const job = vi.fn();
    const stop = onPageRefresh({ asked: asked.read, job });
    requestRefresh({ reload: () => undefined });
    jobEnded();
    expect(job).not.toHaveBeenCalled();
    await asked.land();
    expect(job).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads nothing while the tab is hidden, and once when it is looked at again", () => {
    const job = vi.fn();
    const stop = onPageRefresh({ asked: vi.fn(), job });
    hide(true);
    jobEnded(); jobEnded();
    expect(job).not.toHaveBeenCalled();
    hide(false);
    expect(job).toHaveBeenCalledTimes(1);
    // Nothing ended while it was away: coming back reads nothing.
    hide(true); hide(false);
    expect(job).toHaveBeenCalledTimes(1);
    stop();
  });
});
