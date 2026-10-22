import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PasskeySettings from "./PasskeysPanel";
import { deletePasskey, generateRecoveryCodes, registerPasskey, renamePasskey } from "../../passkey";
vi.mock("../../passkey", () => ({ passkeysSupported: () => true, fetchPasskeyStatus: async () => ({ passkeys: [{ id: "key-one", label: "Phone", rpId: "example.test", createdAt: "2026-09-01T00:00:00Z" }], recoveryCodesRemaining: 0 }), renamePasskey: vi.fn(async () => ({})), registerPasskey: vi.fn(), deletePasskey: vi.fn(), generateRecoveryCodes: vi.fn() }));
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

it("removes a passkey only with the password asked for on its row, and Keep it leaves it", async () => {
  render(<PasskeySettings csrfToken="csrf" />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Phone" }));
  const field = screen.getByLabelText("Your password, to remove Phone");
  expect(document.activeElement).toBe(field);
  const confirm = screen.getAllByRole("button", { name: "Remove Phone" }).find((button) => (button as HTMLButtonElement).type === "submit") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(screen.queryByLabelText("Your password, to remove Phone")).toBeNull();
  expect(deletePasskey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove Phone" }));
  fireEvent.change(screen.getByLabelText("Your password, to remove Phone"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Remove Phone" }).find((button) => (button as HTMLButtonElement).type === "submit")!);
  await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith("csrf", "key-one", "correct horse battery"));
  expect(await screen.findByText("Removed Phone.")).toBeTruthy();
  expect(screen.queryByLabelText("Your password, to remove Phone")).toBeNull();
});

it("generates recovery codes only with the password, shows them once, and puts them away when saved", async () => {
  vi.mocked(generateRecoveryCodes).mockResolvedValueOnce({ codes: ["AAAAA-BBBBB-CCCCC-DDDDD", "EEEEE-FFFFF-GGGGG-HHHHH"], count: 2 });
  render(<PasskeySettings csrfToken="csrf" />);
  fireEvent.click(await screen.findByRole("button", { name: "Generate recovery codes" }));
  expect(await screen.findByText("Enter your password below to generate recovery codes")).toBeTruthy();
  expect(generateRecoveryCodes).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Password for recovery codes"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes" }));
  await waitFor(() => expect(generateRecoveryCodes).toHaveBeenCalledWith("csrf", "correct horse battery"));
  expect(await screen.findByText(/AAAAA-BBBBB-CCCCC-DDDDD/)).toBeTruthy();
  expect(screen.getByText("Save these now")).toBeTruthy();
  // The password is not kept once it has been used.
  expect((screen.getByLabelText("Password for recovery codes") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Done, I saved them" }));
  expect(screen.queryByText(/AAAAA-BBBBB-CCCCC-DDDDD/)).toBeNull();
});

it("registers a passkey under the name given, or Passkey, and says why when the browser refuses", async () => {
  render(<PasskeySettings csrfToken="csrf" />);
  await screen.findByRole("button", { name: "Rename" });
  fireEvent.change(screen.getByLabelText("Name for a new passkey"), { target: { value: "  YubiKey  " } });
  fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
  await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith("csrf", "YubiKey"));
  expect(await screen.findByText("Passkey registered. Sign in with it next time.")).toBeTruthy();
  expect((screen.getByLabelText("Name for a new passkey") as HTMLInputElement).value).toBe("");
  vi.mocked(registerPasskey).mockRejectedValueOnce(new Error("The browser did not create a passkey"));
  fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
  await waitFor(() => expect(registerPasskey).toHaveBeenLastCalledWith("csrf", "Passkey"));
  expect(await screen.findByText("The browser did not create a passkey")).toBeTruthy();
});
