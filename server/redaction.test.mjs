import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { finalRedaction } from "./assistant/prompt.mjs";
import { loadCatalog } from "./catalog/index.mjs";
import { createRedactor, loadRedactionPolicy, parseRedactionConfig, redactPrivateKeys, redactSecretBlocks } from "./redaction.mjs";

describe("support-bundle redaction policy", () => {
  it("loads only bounded literals and path prefixes without exposing configured values", async () => {
    const policy = await loadRedactionPolicy({ inspect: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 128, mode: 0o100640 })), read: vi.fn(async () => JSON.stringify({ additionalLiterals: ["private-owner"], additionalPathPrefixes: ["/srv/private"] })) });
    const redactor = createRedactor(policy);
    expect(redactor.metadata()).toMatchObject({ status: "loaded", additionalLiteralCount: 1, additionalPathPrefixCount: 1, configuredValuesIncluded: false });
    const output = redactor.redact({ message: "private-owner used /srv/private/app? token=abc", password: "secret", url: "https://example.test/path?token=abc" });
    expect(output).toEqual({ message: "[REDACTED_LITERAL] used [REDACTED_PATH]/app? token=[REDACTED]", password: "[REDACTED_FIELD]", url: "https://example.test/path?[query-redacted]" });
  });

  it("rejects arbitrary keys, regex syntax, oversized lists, and alternate config paths", async () => {
    expect(parseRedactionConfig('{"patterns":[".*"]}').status).toBe("invalid");
    expect(parseRedactionConfig(JSON.stringify({ additionalPathPrefixes: ["/srv/*"] })).status).toBe("invalid");
    expect(parseRedactionConfig(JSON.stringify({ additionalLiterals: Array.from({ length: 33 }, (_, index) => `item-${index}`) })).status).toBe("invalid");
    expect((await loadRedactionPolicy({ configPath: "/tmp/operator-selected.json", read: vi.fn() })).status).toBe("invalid-path");
    expect((await loadRedactionPolicy({ inspect: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 128, mode: 0o100640 })), read: vi.fn() })).status).toBe("invalid-file");
  });

  it("redacts bearer values, private keys, secret assignments, cycles, and depth", () => {
    const redactor = createRedactor();
    const cyclic = { message: "Authorization: Bearer abc.def", key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" };
    cyclic.self = cyclic;
    const output = redactor.redact(cyclic);
    expect(output.message).not.toContain("abc.def");
    expect(output.key).not.toContain("secret");
    expect(output.self).toBe("[REDACTED_CYCLE]");
  });
});

describe("shapes this product's own logs and configs actually produce", () => {
  const { redact } = createRedactor({ status: "default", additionalLiterals: [], additionalPathPrefixes: [] });

  it("redacts a credential however it is written", () => {
    // Every one of these was untouched: the rule needed the key bare and the value to stop at a
    // space, and these are BoxPilot's own webdav field, its cloud tokens, restic's unit
    // environment, an rclone config line, an rclone flag, and a webdav URL with credentials in it.
    for (const line of [
      '{"password":"hunter2"}',
      '{"access_token":"ya29.abc","refresh_token":"1//0gXYZ"}',
      "Environment=RESTIC_PASSWORD=hunter2-recovery-passphrase",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
      "secret_access_key = wJalrXUtnFEMI",
      "rclone: --sftp-pass 8fj20fj20fj2 --sftp-user backup",
      "https://alice:hunter2@cloud.example.com/dav",
    ]) {
      expect(redact(line), line).toContain("REDACTED");
      expect(redact(line), line).not.toMatch(/hunter2-recovery-passphrase|ya29\.abc|wJalrXUtnFEMI|8fj20fj20fj2/);
    }
  });

  it("redacts a secret field whatever its type, and leaves ordinary fields alone", () => {
    expect(redact({ apiKey: "abcd", key: "K001x", token: 12345678, pin: 1234 })).toEqual({
      apiKey: "[REDACTED_FIELD]", key: "[REDACTED_FIELD]", token: "[REDACTED_FIELD]", pin: 1234,
    });
    // "passed" is a real field in this codebase's own evidence; redacting it would hide whether a
    // restore drill succeeded. A boolean can never be a credential, so booleans are left alone
    // whatever they are called — which is what keeps flags like credentialsIncluded readable.
    expect(redact({ restoreDrill: { passed: true }, passes: 2, credentialsIncluded: false })).toEqual({
      restoreDrill: { passed: true }, passes: 2, credentialsIncluded: false,
    });
    // A session id is a credential, so it goes even though "sessionCount" goes with it.
    expect(redact({ sessionId: "abc", sessionCount: 3 })).toEqual({ sessionId: "[REDACTED_FIELD]", sessionCount: "[REDACTED_FIELD]" });
  });
});

/**
 * An obviously fake key, made here from random bytes in a key's shape: never a real one. Each body
 * line starts FAKE and its number, so a line that survives redaction is easy to name.
 */
function fakeKey(label = "PRIVATE KEY", lines = 25) {
  const body = Array.from({ length: lines }, (_, index) => `FAKE${String(index).padStart(2, "0")}${randomBytes(48).toString("base64")}`.slice(0, 64));
  return { text: `-----BEGIN ${label}-----\n${body.join("\n")}\n-----END ${label}-----`, body };
}
const survivors = (output, body) => body.filter((line) => output.includes(line) || output.includes(line.slice(6, 40)));

describe("private keys (sweep 3)", () => {
  const { redact } = createRedactor();

  it("redacts every kind of private key header, and leaves certificates and public keys alone", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      const key = fakeKey(label, 8);
      const output = redact(`before the key\n${key.text}\nafter the key`);
      expect(survivors(output, key.body), label).toEqual([]);
      expect(output, label).toBe("before the key\n[REDACTED_PRIVATE_KEY]\nafter the key");
    }
    const certificate = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUFAKE\n-----END CERTIFICATE-----\n-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIFAKE\n-----END PUBLIC KEY-----";
    expect(redact(certificate)).toBe(certificate);
  });

  it("redacts a key cut off before its END, from BEGIN to the end of the text", () => {
    const key = fakeKey("OPENSSH PRIVATE KEY", 20);
    const clipped = `ssh-keygen wrote:\n${key.text.slice(0, key.text.indexOf(key.body[12]) + 20)}…`;
    const output = redact(clipped);
    expect(survivors(output, key.body)).toEqual([]);
    expect(output).toBe("ssh-keygen wrote:\n[REDACTED_PRIVATE_KEY]");
  });

  it("redacts a key whose BEGIN was cut off the front, from the start of the text to its END", () => {
    const key = fakeKey("RSA PRIVATE KEY", 20);
    const tail = `${key.text.slice(key.text.indexOf(key.body[7]))}\nOct 05 12:00:01 app[42]: started`;
    const output = redact(tail);
    expect(survivors(output, key.body)).toEqual([]);
    expect(output).toBe("[REDACTED_PRIVATE_KEY]\nOct 05 12:00:01 app[42]: started");
  });

  it("redacts several keys and keeps the text between them", () => {
    const first = fakeKey("EC PRIVATE KEY", 4);
    const second = fakeKey("PRIVATE KEY", 4);
    expect(redactPrivateKeys(`a\n${first.text}\nb\n${second.text}\nc`)).toBe("a\n[REDACTED_PRIVATE_KEY]\nb\n[REDACTED_PRIVATE_KEY]\nc");
    expect(redactPrivateKeys("no keys here")).toBe("no keys here");
  });

  it("takes linear time over many unmatched markers", () => {
    const many = `${"-----END PRIVATE KEY----- x\n".repeat(20_000)}-----BEGIN PRIVATE KEY-----`;
    const started = performance.now();
    expect(redactPrivateKeys(many)).toBe("[REDACTED_PRIVATE_KEY] x\n[REDACTED_PRIVATE_KEY]");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("HTTP Basic credentials (sweep 3)", () => {
  const { redact } = createRedactor();
  // The Zulip bot's key travels as Basic auth, email:key in base64. A fake one, made here.
  const encoded = Buffer.from(`agents-bot@zulip.example.test:FAKE${randomBytes(16).toString("hex")}`).toString("base64");
  const short = Buffer.from("a:b").toString("base64");

  it("redacts the credential after Basic, however the header is written", () => {
    for (const line of [
      `Authorization: Basic ${encoded}`,
      `authorization: basic ${encoded}`,
      `Authorization=Basic ${encoded}`,
      `{"Authorization": "Basic ${encoded}"}`,
      `curl -H 'Authorization: Basic ${encoded}' http://127.0.0.1:8543/api/v1/messages`,
      `sent Basic ${encoded} to Zulip`,
      `Authorization: Basic ${short}`,
    ]) {
      const output = redact(line);
      expect(output, line).toContain("[REDACTED]");
      expect(output, line).not.toContain(encoded);
      if (line.includes(short)) expect(output, line).not.toContain(short);
    }
  });

  it("redacts a bearer credential in either form too", () => {
    for (const line of ["Authorization: Bearer FAKEtoken.abc", "Authorization=Bearer FAKEtoken.abc", "authorization: bearer FAKEtoken.abc"]) expect(redact(line), line).not.toContain("FAKEtoken");
  });

  it("leaves the word Basic in a sentence alone", () => {
    expect(redact("Basic authentication is on for the dashboard")).toBe("Basic authentication is on for the dashboard");
    expect(redact("Basic auth")).toBe("Basic auth");
  });
});

/** Fake values for the tables below, made here from random bytes: never real secrets. */
const fake = {
  word: () => `FAKE${randomBytes(9).toString("hex")}`,
  alnum: (length) => `FAKE${randomBytes(length).toString("base64").replace(/[^A-Za-z0-9]/g, "")}${randomBytes(length).toString("hex")}`.slice(0, length),
  upper: (length) => `FAKE${randomBytes(length).toString("hex").toUpperCase()}`.slice(0, length),
};
/** An Ed25519 public key in its real shape around 32 random bytes, as authorized_keys holds one. */
const sshPublicKey = () => `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString("base64")}`;

describe("a key's body without its BEGIN and END lines (sweep 4)", () => {
  const { redact } = createRedactor();
  const toModel = (text) => finalRedaction(text, createRedactor());
  // An obviously fake key body: random bytes, each line starting FAKE and its number. A line of random
  // base64 has four slashes about once in fifty and then reads like a path; past three here they are
  // plus signs, so the two-line EC case cannot draw two of those and fail once in a few thousand runs.
  const fewSlashes = (line) => { let seen = 0; return line.replace(/\//g, () => ((seen += 1) > 3 ? "+" : "/")); };
  const keyBody = (lines, width = 64) => Array.from({ length: lines }, (_, index) => fewSlashes(`FAKE${String(index).padStart(2, "0")}${randomBytes(60).toString("base64")}`.slice(0, width)));
  const leftOver = (output, lines) => lines.filter((line) => output.includes(line.slice(6, 28)));

  it("takes out a run of key-width base64 lines, bare or behind a journal or docker prefix", () => {
    for (const [name, prefix, width, count] of [
      ["bare PEM body", "", 64, 25],
      ["journal lines", "2026-10-05T09:00:01+0000 box certgen[311]: ", 64, 25],
      ["docker --timestamps lines", "2026-10-05T09:00:01.000000001Z ", 64, 25],
      ["OpenSSH body", "", 70, 6],
      ["EC key: two full lines and a short one", "", 64, 2],
    ]) {
      // ...and the short last line a real key ends with.
      const lines = [...keyBody(count, width), `FAKEzz${randomBytes(27).toString("base64")}`];
      const text = ["certgen: writing a key", ...lines.map((line) => `${prefix}${line}`), `${prefix}done`].join("\n");
      for (const output of [redactSecretBlocks(text), redact(text), toModel(text)]) {
        expect(leftOver(output, lines), name).toEqual([]);
        expect(output, name).toContain("[REDACTED_KEY_BODY]");
        expect(output.startsWith("certgen: writing a key\n"), name).toBe(true);
        expect(output.endsWith(`\n${prefix}done`), name).toBe(true);
      }
    }
    const lines = keyBody(25);
    expect(redactSecretBlocks(`before\n${lines.join("\n")}\nafter`)).toBe("before\n[REDACTED_KEY_BODY]\nafter");
    // One of an EC key's two full lines with a path's worth of slashes in it is still a key's.
    const ec = [`FAKE00${"Ab1/Cd2+".repeat(8)}`.slice(0, 64), keyBody(1)[0], `FAKEzz${randomBytes(27).toString("base64")}`];
    expect(redactSecretBlocks(`before\n${ec.join("\n")}\nafter`)).toBe("before\n[REDACTED_KEY_BODY]\nafter");
    expect(redactSecretBlocks(`before\r\n${lines.join("\r\n")}\r\nafter`)).toBe("before\r\n[REDACTED_KEY_BODY]\r\nafter");
  });

  it("takes out a body split across the final redaction's chunks", () => {
    const logs = Array.from({ length: 58 }, (_, index) => `2026-10-05T12:00:${String(index).padStart(2, "0")}Z app[42]: GET /health 200 in ${index} ms`).join("\n");
    const lines = keyBody(25);
    const output = toModel(`${logs}\n${lines.join("\n")}\nafter`);
    expect(leftOver(output, lines)).toEqual([]);
    expect(output).toBe(`${logs}\n[REDACTED_KEY_BODY]\nafter`);
  });

  it("leaves an ordinary journal and docker log alone, certificates and public keys included", () => {
    const certificate = Array.from({ length: 12 }, () => randomBytes(48).toString("base64"));
    const pgpPublic = Array.from({ length: 8 }, () => randomBytes(48).toString("base64"));
    const sample = [
      "2026-10-05T06:25:01+0000 box CRON[20211]: (root) CMD (test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; })",
      "2026-10-05T06:25:03+0000 box systemd[1]: Starting apt-daily-upgrade.service - Daily apt upgrade and clean activities...",
      "2026-10-05T06:25:09+0000 box systemd[1]: apt-daily-upgrade.service: Deactivated successfully.",
      "2026-10-05T06:31:44+0000 box sshd[20388]: Accepted publickey for owner from 192.0.2.10 port 51514 ssh2: ED25519 SHA256:Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE",
      "2026-10-05T06:31:44+0000 box sshd[20388]: pam_unix(sshd:session): session opened for user owner(uid=1000) by owner(uid=0)",
      "2026-10-05T06:40:12+0000 box kernel: [UFW BLOCK] IN=enp3s0 OUT= MAC=00:00:5e:00:53:01:00:00:5e:00:53:02:08:00 SRC=198.51.100.7 DST=192.0.2.2 LEN=40 TOS=0x00 PREC=0x00 TTL=242 ID=54321 PROTO=TCP SPT=40000 DPT=23 WINDOW=1024 RES=0x00 SYN URGP=0",
      `2026-10-05T06:41:00+0000 box dockerd[812]: time="2026-10-05T06:41:00.123456789Z" level=info msg="ignoring event" container=${randomBytes(32).toString("hex")} module=libcontainerd namespace=moby topic=/tasks/delete type="*events.TaskDelete"`,
      `2026-10-05T06:41:01+0000 box containerd[655]: time="2026-10-05T06:41:01Z" level=info msg="shim disconnected" id=${randomBytes(32).toString("hex")} namespace=moby`,
      "2026-10-05T06:41:02+0000 box boxpilot[1201]: job 3f2504e0-4f89-41d3-9a0c-0305e82c3301 finished: app.update jellyfin",
      `2026-10-05T06:41:02+0000 box boxpilot[1201]: pulled sha256:${randomBytes(32).toString("hex")}`,
      // `docker ps -q --no-trunc`, sha256 sums and image ids: key-width, but hex.
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"),
      `${randomBytes(32).toString("hex").toUpperCase()}`,
      `${randomBytes(32).toString("hex").toUpperCase()}`,
      `${randomBytes(32).toString("hex").toUpperCase()}`,
      // A backup listing paths that happen to be key-width and slash-and-letters only.
      "2026-10-05T03:00:12+0000 box restic[4410]: unchanged /srv/media/Photos/2024/Summer/Vacation2024/ItalyRomeColosseumNight",
      "2026-10-05T03:00:12+0000 box restic[4410]: unchanged /srv/media/Photos/2024/Summer/Vacation2024/ItalyRomeTreviFountainDay",
      "2026-10-05T03:00:12+0000 box restic[4410]: unchanged /srv/media/Photos/2024/Summer/Vacation2024/ItalyFlorenceDuomoSunset",
      "2026-10-05T03:00:13+0000 box restic[4410]: new       /home/owner/Documents/Projects/SomeVeryLongDirectoryName/Subfolder",
      "2026-10-05T03:00:13+0000 box restic[4410]: new       /home/owner/Documents/Projects/SomeVeryLongDirectoryName/Templates",
      "2026-10-05T03:00:13+0000 box restic[4410]: new       /home/owner/Documents/Projects/SomeVeryLongDirectoryName/Downloads",
      // authorized_keys: public keys, key-width and base64.
      sshPublicKey(),
      sshPublicKey(),
      sshPublicKey(),
      "-----BEGIN CERTIFICATE-----",
      ...certificate,
      "-----END CERTIFICATE-----",
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
      "Comment: a fake key for this test",
      "",
      ...pgpPublic,
      "=FAKE",
      "-----END PGP PUBLIC KEY BLOCK-----",
      "2026-10-05T06:50:00.000000001Z a2abf6c4d29d: Pull complete",
      `2026-10-05T06:50:00.000000001Z Digest: sha256:${randomBytes(32).toString("hex")}`,
      "2026-10-05T06:50:00.000000001Z Status: Downloaded newer image for nginx:1.27",
      '2026-10-05T06:52:00.000000001Z 192.0.2.10 - - [05/Oct/2026:06:52:00 +0000] "GET /health HTTP/1.1" 200 2 "-" "curl/8.5.0"',
      "2026-10-05T06:52:01.000000001Z [12:52:01] [INF] [1] Main: Startup complete 0:00:05.1234567",
      `2026-10-05T06:52:02.000000001Z inline image data:image/png;base64,${randomBytes(300).toString("base64")}`,
    ];
    // The paths really are key-width, or the case would prove nothing.
    for (const line of sample.filter((entry) => entry.includes("restic"))) expect(line.split(" ").at(-1).length, line).toBeGreaterThanOrEqual(60);
    const text = sample.join("\n");
    expect(redactSecretBlocks(text)).toBe(text);
    expect(toModel(text)).toBe(text);
    // A piece of text that starts inside a certificate: its BEGIN is in the piece before.
    const clipped = `${certificate.join("\n")}\n-----END CERTIFICATE-----\nnext`;
    expect(redactSecretBlocks(clipped)).toBe(clipped);
  });

  it("leaves two key-width lines alone when nothing shorter follows them", () => {
    const lines = keyBody(2);
    expect(redactSecretBlocks(`a\n${lines.join("\n")}\nb`)).toBe(`a\n${lines.join("\n")}\nb`);
  });
});

describe("more secret shapes (sweep 4)", () => {
  const { redact } = createRedactor();

  /** Every case: a line, and the fake secrets in it that must not come out the other side. */
  function secretCases() {
    const cases = [];
    const add = (name, make) => { const secret = fake.word(); cases.push({ name, line: make(secret), secrets: [secret] }); };
    const addWith = (name, line, secrets) => cases.push({ name, line, secrets });

    // Credentials in a URL, whatever its scheme.
    add("postgres URL", (s) => `DATABASE_URL=postgres://paperless:${s}@db.example.test:5432/paperless`);
    add("postgresql URL", (s) => `postgresql://app:${s}@127.0.0.1/app?sslmode=disable`);
    add("mysql URL", (s) => `connecting to mysql://root:${s}@mariadb:3306/wordpress`);
    add("mongodb+srv URL", (s) => `mongodb+srv://admin:${s}@cluster0.example.test/test?retryWrites=true&w=majority`);
    add("redis URL", (s) => `redis://default:${s}@redis:6379/0`);
    add("redis URL with no user", (s) => `REDIS_URL=redis://:${s}@redis:6379`);
    add("amqp URL", (s) => `amqp://guest:${s}@rabbitmq:5672/`);
    add("https URL", (s) => `https://alice:${s}@cloud.example.test/dav`);
    add("a password with an @ in it", (s) => `postgres://app:p@ss${s}@db/app`);

    // The catalog's own secret settings, and names like them.
    for (const name of ["APP_KEY", "DB_PASS", "MONGO_PASS", "ENCRYPTION_KEY", "WIREGUARD_PRIVATE_KEY", "VIKUNJA_SERVICE_JWTSECRET", "SERVERPASSWORD", "PLEX_CLAIM", "WEBPASSWORD", "MEILI_MASTER_KEY", "NZBGET_PASS", "PASS", "LICENSE_KEY"]) add(`${name}=`, (s) => `${name}=${s}`);
    add("APP_KEY in compose YAML", (s) => `      APP_KEY: base64:${s}`);
    add("PLEX_CLAIM in a compose list", (s) => `  - PLEX_CLAIM=claim-${s}`);
    add("WEBPASSWORD in JSON", (s) => `{"WEBPASSWORD":"${s}"}`);
    add("a lower-case private_key in a config", (s) => `private_key: ${s}`);
    add("a lower-case db_pass", (s) => `db_pass = ${s}`);

    // Azure connection strings.
    add("Azure storage AccountKey", (s) => `DefaultEndpointsProtocol=https;AccountName=fakestore;AccountKey=${s}+abc/def==;EndpointSuffix=core.windows.net`);
    add("Azure Service Bus SharedAccessKey", (s) => `Endpoint=sb://fake.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${s}=`);

    // A bare JWT.
    const payload = Buffer.from(JSON.stringify({ sub: fake.word(), name: "fake" })).toString("base64url");
    const signature = fake.alnum(43);
    addWith("bare JWT", `issued ${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${payload}.${signature} for owner`, [payload, signature]);

    // Tokens known by their prefix.
    for (const prefix of ["ghp_", "gho_", "ghs_"]) { const tail = fake.alnum(36); addWith(`${prefix} token`, `remote: https://github.com/owner/repo using ${prefix}${tail}`, [tail]); }
    { const tail = `${fake.alnum(22)}_${fake.alnum(59)}`; addWith("github_pat_ token", `GH=github_pat_${tail}`, [tail]); }
    for (const prefix of ["xoxb-", "xoxp-"]) { const tail = fake.alnum(24); addWith(`${prefix} token`, `slack: ${prefix}123456789012-1234567890123-${tail}`, [tail]); }
    { const tail = `${fake.alnum(11)}CNTRL-${fake.alnum(33)}`; addWith("tskey- auth key", `tailscaled[901]: logging in with tskey-auth-${tail} as box`, [tail]); }
    for (const prefix of ["AKIA", "ASIA"]) { const id = fake.upper(16); addWith(`${prefix} access key id`, `aws configure set aws_access_key_id ${prefix}${id}`, [id]); }

    // A PuTTY key's private lines, RSA and Ed25519.
    const rsaPrivate = [...Array.from({ length: 14 }, () => `FAKE${randomBytes(45).toString("base64")}`), `FAKE${randomBytes(12).toString("base64")}`];
    addWith("PuTTY RSA key", ["PuTTY-User-Key-File-3: ssh-rsa", "Encryption: none", "Comment: fake-key-for-tests", "Public-Lines: 1", "AAAAB3NzaC1yc2EAAAADAQABAAABAQ", `Private-Lines: ${rsaPrivate.length}`, ...rsaPrivate, `Private-MAC: ${randomBytes(32).toString("hex")}`].join("\n"), rsaPrivate.map((line) => line.slice(4, 30)));
    const edPrivate = `FAKE${randomBytes(30).toString("base64")}`;
    addWith("PuTTY Ed25519 key", ["PuTTY-User-Key-File-2: ssh-ed25519", "Encryption: none", "Comment: fake-key-for-tests", "Public-Lines: 2", "AAAAC3NzaC1lZDI1NTE5AAAAIFAKE", "FAKEpublic", "Private-Lines: 1", edPrivate, `Private-MAC: ${randomBytes(20).toString("hex")}`].join("\r\n"), [edPrivate]);

    // A PEM key wrapped in base64 again, as kubeconfig and Kubernetes secrets carry one.
    const wrapped = () => Buffer.from(`-----BEGIN RSA PRIVATE KEY-----\nFAKE${randomBytes(90).toString("base64")}\n-----END RSA PRIVATE KEY-----\n`).toString("base64");
    { const value = wrapped(); addWith("kubeconfig client-key-data", `    client-key-data: ${value}`, [value.slice(40, 100)]); }
    { const value = wrapped(); addWith("Kubernetes tls.key", `  tls.key: ${value}`, [value.slice(40, 100)]); }
    { const value = wrapped(); addWith("tls.key in JSON", `{"data":{"tls.key":"${value}"}}`, [value.slice(40, 100)]); }
    { const value = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), randomBytes(32)]).toString("base64"); addWith("an Ed25519 key on one line", `seed ${value}`, [value.slice(24)]); }

    // YAML block scalars under a secret's name.
    { const [one, two] = [fake.word(), fake.word()]; addWith("password: |", `stringData:\n  password: |\n    ${one}\n    ${two}\n  username: admin`, [one, two]); }
    add("secret: >-", (s) => `secret: >-\n  ${s}\n  more\nnext: value`);
    add("- WEBPASSWORD: |", (s) => `- WEBPASSWORD: |\n    ${s}`);
    add("private_key: |", (s) => `wireguard:\n  private_key: |\r\n    ${s}\r\n  port: 51820`);

    // What already worked, so it keeps working.
    add("Bearer", (s) => `Authorization: Bearer ${s}`);
    { const value = Buffer.from(`bot@example.test:${fake.word()}`).toString("base64"); addWith("Basic", `Authorization: Basic ${value}`, [value]); }
    add("a JSON-escaped key", (s) => `{"private_key":"-----BEGIN PRIVATE KEY-----\\n${s}\\n-----END PRIVATE KEY-----\\n"}`);
    add("AWS secret key line", (s) => `aws_secret_access_key = ${s}`);
    add("AWS secret key env", (s) => `AWS_SECRET_ACCESS_KEY=${s}`);
    add("--token flag", (s) => `cloudflared tunnel run --token ${s}`);
    return cases;
  }

  it("redacts every case", () => {
    const missed = [];
    for (const { name, line, secrets } of secretCases()) {
      for (const output of [redact(line), finalRedaction(line, createRedactor())]) {
        if (secrets.some((secret) => output.includes(secret)) || !output.includes("REDACTED")) { missed.push(name); break; }
      }
    }
    expect(missed).toEqual([]);
  });

  it("keeps what is not the secret: the URL's user and host, the token's kind, the YAML around the block", () => {
    expect(redact("postgres://paperless:FAKEpw@db.example.test:5432/paperless")).toBe("postgres://paperless:[REDACTED]@db.example.test:5432/paperless");
    expect(redact("redis://:FAKEpw@redis:6379")).toBe("redis://:[REDACTED]@redis:6379");
    expect(redact(`using ghp_${"F".repeat(36)}`)).toBe("using ghp_[REDACTED]");
    expect(redact("stringData:\n  password: |\n    FAKEone\n    FAKEtwo\n  username: admin")).toBe("stringData:\n  password=[REDACTED]\n    [REDACTED]\n  username: admin");
    expect(redact("PuTTY-User-Key-File-3: ssh-ed25519\nPublic-Lines: 1\nAAAAC3NzaC1lZDI1NTE5AAAAIFAKE\nPrivate-Lines: 1\nFAKEprivatelineFAKEprivateline\nPrivate-MAC: 00ff")).toBe("PuTTY-User-Key-File-3: ssh-ed25519\nPublic-Lines: 1\nAAAAC3NzaC1lZDI1NTE5AAAAIFAKE\nPrivate-Lines: 1\n[REDACTED_PRIVATE_KEY]\nPrivate-MAC: 00ff");
  });

  it("redacts every secret setting the catalog declares, written the ways configs and logs write it", async () => {
    const { manifests } = await loadCatalog();
    const names = [...new Set(manifests.flatMap((manifest) => (manifest.env ?? []).filter((entry) => entry.secret || entry.type === "password").map((entry) => entry.name)))];
    expect(names.length).toBeGreaterThan(50);
    const shapes = [(name, value) => `${name}=${value}`, (name, value) => `${name}: ${value}`, (name, value) => `  - ${name}=${value}`, (name, value) => `{"${name}":"${value}"}`, (name, value) => `Environment=${name}=${value}`, (name, value) => `export ${name}='${value}'`];
    const missed = [];
    for (const name of names) for (const shape of shapes) {
      const value = fake.word();
      if (redact(shape(name, value)).includes(value)) missed.push(shape(name, "…"));
    }
    expect(missed).toEqual([]);
  });

  it("leaves ordinary lines alone", () => {
    const certificateData = Buffer.from(`-----BEGIN CERTIFICATE-----\nMIIB${randomBytes(60).toString("base64")}\n-----END CERTIFICATE-----\n`).toString("base64");
    for (const line of [
      "2026-10-05T06:25:03+0000 box systemd[1]: Starting apt-daily-upgrade.service - Daily apt upgrade and clean activities...",
      '2026-10-05T06:41:00+0000 box dockerd[812]: level=info msg="pulled image" image=nginx:1.27 digest=sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      "the monkey sat on the keyboard",
      "MONKEY=banana",
      "KEYBOARD=us",
      "keyboard: us",
      "XKBLAYOUT=us",
      "passage: the passage of time",
      "COMPASS=north",
      "BYPASS=1",
      "TOKENIZER=bert-base-uncased",
      "cache_key=user:42",
      "sort_key: name",
      "Pass: 12 of 12 checks",
      "test_backup_restore PASSED",
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /srv/backups/db.sql",
      "job 3f2504e0-4f89-41d3-9a0c-0305e82c3301 finished",
      "container 5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef exited with code 0",
      "a2abf6c4d29d: Pull complete",
      "https://example.test/dav",
      "https://example.test/users/@owner",
      "postgres://db.example.test:5432/paperless",
      "redis://redis:6379/0",
      "mongodb+srv://cluster0.example.test/test",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "mailto:owner@example.test",
      "http://[::1]:8080/health",
      "owner@example.test signed in",
      "tokens from GitHub start with ghp_",
      "AKIA is how an AWS access key id starts",
      "eyJ is how a JWT starts",
      "Public-Lines: 2",
      "description: |\n  A media server.\n  It streams.",
      "Basic authentication is on for the dashboard",
      `client-certificate-data: ${certificateData}`,
      sshPublicKey(),
    ]) expect(redact(line), line).toBe(line);
  });

  it("stays quick on long runs of names and separators", () => {
    const started = performance.now();
    for (const text of ["a_".repeat(2_000), `${"x".repeat(4_000)}=1`, "A_".repeat(2_000), `${"ab1".repeat(1_300)}\n`.repeat(3), "pass_".repeat(800)]) redact(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
