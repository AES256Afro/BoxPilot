import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirewallBruteForce } from "./FirewallBruteForce";
import type { Fail2banState } from "./types";

afterEach(cleanup);

const read = (banTimeMinutes: number): Fail2banState => ({
  installed: true, running: true, configured: true, currentlyBanned: 2, totalBanned: 9,
  config: { managed: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes, ignoreLan: true, ignore: ["127.0.0.1/8"], sshd: true },
} as Fail2banState);

describe("brute-force thresholds being edited", () => {
  it("keep what was typed through a read that says the same, and start over when the server's change", () => {
    const props = { error: null, role: "owner", start: () => undefined, onRetry: () => undefined };
    const view = render(<FirewallBruteForce {...props} state={read(120)} />);
    const banFor = () => screen.getByLabelText("Ban for (minutes)") as HTMLInputElement;
    fireEvent.change(banFor(), { target: { value: "240" } });
    expect(banFor().value).toBe("240");

    // The page reads fail2ban again: a new object with the same thresholds.
    view.rerender(<FirewallBruteForce {...props} state={read(120)} />);
    expect(banFor().value).toBe("240");

    // The thresholds in force changed (an apply finished): the form shows them.
    view.rerender(<FirewallBruteForce {...props} state={read(60)} />);
    expect(banFor().value).toBe("60");
  });
});

// M90: the page said how many addresses were banned, never which, and only "Turn off protection" lifted one.
describe("banned addresses", () => {
  const withBans = { ...read(120), bannedAddresses: ["203.0.113.7", "2001:db8::5"] } as Fail2banState;

  it("are listed for every role, and an operator lifts one ban with its own medium job", () => {
    const start = vi.fn();
    render(<FirewallBruteForce error={null} role="operator" start={start} onRetry={() => undefined} state={withBans} />);
    const table = screen.getByRole("table", { name: "Addresses banned from SSH now" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => row.querySelector("code")?.textContent)).toEqual(["203.0.113.7", "2001:db8::5"]);
    const unban = within(table).getByRole("button", { name: "Lift the ban on 203.0.113.7" });
    expect(unban.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(unban);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "fail2ban.unban", parameters: { address: "203.0.113.7" } }));
    cleanup();

    render(<FirewallBruteForce error={null} role="viewer" start={start} onRetry={() => undefined} state={withBans} />);
    const viewerTable = screen.getByRole("table", { name: "Addresses banned from SSH now" });
    expect(within(viewerTable).getByText("203.0.113.7")).toBeTruthy();
    expect(within(viewerTable).queryByRole("button", { name: /Lift the ban/ })).toBeNull();
  });

  it("say how many more are banned than were listed", () => {
    render(<FirewallBruteForce error={null} role="owner" start={() => undefined} onRetry={() => undefined} state={{ ...withBans, currentlyBanned: 5 }} />);
    expect(screen.getByText("and 3 more not listed")).toBeTruthy();
  });
});
