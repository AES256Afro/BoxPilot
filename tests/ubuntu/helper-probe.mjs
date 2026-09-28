/**
 * The main process of the helper unit in tests/ubuntu/helper-automount.sh: it runs inside the
 * helper's real sandbox (the deploy unit with only ExecStart= replaced) and does what it is asked
 * with BoxPilot's own backup code, so "the helper can write to the share" is shown by the helper's
 * sandbox and the helper's code, not by a shell outside them.
 *
 * Requests are files in /var/lib/boxpilot/probe: `<id>.request` holding `write <path>`, `inspect`
 * or `sync`; the answer lands in `<id>.response` as `ok: ...` or `failed: ...`, with the seconds it
 * took. Readiness is `ready` in the same folder.
 */
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMachineSnapshotHelper } from "../../server/machine-snapshot-helper.mjs";

const directory = "/var/lib/boxpilot/probe";
// The mirror destination the helper uses, from the unit's own Environment= lines.
const snapshots = createMachineSnapshotHelper({ controllerBackups: {} });

const actions = {
  async write(target) {
    await writeFile(target, "written from inside the helper sandbox\n");
    return `wrote ${target}`;
  },
  async inspect() {
    const { mount } = (await snapshots.inspect()).sync;
    return mount.mounted ? `mounted at ${mount.target}, ${mount.freeBytes} bytes free` : `unavailable: ${mount.blocker}`;
  },
  async sync() {
    const result = await snapshots.sync();
    return `synced ${result.copiedCount} of ${result.fileCount} files to ${result.destination}`;
  },
};

await writeFile(path.join(directory, "ready"), "ready\n");
for (;;) {
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".request"))) {
    const id = name.slice(0, -".request".length);
    const [action, argument] = (await readFile(path.join(directory, name), "utf8")).trim().split(/\s+/);
    await rm(path.join(directory, name), { force: true });
    const started = Date.now();
    let answer;
    try {
      if (!Object.hasOwn(actions, action)) throw new Error(`unknown action ${action}`);
      answer = `ok: ${await actions[action](argument)}`;
    } catch (error) {
      answer = `failed: ${error.message}`;
    }
    await writeFile(path.join(directory, `${id}.tmp`), `${answer} (${Math.round((Date.now() - started) / 1000)}s)\n`);
    await rename(path.join(directory, `${id}.tmp`), path.join(directory, `${id}.response`));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
