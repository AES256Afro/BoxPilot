import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, CodeBlock, Notice } from "../ui";
import "./page-error.css";

/**
 * Keeps one broken page from taking the whole product with it.
 *
 * Without this, any error thrown while rendering unmounts everything — including the navigation —
 * and leaves a white screen with no way back except knowing to edit the URL. That is what every
 * shape mismatch between this interface and the server has looked like from the owner's side: not
 * "the storage page is confused", just nothing at all.
 *
 * A page that fails is worth saying so about plainly, and the rest of the product is worth keeping
 * usable while it does. M33.13 draws it in the console's look: the verdict as the kit's notice,
 * with the way out on it, and the detail a support bundle needs in a CodeBlock.
 */
interface Props { children: ReactNode; pageName: string; resetKey: string }

/** The shapes browsers give a dynamic import() that could not be fetched - Chrome, Firefox, Safari, and Vite's preload. */
export function isChunkLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk .* failed/i.test(message);
}
interface State { error: Error | null }

export default class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The support bundle is assembled from what the browser recorded, so this needs to be in it.
    console.error(`BoxPilot: the ${this.props.pageName} page failed to render`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    // Navigating away is the obvious way out, so it must actually clear the failure.
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Every page is its own chunk, fetched when first opened. If BoxPilot was upgraded while this
    // tab was open, the chunk the shell asks for no longer exists on the server and the import
    // rejects. That is not a fault in the page, and "try again" cannot help - React remembers a
    // failed import - so the honest offer is the one that works: reload, and get the new version.
    if (isChunkLoadFailure(error)) {
      return (
        <div className="page-error-view" data-page-error={this.props.pageName} data-page-error-kind="stale-chunk">
          <Notice tone="info" title="BoxPilot was updated while this tab was open" action={<Button variant="primary" onClick={() => window.location.reload()}>Reload BoxPilot</Button>}>
            The {this.props.pageName} page belongs to the version that was running when you opened BoxPilot, and that version is gone from the server now. Reloading picks up the new one; nothing on this server is affected.
          </Notice>
        </div>
      );
    }
    return (
      <div className="page-error-view" data-page-error={this.props.pageName}>
        <Notice
          tone="danger"
          title={`The ${this.props.pageName} page could not be shown`}
          action={<>
            <Button variant="primary" onClick={() => this.setState({ error: null })}>Try this page again</Button>
            <Button onClick={() => window.location.reload()}>Reload BoxPilot</Button>
          </>}
        >
          Something this page read back was not the shape it expected. The rest of BoxPilot is unaffected. The other pages still work, and nothing on this server has changed.
        </Notice>
        <p className="page-error-note">This is a fault in BoxPilot rather than something you did. It is worth reporting with a support bundle, which includes the detail below.</p>
        <CodeBlock label="Error detail" maxHeight="16rem">{String(error?.message ?? error)}</CodeBlock>
      </div>
    );
  }
}
