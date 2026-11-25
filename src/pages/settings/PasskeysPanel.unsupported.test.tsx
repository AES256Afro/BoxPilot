import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openViewEvent } from "../../activityEvents";
import { generateRecoveryCodes } from "../../passkey";
import PasskeysPanel from "./PasskeysPanel";

// The real passkeysSupported, so the page is driven by what the browser says: a plain-HTTP LAN
// address is not a secure context, even in a browser that has WebAuthn.
vi.mock("../../passkey", async (importActual) => {
  const actual = await importActual<typeof import("../../passkey")>();
  return { passkeysSupported: actual.passkeysSupported, fetchPasskeyStatus: vi.fn(async () => ({ passkeys: [], recoveryCodesRemaining: 0 })), renamePasskey: vi.fn(), registerPasskey: vi.fn(), deletePasskey: vi.fn(), generateRecoveryCodes: vi.fn(async () => ({ codes: ["aaaa-bbbb", "cccc-dddd"] })) };
});

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  Object.defineProperty(window, "PublicKeyCredential", { value: function PublicKeyCredential() {}, configurable: true, writable: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Reflect.deleteProperty(window, "PublicKeyCredential");
});

describe("Passkeys where the browser cannot use them", () => {
  it("offers the Network page, where HTTPS on the LAN is set up, as a button", () => {
    render(<PasskeysPanel csrfToken="csrf" />);
    expect(screen.getByText("This browser cannot use passkeys here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    const opened: unknown[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener(openViewEvent, onOpen);
    fireEvent.click(screen.getByRole("button", { name: "Open Network" }));
    window.removeEventListener(openViewEvent, onOpen);
    expect(opened).toEqual([{ view: "network", options: {} }]);
  });

  // M90: the recovery codes sat inside the same early return, so an owner on plain HTTP could not
  // make them, though the server needs no HTTPS for them and the sign-in page offers them.
  it("still makes recovery codes over plain HTTP", async () => {
    render(<PasskeysPanel csrfToken="csrf" />);
    expect(screen.getByRole("heading", { name: "Recovery codes" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password for recovery codes"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes" }));
    await waitFor(() => expect(generateRecoveryCodes).toHaveBeenCalledWith("csrf", "correct horse battery"));
    expect(await screen.findByText(/aaaa-bbbb/)).toBeTruthy();
  });
});
