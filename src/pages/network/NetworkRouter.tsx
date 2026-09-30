import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { inspectOperation } from "../../operations";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, SecretInput, Sheet, StatusChip, Table, Tag, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";

/*
 * The Network page's Router tab (M33.10): the router as a source of truth about the network, what
 * it has handed addresses to and what it calls those devices. Reading only: writing to a router can
 * take a house off the internet, and that path is not offered until it has been exercised against a
 * real device. Connecting stores the router's password on this server, readable only by root.
 */

interface RouterReport {
  configured: boolean;
  reachable: boolean;
  host: string | null;
  username: string | null;
  model?: string | null;
  firmware?: string | null;
  reason: string | null;
}
interface Lease { name: string | null; address: string; mac: string | null; online: boolean; reserved: boolean }

export interface NetworkRouterProps {
  gateway: string | null;
  role: string;
  start: (operation: PendingOperation) => void;
  refreshKey: number;
}

const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
const usernamePattern = /^[A-Za-z0-9._-]{1,64}$/;

export function NetworkRouter({ gateway, role, start, refreshKey }: NetworkRouterProps) {
  const canRead = role === "owner" || role === "operator";
  const canConnect = mayStart(role, "router.connect");
  const [report, setReport] = useState<RouterReport | null>(null);
  const [leases, setLeases] = useState<Lease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [host, setHost] = useState("");
  // The router's own login page asks for a password and nothing else, so this does too. The
  // account is root; the field is there for a router that genuinely asks for a different one.
  const [username, setUsername] = useState("");
  const [namedAccount, setNamedAccount] = useState(false);
  const [password, setPassword] = useState("");

  const refresh = useCallback(async () => {
    if (!canRead) return;
    try {
      const { result } = await inspectOperation<RouterReport>("router.inspect");
      setReport(result);
      setError(null);
      if (result.reachable) {
        const listed = await inspectOperation<{ leases: Lease[] }>("router.leases").catch(() => null);
        setLeases(listed?.result.leases ?? null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The router connection could not be read");
    }
  }, [canRead]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => { if (gateway && !host) setHost(gateway); }, [gateway, host]);

  if (!canRead) return <Notice tone="info" title="Reading the router needs an operator">Its device list names everything on your network, so an owner or operator reads it.</Notice>;

  // An empty box still means root: opening the field must not become a new way to be stuck.
  const namedAccountOk = !username.trim() || usernamePattern.test(username.trim());
  const ready = hostPattern.test(host.trim()) && password.length > 0 && namedAccountOk;
  const missing = !host.trim() ? "Enter the router's address." : !hostPattern.test(host.trim()) ? "That is not an address or a name." : !password ? "Enter the router's admin password." : !namedAccountOk ? "That username has a character the router will not accept." : null;

  const connect = () => {
    if (!ready) return;
    const target = host.trim();
    // The sheet closes before the approval opens, and the password leaves the page's memory with it.
    setConnecting(false);
    start({
      operationId: "router.connect",
      title: `Connect to the router at ${target}`,
      parameters: { kind: "glinet", host: target, ...(namedAccount && username.trim() ? { username: username.trim() } : {}), password },
      preview: <span>Signs in once to check the password, then stores it on this server readable only by root, and records the certificate the router presented so a different one is refused later. Nothing on the router is changed.</span>,
    });
    setPassword("");
  };

  const leaseColumns: Array<TableColumn<Lease>> = [
    { id: "name", header: "Device", sortValue: (lease) => lease.name ?? "", cell: (lease) => <span className="network-node">{lease.name ? <span className="network-strong">{lease.name}</span> : <span className="network-dim">unnamed</span>}{!lease.online && <Tag>offline</Tag>}</span> },
    { id: "address", header: "Address", sortValue: (lease) => lease.address, cell: (lease) => <code>{lease.address}</code> },
    { id: "mac", header: "MAC", hideOnPhone: true, cell: (lease) => (lease.mac ? <code className="network-dim">{lease.mac}</code> : "—") },
    { id: "reserved", header: "Address is", sortValue: (lease) => (lease.reserved ? 0 : 1), cell: (lease) => <StatusChip status={lease.reserved ? "good" : "neutral"}>{lease.reserved ? "reserved" : "from the pool"}</StatusChip> },
  ];

  const connectButton = (label: string) => (canConnect ? <Button variant="primary" onClick={() => setConnecting(true)}>{label}</Button> : undefined);
  const connected = Boolean(report?.configured && report.reachable);

  return (
    <>
      {error && <Notice tone="danger" live title="The router connection could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      {report?.configured && !report.reachable && (
        <Notice tone="danger" title="The router is not answering" action={connectButton("Connect again…")}>
          Connected to <code>{report.host}</code> before, but it is not answering now: {report.reason}
        </Notice>
      )}

      <Panel
        padded={Boolean(report?.configured)}
        className="network-router"
        title="Router"
        count={!report ? undefined : connected ? { status: "good", label: "connected" } : report.configured ? { status: "danger", label: "not answering" } : { status: "neutral", label: "not connected" }}
        meta="read only · GL.iNet firmware 4"
      >
        {!report ? <p className="network-dim network-pad">{error ? "Not read." : "Reading the router…"}</p>
          : report.configured ? (
            <KeyValue layout="columns" items={[
              { id: "host", label: "Address", value: report.host ?? "—", mono: true },
              { id: "account", label: "Account", value: report.username ?? "—", mono: true },
              { id: "model", label: "Model", value: report.model ?? "—" },
              { id: "firmware", label: "Firmware", value: report.firmware ?? "—", mono: true },
            ]} />
          ) : (
            <EmptyState title="No router connected" action={connectButton("Connect the router…")}>
              Reads the devices your router has given addresses to, and the names it knows them by. Nothing on the router is changed.
            </EmptyState>
          )}
      </Panel>

      {connected && (
        <Panel className="network-leases" title="Devices the router knows" count={leases ? leases.length : undefined} meta={leases ? `${leases.filter((lease) => lease.online).length} online · ${leases.filter((lease) => lease.reserved).length} reserved` : undefined}>
          <Table
            caption="Devices your router has given addresses to"
            columns={leaseColumns}
            rows={leases ?? []}
            rowKey={(lease) => `${lease.address}-${lease.mac ?? ""}`}
            rowStatus={(lease) => (lease.online ? "good" : "neutral")}
            empty={leases === null ? "Reading the device list…" : "The router reported no devices."}
          />
        </Panel>
      )}

      {connecting && (
        <Sheet
          kicker="Router"
          title="Connect the router"
          side="center"
          size="sm"
          onClose={() => setConnecting(false)}
          footer={<>
            {missing && <span className="network-dim network-sheet-hint">{missing}</span>}
            <Button variant="ghost" onClick={() => setConnecting(false)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("router.connect")} disabled={!ready} onClick={connect}>Connect</Button>
          </>}
        >
          <form className="network-form network-form--single" onSubmit={(event) => { event.preventDefault(); connect(); }}>
            <Field label="Router address">
              <TextInput mono placeholder="192.168.1.1" value={host} onValueChange={setHost} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Router password" hint="The one for the router's own admin page. Stored on this server readable only by root, and sent to nothing but the router.">
              <SecretInput value={password} onValueChange={setPassword} autoComplete="new-password" revealLabel="Show the password" />
            </Field>
            {namedAccount ? (
              <Field label="Username" hint="Leave it blank unless the router asked for one: the account is root.">
                <TextInput mono autoFocus placeholder="root" value={username} onValueChange={setUsername} autoComplete="off" spellCheck={false} />
              </Field>
            ) : (
              <Button variant="ghost" className="network-inline-link" onClick={() => setNamedAccount(true)}>This router asks for a username too</Button>
            )}
          </form>
        </Sheet>
      )}
    </>
  );
}
