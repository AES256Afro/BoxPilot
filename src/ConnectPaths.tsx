import { connectPaths } from "./sharePaths";

/**
 * The address to type on each kind of machine, with a copy button. Used anywhere BoxPilot names a
 * shared folder, so the answer to "how do I open this from my laptop" is never somewhere else.
 */
export default function ConnectPaths({ host, share, subpath = "", compact = false }: { host: string; share: string; subpath?: string; compact?: boolean }) {
  const paths = connectPaths({ host, share, subpath });
  return (
    <ul className={`connect-paths${compact ? " connect-paths-compact" : ""}`}>
      {paths.map((entry) => (
        <li key={entry.os}>
          <span className="connect-os">{entry.os}</span>
          <code>{entry.path}</code>
          {!compact && <span className="muted connect-hint">{entry.hint}</span>}
          <button className="text-button" type="button" onClick={() => void navigator.clipboard?.writeText(entry.path)} aria-label={`Copy the ${entry.os} path`}>Copy</button>
        </li>
      ))}
    </ul>
  );
}
