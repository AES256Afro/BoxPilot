import { RefreshIcon } from "./areaIcons";
import { requestRefresh } from "./refresh";
import "./bar.css";

/**
 * Refresh, in the bar (M25): the pull-to-refresh a phone expects, for the installed app, which has no
 * browser button to reload with. Shown on a touch screen, a phone-sized window and the installed app;
 * a desktop browser has its own. Home, Ops and Today read their facts again in place; any other page
 * is loaded again.
 */
export function RefreshButton() {
  return (
    <button className="bar-button bar-refresh" type="button" aria-label="Refresh" title="Read this page again" onClick={() => requestRefresh()}>
      <RefreshIcon aria-hidden="true" />
    </button>
  );
}
