import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import PageErrorBoundary, { isChunkLoadFailure } from "./PageErrorBoundary";

/**
 * What this is for: before it existed, a page that threw took the whole window with it — navigation
 * included — and left a white screen with no way back. Six pages did exactly that the first time
 * the demo was swept in an empty state.
 */
function Boom({ explode }: { explode: boolean }): React.ReactElement {
  if (explode) throw new Error("Cannot read properties of undefined (reading 'total')");
  return <p>the page rendered</p>;
}

// React prints the caught error itself; the test is about what the owner sees, not that noise.
const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => { cleanup(); quiet.mockClear(); });

describe("a page that fails to render", () => {
  it("stays out of the way when nothing is wrong", () => {
    render(<PageErrorBoundary pageName="Services" resetKey="services"><Boom explode={false} /></PageErrorBoundary>);
    expect(screen.getByText("the page rendered")).toBeTruthy();
  });

  it("says which page, and says the rest of BoxPilot is fine", () => {
    render(<PageErrorBoundary pageName="Services" resetKey="services"><Boom explode /></PageErrorBoundary>);
    expect(screen.getByText(/The Services page could not be shown/)).toBeTruthy();
    expect(screen.getByText(/rest of BoxPilot is unaffected/)).toBeTruthy();
    // The detail is what makes a support bundle worth anything.
    expect(screen.getByLabelText("Error detail").textContent).toContain("reading 'total'");
  });

  it("does not blame the owner for it", () => {
    render(<PageErrorBoundary pageName="Storage" resetKey="storage"><Boom explode /></PageErrorBoundary>);
    expect(screen.getByText(/fault in BoxPilot rather than something you did/)).toBeTruthy();
  });

  it("clears when the owner navigates away, so the way out actually works", () => {
    const { rerender } = render(<PageErrorBoundary pageName="Services" resetKey="services"><Boom explode /></PageErrorBoundary>);
    expect(screen.getByText(/could not be shown/)).toBeTruthy();
    rerender(<PageErrorBoundary pageName="Storage" resetKey="storage"><Boom explode={false} /></PageErrorBoundary>);
    expect(screen.getByText("the page rendered")).toBeTruthy();
    expect(screen.queryByText(/could not be shown/)).toBeNull();
  });

  it("lets them try the same page again without reloading everything", () => {
    let explode = true;
    function Flaky() { return <Boom explode={explode} />; }
    const { rerender } = render(<PageErrorBoundary pageName="Logs" resetKey="logs"><Flaky /></PageErrorBoundary>);
    explode = false;
    fireEvent.click(screen.getByText("Try this page again"));
    rerender(<PageErrorBoundary pageName="Logs" resetKey="logs"><Flaky /></PageErrorBoundary>);
    expect(screen.getByText("the page rendered")).toBeTruthy();
  });

  it("marks itself so the demo sweep cannot mistake a caught crash for a healthy page", () => {
    const { container } = render(<PageErrorBoundary pageName="Users" resetKey="users"><Boom explode /></PageErrorBoundary>);
    expect(container.querySelector("[data-page-error]")?.getAttribute("data-page-error")).toBe("Users");
  });
});

function Thrower({ error }: { error: Error }): ReactNode { throw error; }

describe("the page error boundary, when a page's chunk is gone", () => {
  it("recognises a chunk that could not be fetched, in every browser's wording", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://box/assets/StorageCenter-abc.js",   // Chrome
      "error loading dynamically imported module: https://box/assets/StorageCenter-abc.js",    // Firefox
      "Importing a module script failed.",                                                       // Safari
      "Unable to preload CSS for /assets/index-abc.css",                                          // Vite preload
    ]) expect(isChunkLoadFailure(new Error(message))).toBe(true);
    expect(isChunkLoadFailure(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it("offers a reload, and only a reload, when the page's chunk is gone", () => {
    // React remembers a failed import, so "try this page again" would fail the same way forever.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PageErrorBoundary pageName="Storage" resetKey="storage"><Thrower error={new Error("Failed to fetch dynamically imported module: /assets/StorageCenter-x.js")} /></PageErrorBoundary>);
    expect(screen.getByText("BoxPilot was updated while this tab was open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload BoxPilot" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try this page again" })).toBeNull();
    vi.restoreAllMocks();
  });

  it("still describes an ordinary render fault as a fault, with the retry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PageErrorBoundary pageName="Storage" resetKey="storage"><Thrower error={new Error("boom")} /></PageErrorBoundary>);
    expect(screen.getByText("The Storage page could not be shown")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try this page again" })).toBeTruthy();
    vi.restoreAllMocks();
  });
});
