import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyButton from "./CopyButton";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("clipboard feedback", () => {
  it.each([undefined, { writeText: async () => { throw new Error("permission denied"); } }])("offers manual copy when the clipboard is unavailable or denied", async (clipboard) => {
    vi.stubGlobal("navigator", { clipboard }); render(<CopyButton value="visible path" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Copy unavailable. Select the text and copy it manually.");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
  });
  it("reports success only after writing the current value", async () => {
    let finish: () => void = () => {};
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(<CopyButton value="first" />); fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Copied")).toBeNull(); view.rerender(<CopyButton value="second" />); finish();
    await waitFor(() => expect(screen.getByRole("button")).toHaveProperty("textContent", "Copy"));
    fireEvent.click(screen.getByRole("button")); finish();
    expect(await screen.findByText("Copied")).toBeTruthy(); expect(writeText).toHaveBeenLastCalledWith("second");
  });
});
