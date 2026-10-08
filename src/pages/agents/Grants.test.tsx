import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec, Catalog } from "./api";
import { GrantFields } from "./Builder";

/*
 * What an agent carries out itself, on its Build tab (M45.5): the owner gives leave to ask or, for
 * low risk, to run; anyone who edits the agent may lower or take it away, never give it.
 */

afterEach(cleanup);

const catalog = {
  grantable: [
    { id: "app.action", title: "Start, stop, pause, or restart application", risk: "low", most: "run" },
    { id: "app.backup", title: "Back up application data", risk: "medium", most: "ask" },
  ],
} as unknown as Catalog;
const base = { allow: { apps: "*", operations: "*" } } as unknown as AgentSpec;

function Form({ start = base, canGrant }: { start?: AgentSpec; canGrant: boolean }) {
  const [draft, setDraft] = useState(start);
  return (
    <>
      <GrantFields draft={draft} setDraft={(update) => setDraft(update)} catalog={catalog} disabled={false} canGrant={canGrant} />
      <output data-testid="grants">{JSON.stringify(draft.allow.grants ?? null)}</output>
    </>
  );
}

describe("leave to carry out operations", () => {
  it("lets the owner give leave to ask, then raise a low risk one to run", () => {
    render(<Form canGrant />);
    fireEvent.change(screen.getByLabelText("An operation to give it leave for"), { target: { value: "app.action" } });
    fireEvent.click(screen.getByRole("button", { name: "Give leave to ask" }));
    expect(screen.getByTestId("grants").textContent).toBe(JSON.stringify({ "app.action": "ask" }));
    fireEvent.change(screen.getByLabelText("What it may do with app.action"), { target: { value: "run" } });
    expect(screen.getByTestId("grants").textContent).toBe(JSON.stringify({ "app.action": "run" }));
  });

  it("offers a medium risk operation only leave to ask", () => {
    render(<Form canGrant start={{ ...base, allow: { ...base.allow, grants: { "app.backup": "ask" } } }} />);
    const choices = [...(screen.getByLabelText("What it may do with app.backup") as HTMLSelectElement).options].map((option) => option.value);
    expect(choices).toEqual(["ask"]);
  });

  it("lets someone who is not the owner lower or remove leave, never give it", () => {
    render(<Form canGrant={false} start={{ ...base, allow: { ...base.allow, grants: { "app.action": "run" } } }} />);
    expect(screen.queryByLabelText("An operation to give it leave for")).toBeNull();
    expect(screen.getByText(/Only the owner gives leave/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What it may do with app.action"), { target: { value: "ask" } });
    expect(screen.getByTestId("grants").textContent).toBe(JSON.stringify({ "app.action": "ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByTestId("grants").textContent).toBe("null");
  });
});
