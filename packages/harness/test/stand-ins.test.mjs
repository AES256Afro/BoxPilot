// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStandIns, hideRequest, showResult } from "../src/safety/stand-ins.mjs";

/*
 * Stand-ins for what identifies a house (M45.3): replaced the same way every time in a run, turned
 * back in the answer, never confused with a real value, and never touching a provider's own blocks.
 */

const house = () => createStandIns({ hosts: ["nas-attic", "homebox"], domains: ["homebox.tail1234.ts.net", "photos.example-family.org"], users: ["jamie", "admin"] });

describe("stand-ins", () => {
  it("replace host names, domains, accounts, private addresses and MACs, the same way every time", () => {
    const standIns = house();
    const hidden = standIns.hide("jamie's homebox (192.168.1.20, aa:bb:cc:dd:ee:01) mounts nas-attic over 10.0.0.5; see https://homebox.tail1234.ts.net and photos.example-family.org");
    expect(hidden).toBe("user-1's host-1 (192.0.2.1, 02:00:00:00:00:00) mounts host-2 over 192.0.2.2; see https://site-1.example and site-2.example");
    expect(standIns.hide("homebox at 192.168.1.20 again")).toBe("host-1 at 192.0.2.1 again");
    expect(standIns.counts()).toEqual({ host: 2, site: 2, user: 1, address: 2, mac: 1 });
  });

  it("replaces a house's local names whole, by their shape", () => {
    const standIns = createStandIns({ hosts: ["homebox"] });
    expect(standIns.hide("homebox.tail9f2c.ts.net, printer.local, router.lan, nas.home.arpa and db.internal; homebox itself")).toBe("site-1.example, site-2.example, site-3.example, site-4.example and site-5.example; host-1 itself");
    expect(standIns.show("site-1.example and host-1")).toBe("homebox.tail9f2c.ts.net and homebox");
  });

  it("leaves public addresses, common account names and words that only contain a name alone", () => {
    const standIns = house();
    expect(standIns.hide("admin pulled from 8.8.8.8 and 172.32.0.1; homeboxes and nas-attic2 are other things; version 10.0.0.1.5")).toBe("admin pulled from 8.8.8.8 and 172.32.0.1; homeboxes and nas-attic2 are other things; version 10.0.0.1.5");
  });

  it("turns the answer back, and only what it handed out", () => {
    const standIns = house();
    standIns.hide("homebox at 192.168.1.20");
    expect(standIns.show("host-1 (192.0.2.1) is fine; host-9 and 192.0.2.77 are not ours")).toBe("homebox (192.168.1.20) is fine; host-9 and 192.0.2.77 are not ours");
  });

  it("hides a request's words and arguments, leaves a provider's blocks, and shows a result's", () => {
    const standIns = house();
    const blocks = { provider: "anthropic", model: "claude-opus-5-5", blocks: [{ type: "text", text: "host-1 holds it" }] };
    const request = {
      model: "claude-opus-5-5",
      messages: [
        { role: "system", content: "You look after homebox." },
        { role: "user", content: [{ type: "text", text: "Is nas-attic up?" }] },
        { role: "assistant", content: "Checking nas-attic.", tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{\"host\":\"nas-attic\"}" } }], providerBlocks: blocks },
        { role: "tool", tool_call_id: "t1", content: "nas-attic answered from 192.168.1.30" },
      ],
    };
    const hidden = hideRequest(request, standIns);
    expect(hidden.messages.map((message) => message.content)).toEqual(["You look after host-1.", [{ type: "text", text: "Is host-2 up?" }], "Checking host-2.", "host-2 answered from 192.0.2.1"]);
    expect(hidden.messages[2].tool_calls[0].function.arguments).toBe("{\"host\":\"host-2\"}");
    expect(hidden.messages[2].providerBlocks).toBe(blocks);
    expect(request.messages[0].content).toBe("You look after homebox.");
    const shown = showResult({ content: "host-2 is up at 192.0.2.1", toolCalls: [{ id: "t2", name: "ping", arguments: "{\"host\":\"host-1\"}" }] }, standIns);
    expect(shown).toEqual({ content: "nas-attic is up at 192.168.1.30", toolCalls: [{ id: "t2", name: "ping", arguments: "{\"host\":\"homebox\"}" }] });
  });
});
