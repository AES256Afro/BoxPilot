import { useId } from "react";
import { Button, Checkbox, Sheet, Tag, riskOf } from "../../ui";
import { handleRadioKeys } from "../../ui/radio";
import { spec, type CurrentProfile, type Profile, type ProtectedRule, type Service } from "./types";

/*
 * Choosing a firewall profile (M33.10): a long form, so it is a sheet. A starting point, the
 * services other devices may reach, and two options; applying always ends with the firewall on,
 * and the approval dialog shows every ufw command before anything runs.
 */

export interface ProfileChoice { profileId: string | null; services: string[]; sshRateLimit: boolean; replace: boolean }

export interface FirewallProfileSheetProps {
  profiles: Profile[];
  services: Service[];
  protectedRules: ProtectedRule[];
  current: CurrentProfile | null;
  choice: ProfileChoice;
  onChange: (next: ProfileChoice) => void;
  /** Builds the plan and hands it to the approval dialog. */
  onReview: () => void;
  planning: boolean;
  onClose: () => void;
}

export function FirewallProfileSheet({ profiles, services, protectedRules, current, choice, onChange, onReview, planning, onClose }: FirewallProfileSheetProps) {
  const baseId = useId();
  const selected = profiles.find((profile) => profile.id === choice.profileId) ?? null;
  const locked = Boolean(selected?.lockServices);
  const set = (patch: Partial<ProfileChoice>) => onChange({ ...choice, ...patch });
  const toggleService = (id: string, checked: boolean) => set({ services: checked ? [...new Set([...choice.services, id])] : choice.services.filter((entry) => entry !== id) });
  const focusable = selected?.id ?? profiles[0]?.id;

  return (
    <Sheet
      kicker="Profile"
      title="Choose a firewall profile"
      size="lg"
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" risk={riskOf("firewall.profile.apply")} disabled={!selected} busy={planning} onClick={onReview}>Review and apply</Button>
      </>}
    >
      <div className="firewall-sheet">
        <section className="firewall-sheet__part" aria-labelledby={`${baseId}-start`}>
          <h3 id={`${baseId}-start`} className="firewall-sheet__heading">Starting point</h3>
          <div role="radiogroup" aria-labelledby={`${baseId}-start`} className="firewall-choices" onKeyDown={(event) => handleRadioKeys(event, (id) => set({ profileId: id }))}>
            {profiles.map((profile) => {
              const checked = profile.id === choice.profileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-labelledby={`${baseId}-${profile.id}-name`}
                  aria-describedby={`${baseId}-${profile.id}-summary`}
                  tabIndex={profile.id === focusable ? 0 : -1}
                  data-value={profile.id}
                  className="firewall-choice"
                  onClick={() => set({ profileId: profile.id })}
                >
                  <span className="firewall-choice__head">
                    <span className="firewall-choice__dot" aria-hidden="true" />
                    <span id={`${baseId}-${profile.id}-name`} className="firewall-choice__name">{profile.name}</span>
                    {profile.recommended && <Tag tone="good">recommended</Tag>}
                    {current?.id === profile.id && <Tag tone="accent">in force</Tag>}
                  </span>
                  <span id={`${baseId}-${profile.id}-summary`} className="firewall-choice__summary">{profile.summary}</span>
                  <span className="firewall-choice__detail">{profile.detail}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="firewall-sheet__part" aria-labelledby={`${baseId}-services`}>
          <h3 id={`${baseId}-services`} className="firewall-sheet__heading">Services other devices may reach</h3>
          {locked && <p className="firewall-sheet__note">{selected?.name} opens nothing on the LAN. Choose another profile to pick services.</p>}
          <div className="firewall-sheet__checks">
            {services.map((service) => (
              <Checkbox
                key={service.id}
                label={service.name}
                description={`${service.ports.map((entry) => spec(entry.port, entry.protocol)).join(", ")} · ${service.hint}`}
                checked={!locked && choice.services.includes(service.id)}
                disabled={locked}
                onChange={(checked) => toggleService(service.id, checked)}
              />
            ))}
          </div>
        </section>

        <section className="firewall-sheet__part" aria-labelledby={`${baseId}-options`}>
          <h3 id={`${baseId}-options`} className="firewall-sheet__heading">Options</h3>
          <div className="firewall-sheet__checks">
            <Checkbox label="Rate-limit SSH logins" description="6 new connections per 30 s per address: blunts password guessing without locking you out." checked={choice.sshRateLimit} onChange={(checked) => set({ sshRateLimit: checked })} />
            <Checkbox label="Start from scratch" description={<>Removes every existing rule first (<code>ufw reset</code>), then applies the profile.</>} checked={choice.replace} onChange={(checked) => set({ replace: checked })} />
          </div>
        </section>

        <p className="firewall-sheet__note">
          Always kept open, whatever you choose: {protectedRules.map((entry, index) => <span key={`${entry.port}/${entry.protocol}`}><code>{spec(entry.port, entry.protocol)}</code> {entry.label}{index < protectedRules.length - 1 ? ", " : "."}</span>)} You see every command before anything runs.
        </p>
      </div>
    </Sheet>
  );
}
