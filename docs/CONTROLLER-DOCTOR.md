# BoxPilot installation doctor

Repair Center has a manual **Check BoxPilot installation** action. It checks systemd service state and account identity, state/socket/live-log permissions, required release assets, release metadata, and free bytes/inodes. It reads metadata, not database contents, configuration values or log contents. Protected host metadata is available to operators and the owner through the existing operation registry.

When the web interface is unavailable, connect over SSH or the server console and run:

```sh
sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane
sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --json
sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane --database
```

The command-line version also probes the loopback health endpoint and the helper's resource inspector, and compares both reported versions with the installed release. It does not require Express to start in order to collect file, service and capacity evidence. Each network request has a deadline and response-size bound. An older helper without the resource-inspection operation reports unavailable version evidence.

## Optional database inspection

**Check database** in Repair Center and the CLI's `--database` option add an independent SQLite check. The operation is `controller.database.inspect`, restricted to operators and the owner with no browser-supplied path. It checks regular-file/journal metadata, SQLite `quick_check(1)`, the first foreign-key violation, the core tables required by the existing backup system and account-record presence. Account names, password hashes, settings, job contents and raw SQLite errors are omitted. An empty account table is a warning because a new installation may still need setup. WAL presence and size alone are normal.

The scanner opens SQLite read-only, runs no migrations and does no checkpoint, replacement or journal deletion. SQLite may use or create its normal coordination files. A root invocation runs the child as the database file's owner so those files do not become root-owned. Linked databases or journal files and unexpected writable metadata prevent inspection. The child has a 15-second deadline, 48 MiB V8 heap ceiling, 2 MiB SQLite cache target and 32 KiB response limit. These are separate limits, not a total process-memory cap. Concurrent helper requests share a scan; none starts on page load.

Quick-check success is basic health evidence, not proof that a backup can be restored or that another release understands this database. Review the database backups after inspection. Preserve the original database and its journals before offline recovery; backup validation, compatible release selection and a tested restore remain separate steps.

Exit codes are 0 for ready or warnings, 1 when a required check fails, and 2 when evidence is incomplete or the invocation cannot finish. Warning details still deserve review. The default doctor without options keeps the existing general host/virtualization checks. `--help` describes both paths.

A protected path that an ordinary admin cannot inspect is **unknown**, not a faulty permission. Use sudo for complete metadata checks. Missing optional live-log directories are a warning because they may not have been created yet. Existing directory ownership and modes are compared with the standard BoxPilot release layout. Customized deployments should compare reported differences with their own intended unit configuration.

This first slice diagnoses and gives next steps. It does not apply chmod/chown, restart services, repair the database or roll back a release. Those actions need known-good release metadata and database compatibility checks before they can become reliable recovery tools. No failed check recommends deleting the database or WAL.

Validation: fixtures cover stopped services, mixed versions, missing assets, permission drift, low capacity, incomplete connectivity, committed WAL data, corruption, foreign-key failures, missing tables, linked journals, missing databases and child deadlines. A local Ubuntu fixture verifies that database bytes stay unchanged and the web identity can reopen the state after a root doctor invocation. Native install smoke has already passed the independent metadata doctor with Express stopped; it now also exercises database inspection through the helper and with both services stopped. Hosted results for that extension are recorded in the progress review. A real Linux metadata check from an ordinary SSH account passed 15 checks, with two protected metadata checks unknown. Elevated live database inspection has not been performed.
