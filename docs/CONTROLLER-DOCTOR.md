# BoxPilot installation doctor

Repair Center has a manual **Check BoxPilot installation** action. It checks systemd service state and account identity, state/socket/live-log permissions, required release assets, release metadata, and free bytes/inodes. It reads metadata, not database contents, configuration values or log contents. Protected host metadata is available to operators and the owner through the existing operation registry.

When the web interface is unavailable, connect over SSH or the server console and run:

```sh
sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane
sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --json
```

The command-line version also probes the loopback health endpoint and the helper's resource inspector, and compares both reported versions with the installed release. It does not require Express to start in order to collect file, service and capacity evidence. Each network request has a deadline and response-size bound. An older helper without the resource-inspection operation reports unavailable version evidence.

Exit codes are 0 for ready or warnings, 1 when a required check fails, and 2 when evidence is incomplete or the invocation cannot finish. Warning details still deserve review. The default doctor without options keeps the existing general host/virtualization checks. `--help` describes both paths.

A protected path that an ordinary admin cannot inspect is **unknown**, not a faulty permission. Use sudo for complete metadata checks. Missing optional live-log directories are a warning because they may not have been created yet. Existing directory ownership and modes are compared with the standard BoxPilot release layout. Customized deployments should compare reported differences with their own intended unit configuration.

This first slice diagnoses and gives next steps. It does not apply chmod/chown, restart services, repair the database or roll back a release. Those actions need known-good release metadata and database compatibility checks before they can become reliable recovery tools. No failed check recommends deleting the database or WAL.

Validation: injected fixtures cover a stopped web service, mixed versions, missing assets, permission drift, unreadable protected paths, low bytes/inodes and unavailable connectivity. A real Linux metadata check from an ordinary SSH account passed 15 checks, with two protected metadata checks unknown. An elevated live check could not run without interactive sudo authentication. Full web/helper version verification and recovery with Express stopped remain pending on a disposable Ubuntu system.
