/**
 * The service's env file, read as systemd reads it. Every reader in BoxPilot (the System page's
 * update, the firewall's protected ports, the doctor, Settings' LAN switch) used to take the first
 * `^KEY=` line literally, so a file systemd starts the service on port 9000 could be read as 8787.
 */
import { describe, expect, it } from "vitest";
import { envFileValue, parseEnvFile, setEnvValue } from "./env-file.mjs";

describe("reading the service's env file", () => {
  it("takes the last line for a key, as systemd does", () => {
    // An override appended at the end of the file is what the service runs with.
    expect(envFileValue("BOXPILOT_PORT=8787\nNODE_ENV=production\nBOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBe("9000");
  });

  it("allows blanks before the key, around = and after the value", () => {
    expect(envFileValue("BOXPILOT_PORT = 9000\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("   BOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("\tBOXPILOT_PORT=\t9000 \t\n", "BOXPILOT_PORT")).toBe("9000");
  });

  it("drops carriage returns, skips blank lines and comments", () => {
    expect(envFileValue("\r\n\r\nBOXPILOT_HOST=0.0.0.0\r\nBOXPILOT_PORT=9000\r\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("\n\nBOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("BOXPILOT_PORT=9000\n# BOXPILOT_PORT=8000\n  ; BOXPILOT_PORT=7000\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("# BOXPILOT_PORT=8000\n", "BOXPILOT_PORT")).toBeUndefined();
  });

  it("strips one pair of matching quotes, and only a matching pair", () => {
    expect(envFileValue('BOXPILOT_PORT="9000"\n', "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("BOXPILOT_PORT='9000'\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue('BOXPILOT_PORT = "9000" \r\n', "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue('BOXPILOT_TOKEN=""quoted""\n', "BOXPILOT_TOKEN")).toBe('"quoted"');
    expect(envFileValue('BOXPILOT_NOTE="half\n', "BOXPILOT_NOTE")).toBe('"half');
    expect(envFileValue("BOXPILOT_NOTE=\"mixed'\n", "BOXPILOT_NOTE")).toBe("\"mixed'");
    expect(envFileValue('BOXPILOT_NOTE=" kept inside "\n', "BOXPILOT_NOTE")).toBe(" kept inside ");
  });

  it("matches the whole key, never a longer or commented one", () => {
    expect(envFileValue("BOXPILOT_PORT_TLS=9443\nXBOXPILOT_PORT=1\n", "BOXPILOT_PORT")).toBeUndefined();
    expect(envFileValue("", "BOXPILOT_PORT")).toBeUndefined();
    expect(envFileValue(undefined, "BOXPILOT_PORT")).toBeUndefined();
  });

  it("keeps an empty value as empty, and = inside a value", () => {
    expect(envFileValue("BOXPILOT_HOST=\n", "BOXPILOT_HOST")).toBe("");
    expect(envFileValue("BOXPILOT_URL=http://x/?a=b\n", "BOXPILOT_URL")).toBe("http://x/?a=b");
  });

  it("reads every key at once", () => {
    expect(Object.fromEntries(parseEnvFile("A=1\n B = 2 \r\nA=3\n#C=4\n"))).toEqual({ A: "3", B: "2" });
  });
});

describe("writing one key of the service's env file", () => {
  it("replaces or appends the key without disturbing the rest", () => {
    expect(setEnvValue("BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=8787\n", "BOXPILOT_HOST", "0.0.0.0")).toBe("BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\n");
    expect(setEnvValue("BOXPILOT_PORT=8787\n", "BOXPILOT_HOST", "0.0.0.0")).toBe("BOXPILOT_PORT=8787\nBOXPILOT_HOST=0.0.0.0\n");
    expect(setEnvValue("BOXPILOT_PORT=8787", "BOXPILOT_HOST", "0.0.0.0")).toBe("BOXPILOT_PORT=8787\nBOXPILOT_HOST=0.0.0.0\n");
    expect(setEnvValue("", "BOXPILOT_HOST", "127.0.0.1")).toBe("BOXPILOT_HOST=127.0.0.1\n");
  });

  // Replacing only the first of two lines changed nothing: systemd reads the last.
  it("rewrites every line for the key however it is written, so the new value is the one read", () => {
    const before = "  BOXPILOT_HOST = 127.0.0.1\nBOXPILOT_PORT=8787\nBOXPILOT_HOST=127.0.0.1\n# BOXPILOT_HOST=10.0.0.1\nBOXPILOT_HOST_EXTRA=1\n";
    const after = setEnvValue(before, "BOXPILOT_HOST", "0.0.0.0");
    expect(after).toBe("BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\nBOXPILOT_HOST=0.0.0.0\n# BOXPILOT_HOST=10.0.0.1\nBOXPILOT_HOST_EXTRA=1\n");
    expect(envFileValue(after, "BOXPILOT_HOST")).toBe("0.0.0.0");
  });

  it("keeps a CRLF file's line endings, and takes the value literally", () => {
    expect(setEnvValue("BOXPILOT_HOST=127.0.0.1\r\nBOXPILOT_PORT=8787\r\n", "BOXPILOT_HOST", "0.0.0.0")).toBe("BOXPILOT_HOST=0.0.0.0\r\nBOXPILOT_PORT=8787\r\n");
    expect(setEnvValue("BOXPILOT_TLS_KEY=old\n", "BOXPILOT_TLS_KEY", "/etc/boxpilot/tls/$&.key")).toBe("BOXPILOT_TLS_KEY=/etc/boxpilot/tls/$&.key\n");
  });

  it("refuses a key that is not a variable name", () => {
    expect(() => setEnvValue("", "BOXPILOT.*", "x")).toThrow(/not a variable name/);
  });
});
