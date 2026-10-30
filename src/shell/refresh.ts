/**
 * The bar's Refresh (M25): what a phone's pull-to-refresh would do, for the installed app, which has
 * no browser button to reload with. A view that reads its own facts (Home, Ops, Today) says it has
 * it by cancelling the event, and reads them again in place; any other page is loaded again.
 */
export const refreshEvent = "boxpilot:refresh";

export function requestRefresh({ reload = () => window.location.reload() }: { reload?: () => void } = {}): "refreshed" | "reloaded" {
  const event = new Event(refreshEvent, { cancelable: true });
  const taken = !window.dispatchEvent(event);
  if (taken) return "refreshed";
  reload();
  return "reloaded";
}

/** For a view that can read its facts again in place: returns the function that stops listening. */
export function onRefresh(read: () => void): () => void {
  const listener = (event: Event) => { event.preventDefault(); read(); };
  window.addEventListener(refreshEvent, listener);
  return () => window.removeEventListener(refreshEvent, listener);
}
