# Refreshing processes after package updates

The Updates page uses needrestart to find processes using old libraries. Ordinary service units use the existing restart action.

The `systemd-manager` entry is a needrestart script marker for the system manager, not a service unit. **Refresh systemd manager** stages the medium-risk `system.manager.reexec` operation and previews `systemctl daemon-reexec`. The operation accepts no parameters, reports command failures, and clears the cached needrestart scan after success.

Post-upgrade cleanup uses the same daemon-reexec command for this marker. Other script markers, including `systemd-user`, remain visible for attention with reboot guidance and are never passed to `systemctl restart`. BoxPilot service restarts retain their detached timer so the upgrade job can finish recording first.

Reference: https://github.com/liske/needrestart/blob/master/ex/restart.d/systemd-manager
