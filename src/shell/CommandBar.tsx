import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PendingOperation } from "../ApproveDialog";
import type { ViewName } from "../data";
import { appFactsFrom } from "../home/facts";
import { readJson } from "../http";
import { Button, RiskTag, type RiskTier } from "../ui";
import { useDialogFocus } from "../useDialogFocus";
import { AreaIcon, ExternalIcon, PlusIcon, SearchIcon, SparkIcon } from "./areaIcons";
import { buildCommands, searchCommands, type CatalogEntry, type Command, type CommandGroup } from "./commandIndex";

/*
 * The command bar (M33.2): Ctrl K or Cmd K anywhere, or the search box in the top bar. Typing
 * finds any page, app or feature. Where the local assistant is set up (M34.2) the last choice asks
 * it the question instead; where it is not, the bar says so and stays a search box. The assistant
 * never runs anything: a step it suggests opens the ordinary approval dialog at its own tier.
 */

interface AssistantStatus { ready: boolean; chatModel?: string | null; problem?: { reason: string; message: string } | null }
interface PlanStep { operationId: string; title: string; risk: RiskTier; readOnly: boolean; parameters: Record<string, unknown>; why?: string }
interface AskResult {
  answer: string;
  sources?: Array<{ id: string; kind: string; title: string; cited?: boolean }>;
  plan?: { steps: PlanStep[]; dropped?: Array<{ reason: string }> } | null;
  model?: string | null;
  degraded?: { reason: string; message: string } | null;
}

type Option = { kind: "command"; command: Command } | { kind: "ask"; question: string };

export interface CommandBarProps {
  csrfToken: string;
  onNavigate: (view: ViewName, options?: { app?: string }) => void;
  /** Opens the approval dialog for a step the assistant suggested. */
  onStart: (operation: PendingOperation) => void;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function CommandBar({ csrfToken, onNavigate, onStart }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  // Attached as the bar is drawn, so the shortcut works the moment the bar can be seen.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      // Another dialog holds the keyboard; opening this over it would leave two fighting for focus.
      if (document.querySelector('[aria-modal="true"]:not(.command-dialog)')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const mac = isMac();
  return (
    <>
      <button type="button" className="command-trigger" aria-haspopup="dialog" aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} onClick={() => setOpen(true)}>
        <SearchIcon className="command-trigger__icon" />
        <span className="command-trigger__label">Search pages, apps and settings</span>
        <kbd className="command-trigger__keys" aria-hidden="true">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {open && <CommandDialog csrfToken={csrfToken} onClose={() => setOpen(false)} onNavigate={onNavigate} onStart={onStart} />}
    </>
  );
}

const groupIcon = (command: Command): ReactNode => {
  if (command.href) return <ExternalIcon />;
  if (command.label.startsWith("Install ")) return <PlusIcon />;
  return command.view ? <AreaIcon view={command.view} /> : null;
};

function CommandDialog({ csrfToken, onClose, onNavigate, onStart }: CommandBarProps & { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  useDialogFocus(dialogRef);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [assistant, setAssistant] = useState<AssistantStatus | "failed" | null>(null);
  const [asked, setAsked] = useState<{ question: string; result: AskResult | null; error: string | null } | null>(null);
  const asking = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Every app in the catalog, installed first; a failure leaves pages and features to search.
    fetch("/api/v1/catalog?view=summary")
      .then((response) => readJson<Parameters<typeof appFactsFrom>[0]>(response))
      .then((body) => {
        const installed = new Map(appFactsFrom(body, []).apps.map((app) => [app.id, app]));
        const entries = (body.applications ?? []).flatMap((entry) => (entry.manifest?.id ? [{
          id: entry.manifest.id, name: entry.manifest.name ?? entry.manifest.id, category: entry.manifest.category ?? "",
          installed: installed.has(entry.manifest.id), url: installed.get(entry.manifest.id)?.url ?? null,
        }] : []));
        if (!cancelled) setCatalog(entries);
      })
      .catch(() => undefined);
    fetch("/api/v1/assistant/status")
      .then((response) => readJson<AssistantStatus>(response))
      .then((status) => { if (!cancelled) setAssistant(typeof status?.ready === "boolean" ? status : "failed"); })
      .catch(() => { if (!cancelled) setAssistant("failed"); });
    return () => { cancelled = true; asking.current?.abort(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ready = assistant !== null && assistant !== "failed" && assistant.ready;
  const commands = useMemo(() => buildCommands(catalog), [catalog]);
  const typed = query.trim();
  const options: Option[] = useMemo(() => [
    ...searchCommands(commands, query).map((command) => ({ kind: "command" as const, command })),
    ...(ready && typed ? [{ kind: "ask" as const, question: typed }] : []),
  ], [commands, query, ready, typed]);
  useEffect(() => setActive(0), [query]);

  const ask = useCallback(async (question: string) => {
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    setAsked({ question, result: null, error: null });
    try {
      const response = await fetch("/api/v1/assistant/ask", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ question }),
      });
      const result = await readJson<AskResult>(response);
      if (!controller.signal.aborted) setAsked({ question, result, error: null });
    } catch (error) {
      if (!controller.signal.aborted) setAsked({ question, result: null, error: error instanceof Error ? error.message : "The assistant could not answer" });
    }
  }, [csrfToken]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === "ask") { void ask(option.question); return; }
    const { command } = option;
    onClose();
    if (command.href) window.open(command.href, "_blank", "noopener,noreferrer");
    else if (command.view) onNavigate(command.view, command.app ? { app: command.app } : undefined);
  };

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (asked) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(options[active]); }
  };

  useEffect(() => { document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" }); });

  const backToSearch = () => { asking.current?.abort(); setAsked(null); inputRef.current?.focus(); };
  const runStep = (step: PlanStep) => {
    onClose();
    onStart({ operationId: step.operationId, title: step.title, parameters: step.parameters ?? {}, preview: step.why ? <span>{step.why}</span> : undefined });
  };

  // Options grouped under their headings; the index runs on across groups for the active option.
  const groups: Array<{ name: CommandGroup | "Assistant"; items: Array<{ option: Option; index: number }> }> = [];
  options.forEach((option, index) => {
    const name = option.kind === "ask" ? "Assistant" : option.command.group;
    const group = groups.at(-1)?.name === name ? groups.at(-1)! : (groups.push({ name, items: [] }), groups.at(-1)!);
    group.items.push({ option, index });
  });

  const model = assistant && assistant !== "failed" ? assistant.chatModel ?? "the local model" : "the local model";
  const assistantLine = assistant === null ? "Checking whether the local assistant is set up…"
    : assistant === "failed" ? "The local assistant did not answer, so this only searches."
      : assistant.ready ? `Type a question and choose Ask to put it to ${model}, which runs on this server.`
        : `The local assistant is not set up, so this only searches.${assistant.problem?.message ? ` ${assistant.problem.message}` : ""}`;

  return createPortal(
    <div className="modal-backdrop command-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Search BoxPilot" className="command-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-input">
          <SearchIcon className="command-input__icon" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search pages, apps and settings"
            aria-expanded={!asked && options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={!asked && options.length > 0 ? optionId(active) : undefined}
            placeholder={ready ? "Search, or ask the assistant" : "Search pages, apps and settings"}
            autoComplete="off"
            spellCheck={false}
            value={query}
            readOnly={Boolean(asked)}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKey}
          />
          <button className="command-close" type="button" aria-label="Close dialog" onClick={onClose}>Esc</button>
        </div>

        {asked ? (
          <div className="command-answer" aria-live="polite" aria-busy={!asked.result && !asked.error}>
            <p className="command-answer__question">{asked.question}</p>
            {!asked.result && !asked.error && <p className="command-answer__wait">Asking {model}. On a processor without a GPU an answer can take a minute.</p>}
            {asked.error && <p className="auth-error" role="alert">{asked.error}</p>}
            {asked.result && (
              <>
                {asked.result.degraded && <p className="notice">{asked.result.degraded.message}</p>}
                <div className="command-answer__text">{asked.result.answer}</div>
                {(asked.result.sources ?? []).length > 0 && (
                  <details className="command-answer__sources">
                    <summary>Drawn from {asked.result.sources!.length === 1 ? "one source" : `${asked.result.sources!.length} sources`}</summary>
                    <ul>{asked.result.sources!.map((source) => <li key={source.id}><span>{source.title}</span><small>{source.kind}{source.cited ? " · cited" : ""}</small></li>)}</ul>
                  </details>
                )}
                {(asked.result.plan?.steps ?? []).length > 0 && (
                  <section className="command-plan" aria-label="Suggested steps">
                    <h3>Suggested steps</h3>
                    <ol>
                      {asked.result.plan!.steps.map((step, index) => (
                        <li key={`${step.operationId}-${index}`}>
                          <div><strong>{step.title}</strong>{step.why && <span>{step.why}</span>}</div>
                          {step.readOnly
                            ? <span className="command-plan__read">Only reads</span>
                            : <><RiskTag risk={step.risk} /><Button risk={step.risk} onClick={() => runStep(step)}>Review</Button></>}
                        </li>
                      ))}
                    </ol>
                    <p className="command-answer__note">Nothing runs until you approve it, at its own tier.</p>
                  </section>
                )}
                <p className="command-answer__note">Written by {asked.result.model ?? model} on this server from the sources above. Check it against them before acting on it.</p>
              </>
            )}
            <div className="command-answer__actions">
              {!asked.result && !asked.error && <Button variant="ghost" onClick={backToSearch}>Stop</Button>}
              <Button variant="ghost" onClick={backToSearch}>Back to search</Button>
            </div>
          </div>
        ) : (
          <div id={listId} role="listbox" aria-label="Results" className="command-results">
            {groups.map((group) => (
              <div key={group.name} role="group" aria-label={group.name}>
                <div className="command-group" aria-hidden="true">{group.name}</div>
                {group.items.map(({ option, index }) => (
                  <div
                    key={option.kind === "ask" ? "ask" : option.command.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    className="command-option"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => { if (index !== active) setActive(index); }}
                    onClick={() => choose(option)}
                  >
                    <span className="command-option__icon" aria-hidden="true">{option.kind === "ask" ? <SparkIcon /> : groupIcon(option.command)}</span>
                    <span className="command-option__label">{option.kind === "ask" ? <>Ask: <q>{option.question}</q></> : option.command.label}</span>
                    <span className="command-option__hint">{option.kind === "ask" ? model : option.command.hint}</span>
                  </div>
                ))}
              </div>
            ))}
            {options.length === 0 && <p className="command-empty">Nothing matches <q>{typed}</q>.</p>}
          </div>
        )}
        <footer className="command-foot" role="status">{assistantLine}</footer>
      </section>
    </div>,
    document.body,
  );
}
