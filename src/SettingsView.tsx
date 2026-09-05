/**
 * The Settings page, in its own chunk.
 *
 * Every other view is loaded when first opened; this one rode in the entry chunk with its ten
 * panels, so the first paint of the Overview paid for notification, passkey, OIDC and people
 * settings nobody had asked for yet.
 */
import ApprovalSettings from "./ApprovalSettings";
import NotificationSettings from "./NotificationSettings";
import CredentialsPanel from "./CredentialsPanel";
import SignInSettings from "./SignInSettings";
import PasskeySettings from "./PasskeySettings";
import SessionsSettings from "./SessionsSettings";
import OidcSettings from "./OidcSettings";
import PeopleSettings from "./PeopleSettings";
import PasswordSettings from "./PasswordSettings";
import ThemeSettings from "./ThemeSettings";

export default function Settings({ csrfToken, role = "owner" }: { csrfToken: string; role?: string }) {
  return (
    <div className="settings-grid">
      {/* Box-level settings are the owner's; a viewer's Settings page is their own password. */}
      {role === "owner" && <ApprovalSettings csrfToken={csrfToken} />}
      {role !== "viewer" && <SignInSettings csrfToken={csrfToken} />}
      {role === "owner" && <OidcSettings csrfToken={csrfToken} />}
      <PasskeySettings csrfToken={csrfToken} />
      <SessionsSettings csrfToken={csrfToken} />
      {role === "owner" && <NotificationSettings csrfToken={csrfToken} />}
      {role === "owner" && <CredentialsPanel csrfToken={csrfToken} />}
      <PasswordSettings csrfToken={csrfToken} />
      {role === "owner" && <PeopleSettings csrfToken={csrfToken} />}
      <ThemeSettings />
    </div>
  );
}
