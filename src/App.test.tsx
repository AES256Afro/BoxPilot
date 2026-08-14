import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(cleanup);

describe("BoxPilot console", () => {
  it("navigates between product areas", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.getByText("Keel Notes")).toBeTruthy();
  });

  it("opens the browser-only Compose inspector", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import Compose" }));
    expect(screen.getByRole("dialog", { name: "Inspect a Compose stack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run dry scan" }));
    expect(screen.getByText("No high-risk patterns detected by this basic scan.")).toBeTruthy();
  });
});
