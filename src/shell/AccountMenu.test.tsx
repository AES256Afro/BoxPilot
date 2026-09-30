import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openActivityEvent } from "../activityEvents";
import { AccountMenu } from "./AccountMenu";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const authStatus = { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "alex", role: "owner" }, csrfToken: "csrf" } as never;

describe("the account menu (M41)", () => {
  it("opens Activity, goes to Settings, and signs out, with the keyboard as a menu has it", async () => {
    const onNavigate = vi.fn();
    const onSignedOut = vi.fn();
    const opened = vi.fn();
    window.addEventListener(openActivityEvent, opened);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
    // The menu is hidden until a look shows it; here it is rendered on its own.
    render(<AccountMenu authStatus={authStatus} csrfToken="csrf" onNavigate={onNavigate} onSignedOut={onSignedOut} />);
    const button = document.querySelector<HTMLButtonElement>(".account-menu__button")!;
    expect(button.getAttribute("aria-label")).toBe("Account: alex");
    fireEvent.click(button);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement?.textContent).toBe("Activity");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Notifications");
    fireEvent.click(within(menu).getByText("Activity"));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(document.querySelector('[role="menu"]')!, { key: "Escape" });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(within(document.querySelector<HTMLElement>('[role="menu"]')!).getByText("Settings"));
    expect(onNavigate).toHaveBeenCalledWith("settings");
    fireEvent.click(button);
    fireEvent.click(within(document.querySelector<HTMLElement>('[role="menu"]')!).getByText("Sign out"));
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledWith(null));
    window.removeEventListener(openActivityEvent, opened);
    void screen;
  });
});
