# Interrupted package recovery

Repair Center offers **Check package recovery** for installs or updates that stopped partway through. This is a manual check, available to operators and the owner. Opening Repair Center does not run another package scan.

The check reads actual kernel lock ownership for the four standard APT/dpkg lock files, runs `dpkg --audit`, and simulates dependency repair. Existing unlocked files are normal. Missing or unreadable evidence is shown as unknown. If an updater owns a lock, BoxPilot asks the operator to let it finish and check again.

**Review package repair** uses the existing medium-risk approval and generic task runner. It repeats the diagnosis immediately before executing, finishes pending configuration with `dpkg --configure -a`, runs dependency repair with `apt-get install --fix-broken --yes --no-remove`, and verifies the final state using a new audit and simulation. A healthy state is a no-op. A command that exits successfully does not by itself count as verified recovery.

APT enforces its own locks at execution time. The inspection is a snapshot, not a reservation. BoxPilot does not delete locks, kill package managers, remove packages through this repair, or refresh repositories as part of diagnosis. The dependency simulation appears under Package check details. When dpkg interruption prevents simulation, positive audit evidence can still offer configuration recovery; the execution-time no-remove guard remains in force.

Package configuration scripts may restart services. Both repair commands suppress needrestart's automatic hook, matching BoxPilot's existing package-management policy. Review running-library checks in Updates afterward. A package repair does not automatically reboot the host.

The `apt.health.inspect` read and `apt.repair` mutation are registry operations. Results and verification use existing jobs. Diagnostic text is bounded and uses the shared secret redactor. Kernel locks are matched by device and inode, with no process argument or environment reads.

Local validation includes locked, unknown, healthy, pending, malformed and failed-verification cases; exact command arguments; permission checks in the registry; and manual-only UI behavior. A live Linux read-only check passed with healthy package state. A disposable Ubuntu 24.04 Docker test passed: it deliberately left a fixture package half-configured, detected and repaired it, verified a clean audit, confirmed an idempotent repeat, refused a real kernel-held lock, and verified cleanup. The test container has no network during execution and mounts the checkout read-only. The same test is wired into CI.

References: [dpkg audit and configuration](https://manpages.debian.org/trixie/dpkg/dpkg.1.en.html), [APT simulation and no-remove](https://manpages.debian.org/trixie/apt/apt-get.8.en.html), [kernel lock records](https://man7.org/linux/man-pages/man5/proc_locks.5.html).
