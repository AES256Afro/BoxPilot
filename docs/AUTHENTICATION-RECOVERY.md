# Authentication state and recovery

BoxPilot keeps ordinary login separate from the signing identity used by apps offering Sign in with BoxPilot. If the SSO private key cannot be read, is damaged, has unsafe permissions or uses an incompatible curve, BoxPilot preserves it. It does not silently generate a replacement. The web service and owner client administration remain available, Settings shows the fault, and SSO endpoints return temporary unavailability.

Preserve the current key and its metadata before restoring the matching verified key backup. Check the state directory, file owner and private permissions against the installation. Restart BoxPilot after a deliberate key repair. Generating a different identity is a key rotation, with consequences for existing app tokens, and is not an automatic repair. Database backups alone do not include the separate signing-key file.

Pending SSO codes expire after one minute and are physically removed by one idle expiry timer. The service retains at most 1,024 codes globally and 64 per client. It refuses new codes at capacity without invalidating existing grants. Client removal clears pending grants; exchange also checks current registration. Already issued access tokens keep their existing one-hour lifetime. This change does not add immediate revocation of those tokens.

Authorization fields have application limits: state 2,048 characters, nonce 512, scope 256 and redirect URI 2,048. Repeated non-string fields are refused. Redirect URIs must match a registered HTTP(S) URL and cannot contain credentials or a fragment. BoxPilot requires explicit S256, a 43-character base64url SHA-256 challenge and a 43-128-character unreserved verifier. The verifier alphabet and S256 transformation follow [RFC 7636 sections 4.1-4.3](https://www.rfc-editor.org/rfc/rfc7636#section-4.1); the field and capacity limits are BoxPilot policy.

Password throttles retain at most 5,000 entries per configured throttle. Active blocks are never evicted to admit new callers. If every slot is blocked, an unknown caller waits until the first slot is reclaimable. This bounds memory under saturation but can temporarily delay a legitimate new password login during an attack. The throttle does not govern existing authenticated sessions. Expired retained counters are cleaned on subsequent activity; they have a fixed maximum count while idle.

## Application configuration

An app's Config dialog shows declared public environment values and masks private or undeclared `.env` entries. Password fields are always private, including a manifest that mistakenly specifies `secret: false`. The complete Compose file may contain credentials placed there by a manual edit. Read Compose file uses the audited `app.compose.inspect` operation, requires the owner and accepts an existing elevated session. Otherwise the dialog asks for the owner password. Editing remains available after reading the file.

Configuration reads accept only the catalog app id, use fixed filenames, reject symlinks and non-regular files, and stop at 64 KiB. Closing the dialog aborts its request and clears the displayed file and password. New Compose edits use temporary secret parameters with the same approval expiry and restart behavior as passwords, so the raw file is not stored in new job parameters. Previously recorded edits and existing backups are not rewritten by this change.

Private application-backup inventories, machine-snapshot lists and model names/sizes require an operator. Aggregate backup counts and declared public settings remain viewer-readable.
