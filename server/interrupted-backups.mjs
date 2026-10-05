/**
 * Backups a power cut or a restart cut off, put right when the helper starts: the half-written
 * archive removed, and an app the backup had stopped started again (app-helper's
 * interruptedBackups and resumeInterruptedBackup).
 *
 * Docker may not be up yet at boot, and after a power cut it may not come up at all until the owner
 * starts it. The wait for it used to happen inside the app's lane: 40 tries of `compose start`, 15
 * seconds apart, each up to three minutes. The Docker lane waits for every app lane, so starting
 * docker.service from Services, a package repair or installing Docker queued behind that wait for
 * ten minutes, and up to two hours. Now Docker is waited for here, outside any lane, and the app's
 * lane is held only for the start itself, so nothing else reaches the app at that moment.
 */
export function resumeInterruptedBackups(entries, { apps, lanes, log = (line, level) => (level === "error" ? console.error(line) : console.log(line)) }) {
  return Promise.all((entries ?? []).map(async (entry) => {
    try {
      if (entry.restart) await apps.waitForDocker();
      const outcome = await lanes.run([`app:${entry.id}`], () => apps.resumeInterruptedBackup(entry));
      if (outcome.restarted) log(`Started ${entry.id} again: a backup begun at ${entry.startedAt ?? "an unknown time"} had stopped it and was cut off`);
      else if (outcome.error) log(`${entry.id} was stopped by a backup that was cut off, and could not be started again: ${outcome.error}`, "error");
      if (outcome.removedPartial) log(`Removed the unfinished backup archive ${entry.partial} of ${entry.id}`);
      return outcome;
    } catch (error) {
      log(`Recovering ${entry.id} after an interrupted backup failed: ${error.message}`, "error");
      return { id: entry.id, error: error.message };
    }
  }));
}
