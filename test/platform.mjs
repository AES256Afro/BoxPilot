/**
 * Platform gating for tests that exercise the Linux host directly.
 *
 * BoxPilot runs on Ubuntu, and some tests need the real thing: POSIX file modes and ownership,
 * `/bin/sh` and `/usr/bin/tar`, POSIX paths such as `/mnt/...` resolving as themselves, symbolic
 * links an unprivileged user may create, or `fsync` on a read-only handle. On a Windows checkout
 * those tests are skipped with `it.skipIf(onWindows)` or `describe.skipIf(onWindows)`, at the
 * narrowest level that works, next to a short comment naming what they need. Linux CI runs every
 * one of them: `onWindows` is false there.
 */
export const onWindows = process.platform === "win32";
