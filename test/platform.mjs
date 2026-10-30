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

/**
 * Tests that need Linux itself, not merely "not Windows": root's home at `/root`, `/bin/true`,
 * ownership a chown actually changes, GNU coreutils in a shell script, an `fsync` whose ordering is
 * observable. Gate those with `it.skipIf(!onLinux)` (or `describe.skipIf(!onLinux)`), at the
 * narrowest level that works, next to a short comment naming what they need.
 *
 * `onWindows` stays for the many tests that only need a POSIX filesystem — symbolic links, modes,
 * `/mnt/...` resolving as itself — which macOS has and Windows does not. Those keep running on a
 * macOS checkout. Linux CI runs every test either way: both gates are open there.
 */
export const onLinux = process.platform === "linux";

/**
 * A real tar for tests that only need archives written and read, not Linux itself: `/usr/bin/tar`
 * on Linux, as the product runs it, and the tar Windows ships (bsdtar) on a Windows checkout, so a
 * local run exercises them too. Tests that depend on GNU tar's own behaviour stay gated.
 */
export const testTar = onWindows ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "/usr/bin/tar";
