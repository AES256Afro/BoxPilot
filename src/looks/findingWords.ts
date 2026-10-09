/**
 * A Repair finding in the few words a look's small display has room for (M41): Rack Panel's LCD
 * lines and Glass Cockpit's memo, by the finding's kind. What is affected, then what is wrong.
 */
export const findingWords: Record<string, [string, string]> = {
  "dns-single-point": ["DNS", "NO 2ND RESOLVER"],
  "dns-fallback-unproven": ["DNS", "FALLBACK UNTRIED"],
  "no-notification-target": ["ALERTS", "NOWHERE TO GO"],
  "windows-discovery": ["WINDOWS", "NOT LISTED"],
  "drive-order": ["DRIVES", "MOUNT ORDER"],
  "split-data-folders": ["DATA", "SPLIT FOLDERS"],
  "exfat-checker-missing": ["EXFAT", "NO CHECKER"],
  "backup-destination-moved": ["BACKUP DRIVE", "MOVED"],
  "read-only-remount": ["DRIVE", "READ-ONLY"],
  "drive-check": ["DRIVE", "NOT CHECKED"],
  "drive-mark": ["DRIVE", "UNMARKED"],
  "stale-mount": ["DRIVE", "STALE MOUNT"],
  "stale-bind": ["FOLDER", "STALE BIND"],
  "flaky-drive": ["DRIVE", "DROPS OUT"],
  "permissionless-mount": ["DRIVE", "ROOT ONLY"],
  "share-unwritable": ["SHARE", "READ-ONLY"],
  "port-conflict": ["PORT", "IN USE"],
  "backup-rehearsal": ["BACKUP", "NOT REHEARSED"],
  "vpn-leak": ["VPN", "LEAKED"],
  "app-folder": ["FOLDER", "NOT WRITABLE"],
};
