import type { PendingOperation } from "../../shell/ApproveDialog";

/** Types mirror server/catalog/schema.mjs (the normalized manifest) and server/app-helper.mjs (live state). */
export interface ManifestPort { id: string; label: string; container: number; host: number; protocol: "tcp" | "udp"; exposure: "lan" | "loopback"; fixed: boolean; tailnet?: "serve" | "address" | "unchanged"; containerFollowsHost?: boolean }
export interface ManifestVolume { id: string; label: string; container: string; path: string | null; hostPath: string | null; readOnly: boolean; backup: boolean; configurable: boolean; description: string | null }
export interface SetupChoice { id: string; label: string; description: string | null; website: string | null; recommended: boolean; exec: string[] }
export interface ManifestSetup { title: string; note: string | null; finalize: string[] | null; finalizeLabel: string | null; choices: SetupChoice[] }
export interface ManifestEnv { name: string; label: string; description: string | null; type: "string" | "password" | "number" | "boolean" | "timezone" | "path"; default: string | number | boolean | null; required: boolean; secret: boolean; generate: boolean; options: string[] | null; fixed: boolean; fromVpnProfile?: boolean }
export interface Manifest {
  id: string; name: string; category: string; description: string; website: string | null; icon: string | null; risk: "low" | "medium" | "high"; notes: string | null;
  connections?: Array<{ app: string; role: string; where: string; note: string | null }>;
  image: { reference: string; version: string | null; digestPinned: boolean };
  ports: ManifestPort[]; volumes: ManifestVolume[]; env: ManifestEnv[];
  health: { kind: string; stableSeconds: number; timeoutSeconds: number };
  setup?: ManifestSetup | null;
  signIn?: { path: string | null; port: string | null; username: string | null; usernameEnv: string | null; passwordEnv: string; note: string | null } | null;
  network?: string;
  networkModes?: string[];
  networkVia?: string | null;
  usesVpnProfile?: boolean;
  sidecars?: Array<{ id: string }>;
  modelRunner?: { kind: string; service: string } | null;
  /** Who can reach it when installed without choosing: "tailnet" publishes it with Tailscale Serve only (M38). */
  defaultExposure?: "lan" | "tailnet";
  /** Buttons on an installed app's sheet, each a registered operation run with { id } (Zulip's "Create your organization"). */
  actions?: Array<{ id: string; label: string; description: string | null; operation: string }>;
  sha256: string;
}

export interface Verification { verified: boolean; backup: string; reason: string | null; checkedAt: string }
export interface LiveUrl { id: string; label: string; host: number; exposure: string; path?: string | null }
export interface LiveState {
  id: string; installed: boolean; dataPresent: boolean;
  state: { installedAt: string; updatedAt: string; manifestSha256: string | null; image: { reference: string; id: string | null } | null; values: { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string>; setup?: string[]; exposure?: "lan" | "tailnet"; networkMode?: string }; pinnedRollback: boolean; uninstalledAt: string | null } | null;
  container: { exists: boolean; running: boolean; status: string; health: string; restarts: number; image: string | null };
  sidecars?: Array<{ id: string; running: boolean; status: string; restarts: number }>;
  urls: LiveUrl[];
  /** Each host port it publishes and the address it binds ("*" on the host's own network), from its deployed compose file. */
  published?: Array<{ id: string | null; host: number; protocol: string; bind: string; fixed: boolean; web: boolean; hostNetwork?: boolean }>;
  updateAvailable?: boolean;
  updateHistory?: Array<{ at: string; from: Record<string, string>; to: Record<string, string>; rolledBack?: boolean }>;
  installedImage?: string | null;
  folderProblems?: Array<{ path: string; volume: string; reason: string }>;
  backupVerification?: (Verification & { history?: Verification[] }) | null;
  killSwitchDrill?: { held: boolean; leaked: boolean; downForMs: number | null; at: string } | null;
}

export interface Entry { manifest: Manifest; live: LiveState | null }
export interface CatalogResponse {
  applications: Entry[];
  problems: Array<{ file: string; errors: string[] }>;
  liveError: string | null;
  host: { lanAddress: string | null; tailscaleDnsName: string | null };
}

export type Values = { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string>; setup?: string[]; networkMode?: string };
export interface Serve { dnsName: string; port: number; target: string | null }
export interface AppStats { cpuPercent: number; memBytes: number; containers: number }
export interface Tunnel { running: boolean; exit: { ip: string; location: string | null } | null; forwardedPort: number | null }
export interface KillswitchSchedule { id: string; overdue: boolean; lastRunAt: string | null; lastResult: string | null }

/** Everything an app's sheet needs from the page: the catalog as read, and the way to act on it. */
export interface CatalogContext {
  csrfToken: string;
  role: string;
  data: CatalogResponse;
  serves: Serve[] | null;
  stats: Record<string, AppStats> | null;
  tunnels: Record<string, Tunnel>;
  /** The weekly kill-switch drill per VPN app, when the owner turned it on. */
  killswitch: Record<string, KillswitchSchedule>;
  /** The weekly restore rehearsal per app, when there is one. */
  rehearsal: Record<string, { id: string; cadence: string }>;
  /** A schedule change is out: its buttons wait for it. */
  scheduling: boolean;
  /** What the last schedule change was refused with. */
  scheduleError: string | null;
  schedules: {
    rehearse: (appId: string) => Promise<void>;
    stopRehearsal: (scheduleId: string) => Promise<void>;
    killswitch: (appId: string) => Promise<void>;
    stopKillswitch: (scheduleId: string) => Promise<void>;
  };
  /**
   * Closes the sheet, then stages the operation through the approval dialog. `keep` is the edited
   * Compose file the action came from, handed back by takeComposeDraft when the job did not complete.
   */
  act: (operation: PendingOperation, keep?: { composeDraft: string }) => void;
  /** An app's edited Compose file whose Apply was cancelled or failed, once; null when there is none. */
  takeComposeDraft: (appId: string) => string | null;
  /** The address to open one of an app's ports at, from wherever this browser is. */
  openUrl: (port: { host: number; exposure: string; path?: string | null }, manifest: Manifest) => string;
  /** Opens the install or settings form in place of the sheet. */
  configure: (entry: Entry, mode: "install" | "reconfigure") => void;
}
