import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewEvent } from "../../activityEvents";
import PasskeysPanel from "./PasskeysPanel";

vi.mock("../../passkey", () => ({ passkeysSupported: () => false, fetchPasskeyStatus: vi.fn(async () => ({ passkeys: [], recoveryCodesRemaining: 0 })), renamePasskey: vi.fn(), registerPasskey: vi.fn(), deletePasskey: vi.fn(), generateRecoveryCodes: vi.fn() }));

afterEach(cleanup);

describe("Passkeys where the browser cannot use them", () => {
  it("offers the Network page, where HTTPS on the LAN is set up, as a button", () => {
    render(<PasskeysPanel csrfToken="csrf" />);
    expect(screen.getByText("This browser cannot use passkeys here")).toBeTruthy();
    const opened: unknown[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener(openViewEvent, onOpen);
    fireEvent.click(screen.getByRole("button", { name: "Open Network" }));
    window.removeEventListener(openViewEvent, onOpen);
    expect(opened).toEqual([{ view: "network", options: {} }]);
  });
});
