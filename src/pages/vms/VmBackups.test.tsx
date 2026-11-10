import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewEvent } from "../../activityEvents";
import { VmBackups } from "./VmBackups";

afterEach(cleanup);

describe("VM backups with no encrypted store", () => {
  it("opens the Backups page, where the store is set up, from a button", () => {
    render(<VmBackups role="owner" start={vi.fn()} data={{ exports: [], destination: null, backups: [], retention: null, recoveries: [], unread: [] }} />);
    expect(screen.getByText(/No encrypted store is set up yet, so there are no second copies\./)).toBeTruthy();
    const opened: unknown[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener(openViewEvent, onOpen);
    fireEvent.click(screen.getByRole("button", { name: "Open Backups" }));
    window.removeEventListener(openViewEvent, onOpen);
    expect(opened).toEqual([{ view: "backups", options: {} }]);
  });

  it("says the store could not be read rather than that there is none, with no button to a page that would not help", () => {
    render(<VmBackups role="owner" start={vi.fn()} data={{ exports: [], destination: null, backups: [], retention: null, recoveries: [], unread: ["the encrypted destination"] }} />);
    expect(screen.getByText("The destination could not be read just now.")).toBeTruthy();
    expect(screen.getByText(/Check again in a moment\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Backups" })).toBeNull();
  });
});
