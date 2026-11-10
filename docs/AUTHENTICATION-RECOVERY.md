# Authentication state and recovery

BoxPilot keeps ordinary login separate from the signing identity used by apps offering Sign in with BoxPilot. If the SSO private key cannot be read, is damaged, has unsafe permissions or uses an incompatible curve, BoxPilot preserves it. It does not silently generate a replacement. The web service and owner client administration remain available, Settings shows the fault, and SSO endpoints return temporary unavailability.

Preserve the current key and its metadata before restoring the matching verified key backup. Check the state directory, file owner and private permissions against the installation. Restart BoxPilot after a deliberate key repair. Generating a different identity is a key rotation, with consequences for existing app tokens, and is not an automatic repair. Database backups alone do not include the separate signing-key file.

Pending SSO codes expire after one minute and are physically removed by one idle expiry timer. The service retains at most 1,024 codes globally and 64 per client. It refuses new codes at capacity without invalidating existing grants. Client removal clears pending grants; exchange also checks current registration. Already issued access tokens keep their existing one-hour lifetime. This change does not add immediate revocation of those tokens.

Authorization fields have application limits: state 2,048 characters, nonce 512, scope 256 and redirect URI 2,048. Repeated non-string fields are refused. Redirect URIs must match a registered HTTP(S) URL and cannot contain credentials or a fragment. BoxPilot requires explicit S256, a 43-character base64url SHA-256 challenge and a 43-128-character unreserved verifier. The verifier alphabet and S256 transformation follow [RFC 7636 sections 4.1-4.3](https://www.rfc-editor.org/rfc/rfc7636#section-4.1); the field and capacity limits are BoxPilot policy.

Password throttles retain at most 5,000 entries per configured throttle. Active blocks are never evicted to admit new callers. If every slot is blocked, an unknown caller waits until the first slot is reclaimable. This bounds memory under saturation but can temporarily delay a legitimate new password login during an attack. The throttle does not govern existing authenticated sessions. Expired retained counters are cleaned on subsequent activity; they have a fixed maximum count while idle.

## A forgotten password

Three ways back in, in the order to try them:

1. **A recovery code.** On the sign-in page, choose to use a recovery code and enter one you saved when you made them (Settings, Account & sign-in). Each code works once.
2. **A passkey.** If you added one, sign in with it from the sign-in page.
3. **The server's own console.** When you have neither, or you are in but still need a new password (changing it in Settings asks for the old one), set a new one on the server itself, as root:

   ```
   sudo /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs reset-password <user name>
   ```

   It asks for the new password twice without showing it. The password must be 12 to 256 characters. For a script, add `--password-stdin` and send the password on standard input; without that flag the command refuses to run away from a terminal.

The command works for any account, the owner's or a member's. It ends every session of that account, forgets the browsers it had marked as trusted, clears the wrong guesses counted against it so the new password works at once, and writes `auth.password.reset-from-console` to the audit log. It prints one line saying what it did. A name that is not an account gets "No such account. Nothing was changed." and nothing else. It must be run as root and it opens the database as the database's own user, so no file changes owner. Passkeys and recovery codes are left as they were; remove or remake them in Settings if you no longer trust them.

For a member who forgot theirs, the owner does not need the console: the owner can set a new password for them from People, which ends that member's sessions.

## Application configuration

An app's Compose tab shows declared public environment values and masks private or undeclared `.env` entries. Password fields are always private, including a manifest that mistakenly specifies `secret: false`. The complete Compose file may contain credentials placed there by a manual edit. Read Compose file uses the audited `app.compose.inspect` operation, requires the owner and accepts a password already given in the last few minutes. Otherwise the tab asks for the owner password. Editing remains available after reading the file.

Configuration reads accept only the catalog app id, use fixed filenames, reject symlinks and non-regular files, and stop at 64 KiB. Closing the sheet aborts its request and clears the displayed file and password. New Compose edits use temporary secret parameters with the same approval expiry and restart behavior as passwords, so the raw file is not stored in new job parameters. Previously recorded edits and existing backups are not rewritten by this change.

Private application-backup inventories, machine-snapshot lists and model names/sizes require an operator. Aggregate backup counts and declared public settings remain viewer-readable.
