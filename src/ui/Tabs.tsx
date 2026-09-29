import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, type Status } from "./types";

export interface TabItem<V extends string> {
  id: V;
  label: ReactNode;
  /** A figure after the label: how many shares, how many rules. */
  count?: number | string;
  /** A status for what the tab holds: its mark is drawn after the label, and said in words by `statusLabel`. */
  status?: Status;
  /** The status in words, read after the label: "2 need a look". */
  statusLabel?: string;
}

export interface TabsProps<V extends string> {
  /** What the tabs divide, for assistive technology: "Storage". */
  label: string;
  tabs: Array<TabItem<V>>;
  /** The open tab, when the page holds it. Leave it out and use `urlParam` to keep it in the address. */
  value?: V;
  onChange?: (id: V) => void;
  /**
   * Keep the open tab in the address under this name (?view=storage&tab=shares), so a reload or a
   * link opens the same tab. Used when `value` is left out.
   */
  urlParam?: string;
  /** The open tab's content. Only the open tab is drawn. */
  children: (id: V) => ReactNode;
  className?: string;
}

/**
 * Read and write one parameter of the page's address (M33.8), as the shell does ?view=: the value
 * is `fallback` when the address has none or one not in `allowed`, and choosing the fallback takes
 * the parameter out again. The shell drops a page's parameters when the page changes.
 */
export function useUrlParam<V extends string>(name: string, allowed: readonly V[], fallback: V): [V, (next: V) => void] {
  const read = (): V => {
    if (typeof window === "undefined") return fallback;
    const found = new URLSearchParams(window.location.search).get(name);
    return found !== null && (allowed as readonly string[]).includes(found) ? (found as V) : fallback;
  };
  const [value, setValue] = useState<V>(read);
  const set = useCallback((next: V) => {
    setValue(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(name); else url.searchParams.set(name, next);
    window.history.replaceState(window.history.state, "", url);
  }, [name, fallback]);
  return [value, set];
}

/**
 * Tabs (M33.8), as the ARIA tabs pattern has them: a tablist whose arrow keys, Home and End move
 * between tabs and open them, one tab stop for the list, and the open tab's panel after it, named
 * by its tab. The open tab can live in the address (`urlParam`).
 */
export function Tabs<V extends string>({ label, tabs, value, onChange, urlParam, children, className }: TabsProps<V>) {
  const ids = tabs.map((tab) => tab.id);
  const fallback = ids[0];
  const [fromUrl, setUrl] = useUrlParam<V>(urlParam ?? "tab", ids, fallback);
  const [own, setOwn] = useState<V>(fallback);
  const current = value ?? (urlParam ? fromUrl : own);
  const baseId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const select = (next: V) => {
    if (value === undefined) (urlParam ? setUrl : setOwn)(next);
    onChange?.(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const at = ids.indexOf(current);
    const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : event.key === "ArrowRight" ? (at + 1) % ids.length : (at - 1 + ids.length) % ids.length;
    select(ids[next]);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const tabId = (id: V) => `${baseId}-tab-${id}`;
  const panelId = (id: V) => `${baseId}-panel-${id}`;
  return (
    <div className={cx("ui-tabs", className)}>
      <div ref={listRef} role="tablist" aria-label={label} className="ui-tabs__list" onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              className="ui-tabs__tab"
              onClick={() => select(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count !== "" && <>{" "}<span className="ui-tabs__count">{tab.count}</span></>}
              {tab.status && <span className="ui-marked ui-tabs__mark" data-status={tab.status}><span className="ui-mark" aria-hidden="true" />{tab.statusLabel && <span className="ui-visually-hidden">{`, ${tab.statusLabel}`}</span>}</span>}
            </button>
          );
        })}
      </div>
      <div id={panelId(current)} role="tabpanel" aria-labelledby={tabId(current)} tabIndex={0} className="ui-tabs__panel">
        {children(current)}
      </div>
    </div>
  );
}
