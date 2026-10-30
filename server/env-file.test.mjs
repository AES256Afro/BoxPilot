/**
 * The service's env file, read as systemd reads it. Every reader in BoxPilot (the System page's
 * update, the firewall's protected ports, the doctor, Settings' LAN switch) used to take the first
 * `^KEY=` line literally, so a file systemd starts the service on port 9000 could be read as 8787.
 */
import { describe, expect, it } from "vitest";
import { envFileValue, parseEnvFile, setEnvValue, webHostOf, webListenFromEnv, webPortOf } from "./env-file.mjs";

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

  it("takes quotes off as systemd does", () => {
    expect(envFileValue('BOXPILOT_PORT="9000"\n', "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("BOXPILOT_PORT='9000'\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue('BOXPILOT_PORT = "9000" \r\n', "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue('BOXPILOT_NOTE=" kept inside "\n', "BOXPILOT_NOTE")).toBe(" kept inside ");
    // A quote only opens at the start of the value; after that it is an ordinary character.
    expect(envFileValue('BOXPILOT_TOKEN=""quoted""\n', "BOXPILOT_TOKEN")).toBe('quoted""');
    expect(envFileValue('BOXPILOT_NOTE=say "hi"\n', "BOXPILOT_NOTE")).toBe('say "hi"');
    // Quoted pieces and what follows them run together, blanks between them dropped.
    expect(envFileValue("BOXPILOT_NOTE='a'\"b\" c\n", "BOXPILOT_NOTE")).toBe("abc");
    // Inside double quotes, \ escapes " \ ` and $ and is kept before anything else; single quotes keep all.
    expect(envFileValue('BOXPILOT_NOTE="a\\"b\\$c\\\\d\\e"\n', "BOXPILOT_NOTE")).toBe('a"b$c\\d\\e');
    expect(envFileValue("BOXPILOT_NOTE='a\\\"b'\n", "BOXPILOT_NOTE")).toBe('a\\"b');
  });

  // EnvironmentFile= has no inline comments: a # after the value is part of it. The service takes
  // the port with parseInt, so `9000   # moved off 8787` still listens on 9000; every reader that
  // used the raw value built a URL out of the comment.
  it("keeps what follows the value on its line, comment or not", () => {
    expect(envFileValue("BOXPILOT_PORT=9000   # moved off 8787\n", "BOXPILOT_PORT")).toBe("9000   # moved off 8787");
    expect(envFileValue("BOXPILOT_URL=http://x/#frag ; y \n", "BOXPILOT_URL")).toBe("http://x/#frag ; y");
    // Quoted, the closing quote does not end it: systemd gives `9000# web`, and the service 9000.
    expect(envFileValue('BOXPILOT_PORT="9000" # web\n', "BOXPILOT_PORT")).toBe("9000# web");
    expect(envFileValue("BOXPILOT_PORT='9000'   ; web\n", "BOXPILOT_PORT")).toBe("9000; web");
    expect(webListenFromEnv('BOXPILOT_PORT="9000" # web\n').webPort).toBe(9000);
    expect(webListenFromEnv("BOXPILOT_PORT=9000   # moved off 8787\n").webPort).toBe(9000);
  });

  it("lets a quote run over lines, so one left open takes the rest of the file", () => {
    expect(envFileValue('BOXPILOT_NOTE="two\nlines"\n', "BOXPILOT_NOTE")).toBe("two\nlines");
    const open = 'BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT="9000\nBOXPILOT_HOST=127.0.0.1\n';
    expect(envFileValue(open, "BOXPILOT_PORT")).toBe("9000\nBOXPILOT_HOST=127.0.0.1\n");
    expect(envFileValue(open, "BOXPILOT_HOST")).toBe("0.0.0.0");
    expect(webListenFromEnv(open)).toEqual({ webPort: 9000, webHost: "0.0.0.0" });
    expect(envFileValue("BOXPILOT_NOTE=\"mixed'\n", "BOXPILOT_NOTE")).toBe("mixed'\n");
  });

  it("joins a line ending in a backslash to the next, and a backslash keeps the next character", () => {
    expect(envFileValue("BOXPILOT_PORT=90\\\n00\n", "BOXPILOT_PORT")).toBe("9000");
    expect(envFileValue("BOXPILOT_NOTE=a\\ \\#b\\\\ \n", "BOXPILOT_NOTE")).toBe("a #b\\");
    // A comment ending in a backslash does not swallow the next line (systemd 254 and later).
    expect(envFileValue("# old \\\nBOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBe("9000");
  });

  it("ends a line at a lone carriage return too", () => {
    expect(Object.fromEntries(parseEnvFile("BOXPILOT_HOST=0.0.0.0\rBOXPILOT_PORT=9000"))).toEqual({ BOXPILOT_HOST: "0.0.0.0", BOXPILOT_PORT: "9000" });
  });

  it("ignores a line whose name is not a variable name: export, blanks inside, no =", () => {
    expect(envFileValue("export BOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBeUndefined();
    expect(envFileValue("BOXPILOT_PORT=8787\nexport BOXPILOT_PORT=9000\n", "BOXPILOT_PORT")).toBe("8787");
    expect(Object.fromEntries(parseEnvFile("BOXPILOT PORT=1\n9X=2\n=3\nBOXPILOT_PORT\nA-B=4\n"))).toEqual({});
    expect(envFileValue("BOXPILOT_PORT \t= 9000\n", "BOXPILOT_PORT")).toBe("9000");
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

// server/index.mjs listens where these say, and every reader of the env file takes the same answer.
describe("the port and address the web service takes", () => {
  it("takes the port as parseInt does, and 8787 when that is not a port", () => {
    expect(webPortOf("9000")).toBe(9000);
    expect(webPortOf("9000   # moved off 8787")).toBe(9000);
    expect(webPortOf("9000# web")).toBe(9000);
    expect(webPortOf(" \n09000x")).toBe(9000);
    expect(webPortOf("+9000")).toBe(9000);
    for (const unusable of [undefined, "", "abc", "0", "-9000", "65536", "# 9000"]) expect(webPortOf(unusable), unusable).toBe(8787);
  });

  // An empty BOXPILOT_HOST used to make the service listen on every address (listen(port, "")),
  // while every reader said loopback: the firewall advice never warned about the LAN.
  it("listens on loopback when the address is missing or empty", () => {
    expect(webHostOf(undefined)).toBe("127.0.0.1");
    expect(webHostOf("")).toBe("127.0.0.1");
    expect(webHostOf("0.0.0.0")).toBe("0.0.0.0");
    expect(webHostOf("::")).toBe("::");
    expect(webListenFromEnv("BOXPILOT_HOST=\nBOXPILOT_PORT=\n")).toEqual({ webPort: 8787, webHost: "127.0.0.1" });
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
