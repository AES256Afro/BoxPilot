import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PasskeySettings from "./PasskeySettings";
import { renamePasskey } from "./passkey";
vi.mock("./passkey", () => ({ passkeysSupported: () => true, fetchPasskeyStatus: async () => ({ passkeys: [{ id: "key-one", label: "Phone", rpId: "example.test", createdAt: "2026-09-01T00:00:00Z" }], recoveryCodesRemaining: 0 }), renamePasskey: vi.fn(async () => ({})), registerPasskey: vi.fn(), deletePasskey: vi.fn(), generateRecoveryCodes: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("renames in the page with a trimmed nonempty name", async () => {
  render(<PasskeySettings csrfToken="csrf" />); fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
  const input = screen.getByLabelText("New passkey name"); expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "   " } }); expect(screen.getByRole("button", { name: "Save name" })).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: " Laptop " } }); fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(renamePasskey).toHaveBeenCalledWith("csrf", "key-one", "Laptop"));
  expect(await screen.findByText("Passkey renamed.")).toBeTruthy(); expect(screen.queryByLabelText("New passkey name")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename" })));
});
it("cancels with Escape without changing the passkey", async () => {
  render(<PasskeySettings csrfToken="csrf" />); const opener = await screen.findByRole("button", { name: "Rename" }); fireEvent.click(opener);
  fireEvent.keyDown(screen.getByLabelText("New passkey name"), { key: "Escape" });
  expect(renamePasskey).not.toHaveBeenCalled(); expect(screen.queryByLabelText("New passkey name")).toBeNull(); expect(document.activeElement).toBe(opener);
});
