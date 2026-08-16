# Local Action Center

BoxPilot `0.29.0` adds an authenticated, read-only Action Center inside Repair Center. Version `0.30.0` also correlates sanitized filesystem-capacity and timer-generated SMART evidence. It converts fixed evidence into prioritized notices, explains why each notice exists, and links the operator to a fixed BoxPilot destination with a short manual checklist.

The Action Center is guidance, not an automation system. Opening, refreshing, or navigating from it performs no host, application, VM, router, network, DNS, Tailscale, package, file, or service mutation.

## Evidence source

`GET /api/v1/operations/action-center` calls the same read-only recovery evidence collector used by the downloadable disaster recovery kit. It can create guidance for these fixed checks:

| Recovery check | Destination |
| --- | --- |
| Independent BoxPilot database copy | Repair Center |
| Exact BoxPilot source and install notes | GitHub provenance |
| Managed application recovery | Backups |
| Virtual-machine recovery | Backups |
| Router configuration checkpoint | Routers |
| Migration source preservation | Migrations |
| Independent DNS proof | Network |
| Host prerequisite review | Repair Center |
| Recent failed durable jobs | Repair Center |
| Filesystem warning or critical capacity | Overview |
| Missing, stale, warning, or critical SMART evidence | Overview |

Verified and not-applicable checks do not create noise. If every mapped check is verified or not applicable, BoxPilot reports one informational readiness notice. Operator checks remain visible because they require human evidence outside Bigbox.

## Severity model

- `critical`: a required collector is unavailable. BoxPilot fails closed and does not claim all-clear.
- `warning`: current sanitized evidence explicitly requires action, or a recent durable job failed.
- `info`: an operator check remains, or all mapped checks currently require no action.

This severity is a triage aid. It does not authorize a change and does not override the risk level of any later durable job.

## Guided handoff

Each notice includes:

- A fixed category, title, and destination
- The sanitized evidence that caused it to appear
- Three fixed operator steps
- An explicit boundary stating that no automatic fix, command, credential, or log payload is present

The destination button only changes the current BoxPilot view. Any executable operation still requires its own immutable plan, dry run, checkpoint, owner-password approval, typed helper operation, and verification or rollback path.

## Fail-closed behavior

If the recovery collector throws, returns an incomplete object, or introduces an actionable check without fixed Action Center guidance, BoxPilot reports a critical or warning review notice. It does not silently omit the condition or synthesize a passing state. Collector errors are not returned to the browser because they may contain implementation details.

## Deliberate exclusions

Version `0.30.0` has no:

- Automatic repair or remediation execution
- Arbitrary command, package, service, file, Docker, libvirt, router, DNS, firewall, or Tailscale operation
- Notice dismissal, snooze, persistence, recurrence, schedule, retry, or background worker
- Browser notification permission
- Email, webhook, SMS, push, Slack, or other external delivery
- User-provided rule, destination, command, target, template, or plugin
- Credential, agent key, router configuration, backup payload, application data, database content, or arbitrary log inclusion

Future executable remediation must be implemented as a separately named, typed, narrowly scoped workflow. The Action Center itself should remain a read-only correlation and navigation layer.
