import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
