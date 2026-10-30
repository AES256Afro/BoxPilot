import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PausedNotice, isHeld } from "./Paused";

/*
 * Why nothing can start (M48.7): the Test and Evaluation tabs said "Agents are off" whether they were
 * off, paused, or stopped by the kill switch, and let a paused agent be asked only for the server to
 * refuse. Each case now says what is so and offers the resume to whoever may.
 */

afterEach(cleanup);

const on = { enabled: true, paused: false, pausedUntil: null, killedAt: null };
const steve = { name: "Steve", paused: false, pausedUntil: null };

describe("the paused notice", () => {
  it("has nothing to say while Agents are on and the agent runs", () => {
    expect(isHeld(on, steve)).toBe(false);
    const { container } = render(<PausedNotice module={on} agent={steve} what="a question" canPause owner />);
    expect(container.textContent).toBe("");
  });

  it("says Agents are off, with no button: the owner turns them on at the top of the page", () => {
    render(<PausedNotice module={{ ...on, enabled: false }} agent={steve} what="a question" canPause owner onResumeAll={() => undefined} />);
    expect(screen.getByText(/Agents are off, so nothing runs/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says every agent is paused, until when, and resumes them all for whoever may pause", () => {
    const resume = vi.fn();
    render(<PausedNotice module={{ ...on, paused: true, pausedUntil: "2026-10-13T07:00:00Z" }} agent={steve} what="the evaluation" canPause owner={false} onResumeAll={resume} />);
    expect(screen.getByText(/^Every agent is paused until \d\d:\d\d$/)).toBeTruthy();
    expect(screen.getByText(/The evaluation waits until they are resumed, or until then/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume all" }));
    expect(resume).toHaveBeenCalledTimes(1);
    cleanup();
    // A viewer sees why, and no button.
    render(<PausedNotice module={{ ...on, paused: true }} agent={steve} what="a question" canPause={false} owner={false} onResumeAll={resume} />);
    expect(screen.getByText("Every agent is paused")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says the kill switch stopped them, and offers the resume to the owner alone", () => {
    const resume = vi.fn();
    render(<PausedNotice module={{ ...on, paused: true, killedAt: "2026-10-12T10:00:00Z" }} agent={steve} what="a question" canPause owner={false} onResumeAll={resume} />);
    expect(screen.getByText("The kill switch stopped every agent")).toBeTruthy();
    expect(screen.getByText(/only the owner can/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(<PausedNotice module={{ ...on, paused: true, killedAt: "2026-10-12T10:00:00Z" }} agent={steve} what="a question" canPause owner onResumeAll={resume} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume all" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("says this one agent is paused, that the others run, and resumes it by name", () => {
    const resume = vi.fn();
    expect(isHeld(on, { ...steve, paused: true })).toBe(true);
    render(<PausedNotice module={on} agent={{ ...steve, paused: true }} what="a question" canPause owner onResumeAgent={resume} />);
    expect(screen.getByText("Steve is paused")).toBeTruthy();
    expect(screen.getByText(/A question would be refused until it is resumed\. The other agents run as usual\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume Steve" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
