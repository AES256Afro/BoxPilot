import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellHostProvider, TopBarSlotProvider } from "../shell/TopBarSlot";
import {
  Checkbox, CodeBlock, EmptyState, Field, JobProgress, KeyValue, Notice, PageHeader, Panel, Progress, SearchField, SecretInput, Segmented, Select, Sheet,
  Switch, Table, Tabs, Tag, TextInput, Textarea, Toolbar, useUrlParam,
} from ".";

/*
 * The console's page kit (M33.8): each component's names, states and keyboard, as assistive
 * technology meets them. The looks are checked in the gallery's screenshots.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PageHeader", () => {
  it("names the page in the shell's bar after the server, and puts the verdict and facts first", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <TopBarSlotProvider value={slot}>
        <ShellHostProvider value="homebox">
          <main><PageHeader title="Services" status={{ status: "danger", label: "2 failed" }} meta={<><b>142</b> units</>} actions={<button type="button">Read again</button>} /></main>
        </ShellHostProvider>
      </TopBarSlotProvider>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Services" });
    expect(slot.contains(heading)).toBe(true);
    expect(heading.closest(".cc-crumb")?.querySelector(".cc-crumb__host")?.textContent).toBe("homebox");
    const main = screen.getByRole("main");
    expect(within(main).getByText("2 failed").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(main.querySelector(".ui-page-header__meta")?.textContent).toBe("142 units");
    expect(within(main).getByRole("button", { name: "Read again" })).toBeTruthy();
    slot.remove();
  });

  it("keeps what the page is for behind a toggle, and draws the name in place without a shell", () => {
    render(<PageHeader title="Logs" about="Any journal, unit or container." />);
    expect(screen.getByRole("heading", { level: 1, name: "Logs" }).closest(".cc-crumb")?.querySelector(".cc-crumb__host")?.textContent).toBe("boxpilot");
    const toggle = screen.getByRole("button", { name: "About Logs" });
    const about = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(about?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(about?.hidden).toBe(false);
  });
});

describe("Panel", () => {
  it("is a region named by its title, with its count in the heading, facts, a body and a footer", () => {
    render(<Panel title="Alerts" count={{ status: "warning", label: "2" }} meta="each opens its page" footer="read 1m ago"><p>rows</p></Panel>);
    const region = screen.getByRole("region", { name: "Alerts" });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("Alerts, 2");
    expect(region.querySelector(".ui-panel__count")?.getAttribute("data-status")).toBe("warning");
    expect(within(region).getByText("each opens its page")).toBeTruthy();
    expect(within(region).getByText("read 1m ago").tagName).toBe("FOOTER");
    cleanup();
    render(<Panel title="Units" count={12} level={3} padded label="Units, 12 of 214"><p>rows</p></Panel>);
    expect(screen.getByRole("heading", { level: 3, name: "Units, 12" })).toBeTruthy();
    // A label names the region when the title alone would not do (Repair's "Critical, 2").
    expect(screen.getByRole("region", { name: "Units, 12 of 214" }).classList.contains("ui-panel--padded")).toBe(true);
  });
});

describe("Field and the text controls", () => {
  it("gives the control its label, hint and error, and marks it invalid", () => {
    render(<Field label="Hostname" hint="Letters, digits and hyphens" error="Too long" required><TextInput value="x" onChange={() => undefined} /></Field>);
    const input = screen.getByRole("textbox", { name: /Hostname/ });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.hasAttribute("required")).toBe(true);
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Too long", "Letters, digits and hyphens"]);
  });

  it("reports each change's value, in a textarea too", () => {
    const onValueChange = vi.fn();
    render(<><Field label="Note"><Textarea value="" onValueChange={onValueChange} /></Field><TextInput aria-label="Path" mono value="" onValueChange={onValueChange} /></>);
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "hello" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Path" }), { target: { value: "/srv" } });
    expect(onValueChange.mock.calls).toEqual([["hello"], ["/srv"]]);
    expect(screen.getByRole("textbox", { name: "Path" }).classList.contains("ui-input--mono")).toBe(true);
  });

  it("masks a secret until asked, and never offers it to autofill or spell-check", () => {
    const { container } = render(<Field label="API token"><SecretInput value="s3cr3t" onChange={() => undefined} /></Field>);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(screen.getByLabelText("API token")).toBe(input);
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    const reveal = screen.getByRole("button", { name: "Show" });
    expect(reveal.getAttribute("aria-controls")).toBe(input.id);
    fireEvent.click(reveal);
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(input.type).toBe("password");
  });
});

describe("Select", () => {
  it("is the browser's own select with the field's label and a placeholder", () => {
    const onValueChange = vi.fn();
    render(<Field label="Since"><Select value="" placeholder="Any time" onValueChange={onValueChange} options={[{ value: "1h", label: "Last hour" }, { value: "1d", label: "Last day" }]} /></Field>);
    const select = screen.getByRole("combobox", { name: "Since" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Any time", "Last hour", "Last day"]);
    fireEvent.change(select, { target: { value: "1d" } });
    expect(onValueChange).toHaveBeenCalledWith("1d");
  });
});

describe("Switch and Checkbox", () => {
  it("says on or off, flips with a click on it or its label, and reads its tier", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Automatic security updates" description="Installs them overnight" risk="medium" checked={on} onChange={setOn} />;
    }
    render(<Harness />);
    const control = screen.getByRole("switch", { name: "Automatic security updates" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.textContent).toContain("On");
    const described = (control.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Installs them overnight", "Medium risk: shows a preview and asks you to confirm."]);
    expect(screen.getByText("Med").closest(".ui-risk")).not.toBeNull();
  });

  it("is a real checkbox under the drawn box, with a mixed state", () => {
    const onChange = vi.fn();
    render(<><Checkbox label="Include volumes" description="Named volumes too" onChange={onChange} /><Checkbox label="All apps" indeterminate /></>);
    const box = screen.getByRole("checkbox", { name: "Include volumes" });
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(document.getElementById(box.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Named volumes too");
    expect((screen.getByRole("checkbox", { name: "All apps" }) as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe("Segmented", () => {
  it("is a radio group: arrow keys move the choice, and only the chosen one is a tab stop", () => {
    function Harness() {
      const [value, setValue] = useState<"common" | "failed" | "all">("common");
      return <Segmented label="Which units" value={value} onChange={setValue} options={[{ value: "common", label: "Common", count: 12 }, { value: "failed", label: "Failed", count: 1 }, { value: "all", label: "All" }]} />;
    }
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Which units" });
    const common = within(group).getByRole("radio", { name: "Common 12" });
    expect(common.getAttribute("aria-checked")).toBe("true");
    expect(within(group).getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    common.focus();
    fireEvent.keyDown(common, { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { name: "Failed 1" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(within(group).getByRole("radio", { name: "Failed 1" }));
  });
});

describe("Tabs", () => {
  const tabs = [{ id: "disks", label: "Disks", count: 3 }, { id: "shares", label: "Shares", status: "warning" as const, statusLabel: "1 needs a look" }, { id: "swap", label: "Swap" }];

  it("follows the ARIA tabs pattern: one tab stop, arrows and Home and End, a named panel", () => {
    render(<Tabs label="Storage" tabs={tabs}>{(id) => <p>{id} panel</p>}</Tabs>);
    const list = screen.getByRole("tablist", { name: "Storage" });
    const disks = within(list).getByRole("tab", { name: "Disks 3" });
    expect(disks.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Disks 3" }).textContent).toBe("disks panel");
    disks.focus();
    fireEvent.keyDown(disks, { key: "End" });
    expect(document.activeElement).toBe(within(list).getByRole("tab", { name: "Swap" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("swap panel");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel").textContent).toBe("disks panel");
    expect(within(list).getByRole("tab", { name: "Shares, 1 needs a look" })).toBeTruthy();
  });

  it("keeps the open tab in the address when asked, and opens the one the address names", () => {
    window.history.replaceState(null, "", "/?view=storage&tab=shares");
    render(<Tabs label="Storage" tabs={tabs} urlParam="tab">{(id) => <p>{id} panel</p>}</Tabs>);
    expect(screen.getByRole("tabpanel").textContent).toBe("shares panel");
    fireEvent.click(screen.getByRole("tab", { name: "Swap" }));
    expect(window.location.search).toBe("?view=storage&tab=swap");
    fireEvent.click(screen.getByRole("tab", { name: "Disks 3" }));
    expect(window.location.search).toBe("?view=storage");
  });

  it("ignores a tab the address names that does not exist", () => {
    window.history.replaceState(null, "", "/?tab=nothing");
    function Probe() { const [value] = useUrlParam("tab", ["a", "b"] as const, "a"); return <p>{value}</p>; }
    render(<Probe />);
    expect(screen.getByText("a")).toBeTruthy();
  });
});

describe("KeyValue, Notice, EmptyState, Tag", () => {
  it("lists facts as label and value pairs, with a status's mark", () => {
    render(<KeyValue layout="strip" items={[{ id: "ufw", label: "UFW", value: "active", status: "good" }, { id: "rules", label: "Rules", value: "10", mono: true }]} />);
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    const values = screen.getAllByRole("definition").map((value) => value.textContent);
    expect(terms).toEqual(["UFW", "Rules"]);
    expect(values).toEqual(["active", "10"]);
    expect(screen.getByText("active").closest(".ui-kv__item")?.getAttribute("data-status")).toBe("good");
  });

  it("announces a notice only when asked, as an alert for trouble, and can be dismissed", () => {
    const onDismiss = vi.fn();
    render(<><Notice tone="danger" live title="The journal could not be read" onDismiss={onDismiss}>Try again in a moment.</Notice><Notice tone="info" title="Quiet" /></>);
    expect(screen.getByRole("alert").textContent).toContain("The journal could not be read");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("says what is empty and offers the one action", () => {
    render(<EmptyState title="No backups yet" action={<button type="button">Back up now</button>}>Each app's first backup appears here.</EmptyState>);
    expect(screen.getByText("No backups yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeTruthy();
  });

  it("says who can reach something and what a tier asks, in words", () => {
    render(<><Tag reach="lan" /><Tag reach="tailnet" /><Tag tier="high" /><Tag tone="info">ext4</Tag></>);
    expect(screen.getByText("LAN").closest(".ui-tag")?.textContent).toBe("LAN: reachable from the local network");
    expect(screen.getByText("High").closest(".ui-tag")?.textContent).toBe("High risk");
    expect(screen.getByText("High").closest(".ui-tag")?.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("ext4").className).toContain("ui-tag--info");
  });
});

describe("Toolbar and SearchField", () => {
  it("groups the controls under a name, and clears the search with Escape or its button", () => {
    function Harness() {
      const [value, setValue] = useState("dock");
      return <Toolbar label="Units" search={{ value, onValueChange: setValue, label: "Filter units" }} actions={<button type="button">Read again</button>} />;
    }
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Units" });
    const search = within(group).getByRole("searchbox", { name: "Filter units" }) as HTMLInputElement;
    expect(search.value).toBe("dock");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    fireEvent.change(search, { target: { value: "ssh" } });
    fireEvent.click(within(group).getByRole("button", { name: "Clear filter units" }));
    expect(search.value).toBe("");
  });

  it("leaves Escape alone when there is nothing to clear, so a dialog can close", () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}><SearchField label="Filter" value="" onValueChange={() => undefined} /></div>);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalled();
  });
});

describe("Sheet", () => {
  it("is a modal dialog that holds focus, closes on Escape and gives focus back", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open journal</button>{open && <Sheet kicker="Journal" title="docker.service" onClose={() => setOpen(false)} footer={<button type="button">Read again</button>}><p>lines</p></Sheet>}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open journal" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "docker.service" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Read again" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from its button and from the backdrop, not from a press inside", () => {
    const onClose = vi.fn();
    render(<Sheet title="Share a folder" side="center" onClose={onClose}><p>form</p></Sheet>);
    fireEvent.mouseDown(screen.getByText("form"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.mouseDown(document.querySelector(".ui-sheet-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("CodeBlock and Progress", () => {
  it("shows the text exactly, names it, and copies it or says it could not", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CodeBlock label="Journal for docker.service" meta="2 lines">{"one\ntwo"}</CodeBlock>);
    const pre = screen.getByLabelText("Journal for docker.service");
    expect(pre.textContent).toBe("one\ntwo");
    expect(pre.tabIndex).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("one\ntwo"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    cleanup();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<CodeBlock label="Output" empty="Nothing yet">{""}</CodeBlock>);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("is a progressbar with a value, and indeterminate without one", () => {
    render(<><Progress label="Backing up Immich" value={62} detail="62%" /><Progress label="Restarting" /></>);
    const known = screen.getByRole("progressbar", { name: "Backing up Immich" });
    expect(known.getAttribute("aria-valuenow")).toBe("62");
    expect(known.getAttribute("aria-valuetext")).toBe("62%");
    const unknown = screen.getByRole("progressbar", { name: "Restarting" });
    expect(unknown.hasAttribute("aria-valuenow")).toBe(false);
  });
});

describe("JobProgress", () => {
  it("follows a job to its end, shows its newest line and its output, and says when it finished", async () => {
    // The job runs until the test finishes it, however many reads happen in between: the reads
    // come every 10 ms, and a job that finished on the second read could be done before a slow
    // runner looked at the running bar.
    let state = "applying";
    let reads = 0;
    const onDone = vi.fn();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/jobs/job-1") {
        reads += 1;
        return json({ job: { id: "job-1", type: "op:service.action", title: "Control a system service", state, risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: "2026-09-29T10:00:00Z", updatedAt: "2026-09-29T10:00:41Z" } });
      }
      if (url === "/api/v1/jobs/job-1/output") return json({ output: "stopping\nstarted docker\n", state });
      return json({ error: "unexpected" }, 404);
    }));
    render(<JobProgress jobId="job-1" title="Restart docker.service" onDone={onDone} pollMs={10} />);
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Restart docker.service: Running" }).hasAttribute("aria-valuenow")).toBe(false);
    // It keeps reading while the job runs, and a running read changes nothing. Reads go one at a
    // time, so a second one starting means the first has been handled.
    const seen = reads;
    await vi.waitFor(() => expect(reads).toBeGreaterThan(seen + 1));
    expect(screen.getByRole("progressbar", { name: "Restart docker.service: Running" }).hasAttribute("aria-valuenow")).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    state = "completed";
    await vi.waitFor(() => expect(screen.getByText("Completed")).toBeTruthy());
    expect(screen.getByRole("progressbar", { name: "Restart docker.service: Completed" }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.queryByRole("progressbar", { name: "Restart docker.service: Running" })).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByText("41s")).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByText("started docker")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByLabelText("Output for Restart docker.service").textContent).toContain("stopping");
  });

  it("says so when the job has left the history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Job not found" }, 404)));
    render(<JobProgress jobId="gone" title="An old backup" />);
    expect(await screen.findByText("An old backup is no longer in the job history.")).toBeTruthy();
  });
});

describe("Table, sorted", () => {
  it("sorts by a column from its header and says which way with aria-sort", () => {
    const rows = [{ name: "sdb", temp: 38 }, { name: "nvme0n1", temp: 41 }, { name: "sda", temp: null }];
    render(<Table caption="Drives" rows={rows} rowKey={(row) => row.name} columns={[
      { id: "name", header: "Drive", sortValue: (row) => row.name, cell: (row) => row.name },
      { id: "temp", header: "Temp", numeric: true, sortValue: (row) => row.temp, cell: (row) => (row.temp === null ? "—" : `${row.temp}°C`) },
    ]} />);
    const names = () => screen.getAllByRole("row").slice(1).map((row) => row.firstChild?.textContent);
    expect(names()).toEqual(["sdb", "nvme0n1", "sda"]);
    fireEvent.click(screen.getByRole("button", { name: "Temp" }));
    expect(screen.getByRole("columnheader", { name: "Temp" }).getAttribute("aria-sort")).toBe("ascending");
    expect(names()).toEqual(["sdb", "nvme0n1", "sda"]);
    fireEvent.click(screen.getByRole("button", { name: "Temp" }));
    expect(names()).toEqual(["nvme0n1", "sdb", "sda"]);
    fireEvent.click(screen.getByRole("button", { name: "Drive" }));
    expect(names()).toEqual(["nvme0n1", "sda", "sdb"]);
    expect(screen.getByRole("columnheader", { name: "Temp" }).getAttribute("aria-sort")).toBe("none");
  });
});

