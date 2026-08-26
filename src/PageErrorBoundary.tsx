import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken page from taking the whole product with it.
 *
 * Without this, any error thrown while rendering unmounts everything — including the navigation —
 * and leaves a white screen with no way back except knowing to edit the URL. That is what every
 * shape mismatch between this interface and the server has looked like from the owner's side: not
 * "the storage page is confused", just nothing at all.
 *
 * A page that fails is worth saying so about plainly, and the rest of the product is worth keeping
 * usable while it does.
 */
interface Props { children: ReactNode; pageName: string; resetKey: string }
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
    return (
      <section className="panel" data-page-error={this.props.pageName}>
        <header className="panel-header">
          <div>
            <strong>The {this.props.pageName} page could not be shown</strong>
            <span>Something this page read back was not the shape it expected. The rest of BoxPilot is unaffected. The other pages still work, and nothing on this server has changed.</span>
          </div>
        </header>
        <p className="muted">This is a fault in BoxPilot rather than something you did. It is worth reporting with a support bundle, which includes the detail below.</p>
        <pre className="log-view" aria-label="Error detail">{String(error?.message ?? error)}</pre>
        <div className="recovery-actions">
          <button className="primary-button" type="button" onClick={() => this.setState({ error: null })}>Try this page again</button>
          <button className="secondary-button" type="button" onClick={() => window.location.reload()}>Reload BoxPilot</button>
        </div>
      </section>
    );
  }
}
