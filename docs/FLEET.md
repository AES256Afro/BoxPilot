# Signed fleet agents

BoxPilot `0.22.0` introduced the first deliberately narrow fleet slice. Version `0.28.0` added an owner-approved one-shot scheduling policy for the Pi-hole proof. Version `0.37.0` adds a second task contract for Flint 2 observed-gateway DNS evidence. A separately enrolled LAN device can collect either proof without giving the BoxPilot controller a shell, package manager, filesystem browser, arbitrary network probe, recurring scheduler, or unattended executor.

## What ships

- Owner-password reauthentication before a ten-minute enrollment token is created
- A random 256-bit enrollment token stored by BoxPilot only as a SHA-256 digest
- A device-generated Ed25519 keypair whose private key never leaves that device
- Signed controller requests with a five-minute timestamp window and strictly increasing sequence numbers
- Agent revocation that rejects future requests and expires pending tasks
- Two task contracts: `dns.pi-hole.acceptance.v1` and `dns.flint2-adguard.acceptance.v1`
- Owner-password reauthentication before every task window
- Only three dispatch choices: immediate, 5 minutes, or 10 minutes
- An exact ten-minute execution window with no recurrence or unattended retry
- Four fixed A-record checks against the exact resolver from a fresh matching Bigbox acceptance record
- A fixed Linux or macOS local-default-gateway read for Flint 2 tasks; the agent rejects any mismatch
- Durable task and signed evidence records in SQLite

There is no remote shell, arbitrary command, operator-provided probe target, plugin download, router credential, router write, DHCP change, client DNS change, firewall change, or Tailscale change.

## Enroll a device

1. Sign in to BoxPilot and open **Fleet**.
2. Enter a device label and your BoxPilot owner password.
3. Select **Create 10-minute token**.
4. From a trusted BoxPilot checkout on the second device, install the locked dependencies:

   ```sh
   npm ci
   ```

5. Run the exact enrollment command shown by BoxPilot. It has this form:

   ```sh
   npm run agent -- enroll --controller https://bigbox.example-tailnet.ts.net --token ONE_TIME_TOKEN --name second-lan-device
   ```

The agent creates `~/.config/boxpilot-agent/agent.json` with mode `0600`. That file contains the Ed25519 private key. Do not copy it to Bigbox, GitHub, a support bundle, or another device. Enrollment fails closed if the token expires, is reused, requests another capability, or supplies a non-Ed25519 public key.

## Collect independent DNS evidence

The Fleet page can schedule a one-shot task only when all of these are true:

- The agent is active and has the fixed `dns-probe-v1` capability.
- The selected Pi-hole or Flint 2 path has a passing direct Bigbox acceptance record.
- That controller record is no more than 30 minutes old.
- The selected agent has no other pending DNS probe.
- The owner password is re-entered for this task.
- The selected delay is exactly 0, 5, or 10 minutes.
- The controller proof will still be no more than 30 minutes old when the window opens.

Choose **Managed Pi-hole** or **Flint 2 observed gateway**, choose the delay, and schedule the task. Then run this on the enrolled device during the displayed ten-minute window:

```sh
npm run agent -- run-once
```

The agent first authenticates a poll. It rejects any task that changes the schema, resolver source, four fixed names, protocols, port 53, expected response codes, or the explicit no-command and no-cutover boundary.

For managed Pi-hole it performs:

1. `pi.hole` A over UDP
2. `pi.hole` A over TCP
3. `example.com` A over UDP
4. `boxpilot.invalid` A over UDP, expecting NXDOMAIN

For Flint 2 it first runs one fixed local route read: `ip -j -4 route show default` on Linux or `route -n get default` on macOS. Exactly one IPv4 default gateway must exist and it must equal the fresh controller acceptance target. It then performs:

1. `example.com` A over UDP
2. `example.com` A over TCP
3. `example.net` A over UDP
4. `boxpilot.invalid` A over UDP, expecting NXDOMAIN

Before the window opens, signed polls return no task. The result is signed and submitted with a new sequence number. Failed checks are recorded as failed evidence instead of being converted into a passing claim. The task expires at the end of its exact window. There is no recurrence, catch-up execution, automatic retry, user-supplied schedule, or background agent service in `0.37.0`.

## What a passing result proves

A passing Pi-hole result proves that the enrolled device could directly reach the exact managed Pi-hole resolver and complete the four fixed checks during the task window. A passing Flint 2 result proves that the enrolled device had one local default gateway matching the fresh Bigbox target and could complete the four fixed queries against it during the window.

Neither result remotely attests the device, router model, AdGuard Home configuration, filters, DHCP advertisement, use by every client, or fallback recovery. The signed record proves which enrolled key submitted the evidence and that the current allowlisted agent contract was used; it is not hardware attestation.

Version `0.37.0` still has no router mutation or DNS cutover route. Router Center provides fixed-model guidance, gateway-address correlation, controller evidence, and linked signed second-device evidence, but physical model identity and device state remain operator checks. A future router mutation still needs exact model and firmware discovery, a restorable configuration checkpoint, a bounded proposed diff, explicit approval, an observation window, and a tested rollback adapter.

## Recovery and revocation

- If the controller is unavailable, no task runs and the device continues operating normally.
- If a request is delayed more than five minutes or its sequence is reused, BoxPilot rejects it.
- If the device key may be exposed, revoke the agent in BoxPilot and enroll it again with a fresh keypair.
- Deleting the local agent configuration destroys that device's private identity. Revoke the old agent before replacing it.
- A controller database backup contains public keys, token digests, tasks, and signed evidence. It does not contain agent private keys.

## Remaining fleet milestones

- Automated, packaged agent installation and a documented timer or service
- Multiple BoxPilot controller nodes and central inventory
- Signed adapter packages with compatibility and privilege declarations
- Broader scheduled maintenance and notifications beyond the one fixed proof
- Exportable disaster-recovery kits
- GitHub release discovery and verified adapter provenance

These later capabilities must retain node-local approval and cannot widen the controller into unrestricted shell access.
