# The libvirt foundation unit died before its script ran: triage, prevention, remediation

Written 2026-10-22, after the cause was found and fixed in pull request #564. Host details are
placeholders, as `AGENTS.md` requires; the private copy of the journal is in the operator's notes.

## What happened

The owner approved **Default VM foundation** in Virtual Machines. The helper wrote the five-minute
approval marker and started `boxpilot-libvirt-foundation.service`. The unit failed at once with
`Result: core-dump`, the helper cleared the marker, and the browser reported that the service "failed
and requested automatic rollback". Nothing had been rolled back, because nothing had run: the main
process, `/usr/local/bin/node`, died 140 ms after start, before `scripts/boxpilot-libvirt-foundation.mjs`
executed a line. A second start an hour later was skipped by systemd itself, since the marker that
`ConditionPathExists=` checks was gone.

The journal held the whole story:

```
node[…]: # Fatal error in , line 0
node[…]: # Check failed: 12 == (*__errno_location ()).
node[…]:  3: v8::base::OS::SetPermissions(void*, unsigned long, v8::base::OS::MemoryPermission)
node[…]:  8: v8::Isolate::Initialize(v8::Isolate*, v8::Isolate::CreateParams const&)
node[…]:  9: node::NewIsolate(...)
kernel: traps: MainThread[…] trap int3 ip:… in node[…]
systemd[1]: boxpilot-libvirt-foundation.service: Main process exited, code=dumped, status=5/TRAP
systemd[1]: boxpilot-libvirt-foundation.service: Failed with result 'core-dump'.
```

## Cause

The unit carried `MemoryDenyWriteExecute=true`. That directive installs a seccomp filter that refuses
every `mprotect()` which adds `PROT_EXEC`, returning `EPERM`. V8 writes its JIT code at start-up and
then flips the pages executable with exactly that call; it tolerates only `ENOMEM` (12) as a failure,
so `EPERM` trips a fatal check inside isolate setup, V8 executes `int3`, the kernel delivers `SIGTRAP`,
and systemd classifies the signal as `core-dump`. Of the thirteen units in `deploy/` that run node, this
was the only one with the directive; every other directive it carries also appears in a node unit that
runs on the same host without trouble. `systemd.exec(5)` says the directive is incompatible with
programs that generate code at runtime and names JIT engines.

The installed unit was byte-identical to the shipped one, with no drop-ins, so the fault was in the
repository, not on the host. Transient units on the host proved it both ways: the same node binary
under `-p MemoryDenyWriteExecute=true` ended in `core-dump`, `status=5/TRAP`; without it, success.

## The second blocker

With the unit able to run, the job would still have failed at its first step. `virsh net-start default` on the
host ends in `dnsmasq: failed to create listening socket for 192.168.122.1: Address already in use`:
the Pi-hole app, installed through BoxPilot in host network mode, holds port 53 on every address, and
`catalog/pi-hole.yaml` fixes its listening mode to `all`, so it cannot be narrowed from the app page. The
host and the tailnet do not resolve through it; the LAN does. The network was started by keeping its
DHCP and switching its own DNS off (`<dns enable='no'/>` with a `dhcp-option=6,<LAN resolver>` through
the `dnsmasq:options` namespace), which leaves the subnet, bridge and range the foundation check
expects. The previous definition is kept beside the new one in the operator's home directory.

## Triage path for a unit that fails

Each step answers one question. Stop as soon as the answer names the cause.

0. **Is the host actually down?** `tailscale status` on your own machine first, then the host's LAN
   address. An operator's stopped Tailscale looks exactly like a dead server. A kernel message on the
   console about a USB drive or a disk cache is not evidence about the network.
1. **Exit or signal?** `systemctl status <unit> --no-pager`. `code=exited, status=N` is the script
   speaking. `code=dumped, signal=TRAP|ABRT|SEGV|SYS` (`Result: core-dump`) is the process dying, and
   the script may never have run. `signal=SYS` points straight at `SystemCallFilter=`.
2. **The process's last words.** `journalctl -u <unit> -b --no-pager -o short-precise`. A V8
   `Fatal error` / `Check failed` with `SetPermissions` or `CodeRange` in the trace is the runtime
   colliding with the sandbox, not a bug in the script. `journalctl -k` adds the kernel's `traps:` or
   `segfault` line with the faulting address.
3. **What systemd actually loaded.** `systemctl show <unit> -p Result -p ExecMainCode -p ExecMainStatus
   -p FragmentPath -p DropInPaths` plus the suspect directive (`-p MemoryDenyWriteExecute`, `-p
   SystemCallFilter`). Then `diff /opt/boxpilot/deploy/<unit> /etc/systemd/system/<unit>`: an installed
   unit that differs from the shipped one, or a drop-in, moves the fault to the host.
4. **The odd one out.** List the hardening directives of every unit that runs the same binary. A
   directive that only the failing unit carries is the first suspect; a runtime that works under the
   others' directives has already been proven on this host.
5. **Reproduce without installing anything.** `systemd-run --user --wait --pipe --collect -p
   <Directive>=<value> /usr/local/bin/node -e 'console.log("ok")'`, then the same line without the
   directive. Seccomp-based directives work under the user manager, so this needs no root. Directives
   that need the system manager (`PrivateNetwork=`, `ProtectSystem=`, `CapabilityBoundingSet=`) go
   through `sudo systemd-run` instead.
6. **The core, when there is one.** `coredumpctl list` and `coredumpctl info <binary>` need the
   `systemd-coredump` package; without it, `core-dump` is only systemd's classification and the
   journal trace is all there is.

## Prevention matrix

| Failure mode | How it shows | Detection | Prevention | Where | Status |
| --- | --- | --- | --- | --- | --- |
| A sandbox directive the runtime cannot live under (`MemoryDenyWriteExecute=` against V8's JIT) | `core-dump`, `status=5/TRAP`, V8 `Check failed: 12 == errno` in `SetPermissions` | The deployment test refuses the directive in the foundation unit and sweeps every unit whose `ExecStart` runs node | The directive is gone, with a comment saying why it is absent | `deploy/boxpilot-libvirt-foundation.service`, `server/deployment.test.mjs` | Done, #564 |
| A unit that is never started before release | Its first real start fails on the owner's host | An Ubuntu CI smoke that runs each node unit's `ExecStart` under that unit's own `[Service]` directives as a transient unit and expects success | Catches every directive-versus-runtime collision, not only this one; `tests/ubuntu/env-file-parity.sh` already has the transient-unit pattern | `tests/ubuntu/` | Open |
| The browser blames the script when the process died | "failed and requested automatic rollback" with nothing rolled back | After a failed `systemctl start`, read `systemctl show -p Result -p ExecMainCode -p ExecMainStatus` | Say "the unit's process died (TRAP) before the script ran" when `ExecMainCode` is 3 (dumped), and keep the rollback wording for a script exit | `server/libvirt-foundation-helper.mjs` | Open |
| The approval marker is gone after a failure, so a manual `systemctl start` is skipped | "start condition unmet" in `systemctl status` | Expected: it is the five-minute safety | Re-approve from the UI; never recreate the marker by hand | Runbook (this document) | Documented |
| No `systemd-coredump` on the host | `core-dump` with no core to inspect | `coredumpctl: command not found` | `apt install systemd-coredump` keeps the next crash's core and stack | Host | Open, operator's call |
| The installed unit drifts from the shipped one | A merged fix changes nothing on the host | `diff` and `DropInPaths` in step 3 | `scripts/boxpilot-upgrade.sh` installs changed units and reloads systemd; a drop-in survives upgrades and must be removed on purpose | `scripts/boxpilot-upgrade.sh` | Exists |
| The host looks down when the operator's Tailscale is off | "I can't reach it" | Step 0 | Check your own node before the server; keep the LAN address at hand | Runbook | Documented |
| Hardening copied between units without the reason for each omission | One unit alone carries a directive nobody can explain | The node-unit sweep; a review that compares the directive set with the other node units | The units say in a comment why a directive is absent (`User=`, `RestrictSUIDSGID=`, now `MemoryDenyWriteExecute=`) | `deploy/*.service`, review | Convention exists; sweep done |
| The host runs a release several minors behind the repository | Fixes land in `main` and never reach the box | The System page and `GET /api/v1/health` report the version | The one-command upgrade in `docs/VIRTUALIZATION.md`, run after a fix merges | `docs/VIRTUALIZATION.md` | Exists |
| A DNS server in host network mode holds port 53 on every address, so libvirt's dnsmasq cannot bind the VM gateway | `net-start default` fails with "failed to create listening socket … Address already in use" | The foundation preflight should look for a wildcard listener on port 53 (`/proc/net/udp` and `tcp`, local address `00000000:0035`) and name the conflict before offering a plan | Durable: let `catalog/pi-hole.yaml` offer the bind-to-interface listening mode it now fixes to `all`; on this host: the default network keeps DHCP, has its own DNS off and hands guests the LAN resolver | `server/libvirt-foundation-helper.mjs`, `catalog/pi-hole.yaml`, the host | Host done; preflight and catalog open |

## Remediation checklist for this incident

- [x] Cause named from the host's journal and kernel log, and reproduced with transient units.
- [x] Fix and regression test on `fix/libvirt-foundation-core-dump`, pull request #564 against `main`.
- [ ] Merge #564 once CI is green.
- [ ] Cut a release and upgrade the host with `scripts/boxpilot-upgrade.sh`, which installs the changed
      unit and reloads systemd. Until then, a drop-in gives the same result and survives upgrades:

  ```
  sudo mkdir -p /etc/systemd/system/boxpilot-libvirt-foundation.service.d
  printf '[Service]\nMemoryDenyWriteExecute=false\n' | sudo tee /etc/systemd/system/boxpilot-libvirt-foundation.service.d/node-jit.conf
  sudo systemctl daemon-reload
  ```

  Remove the drop-in after the upgrade so the shipped unit is the only word.
- [x] Start the `default` network and enable its autostart. Done at the console with the DNS-off definition
      above, after the pool was found already running with autostart.
- [ ] Open Virtual Machines: **Default VM foundation** should report both resources ready. If it offers a
      plan instead, approve it; the unit now runs under the drop-in and should end with `Verified fixed
      libvirt foundation <uuid>` in its journal.
- [ ] Decide on `systemd-coredump` for the host.
- [ ] Open the follow-ups above: the Ubuntu CI smoke for node units, the helper's wording when the
      process dies before the script runs, the port-53 preflight check, and the Pi-hole listening mode
      in the catalog.

The lesson in one line: a directive that is right for a C daemon can be fatal for a JIT runtime, so
every node unit carries the same answer to it, the units say why a directive is absent, and the tests
refuse the one that kills node.
