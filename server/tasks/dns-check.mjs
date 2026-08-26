/**
 * Whether the DNS blocker on this server is actually being used, rather than merely installed.
 *
 * Installing Pi-hole is the easy half. The half that goes wrong is everything after: port 53 has to
 * be open to the network, the container has to be answering on the LAN address rather than only on
 * loopback, and the router has to be handing that address out. Any one of those left undone leaves
 * a blocker that looks perfectly healthy on its own page and blocks nothing for anybody.
 *
 * So this asks it the way a laptop would: send it a real query on its LAN address and see what
 * comes back. A task rather than helper work, because the helper runs with `PrivateNetwork=true`
 * and cannot make a DNS query at all.
 *
 * Nothing here changes anything. Two lookups, both harmless.
 */
import { Resolver } from "node:dns/promises";

/** A domain that exists and is reserved for exactly this, so resolving it proves upstream works. */
export const controlDomain = "example.com";
/** A domain every mainstream blocklist carries, including the one Pi-hole ships with. */
export const probeDomain = "doubleclick.net";
/**
 * Reserved for documentation (RFC 5737) and therefore guaranteed not to run a resolver. If one of
 * these answers a query, something between this server and the internet is intercepting every DNS
 * request and replying to it, which is worth knowing because it is the usual reason a recursive
 * resolver fails while a forwarding one appears fine: recursion asks the root servers directly,
 * the interceptor answers instead, and the reply does not validate.
 */
export const impossibleResolvers = ["192.0.2.1", "198.51.100.1"];

/** What a blocker answers with when it is refusing a name. */
const blockedAnswers = new Set(["0.0.0.0", "::", "::1", "127.0.0.1"]);

const addressPattern = /^\d{1,3}(\.\d{1,3}){3}$/;

function resolverFor(address, timeoutMs) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([address]);
  return resolver;
}

/**
 * Ask the blocker two questions on the address the rest of the house would use.
 *
 * The three answers are kept apart on purpose. "Nothing answered" is a firewall or a container
 * bound to loopback; "answered but resolved nothing" is a blocker with no working upstream; and
 * "answered and did not block" is a blocker whose lists are not loaded. They need different fixes,
 * and one boolean would hide which.
 */
export async function dnsBlockerVerify({ address, timeoutMs = 4000, checkInterception = true } = {}, { resolve = null, resolveVia = null } = {}) {
  if (typeof address !== "string" || !addressPattern.test(address)) {
    throw new Error("A LAN address for this server is required, for example 192.168.1.10");
  }
  const lookup = resolve ?? (async (domain) => {
    const resolver = resolverFor(address, timeoutMs);
    return resolver.resolve4(domain);
  });

  const control = await lookup(controlDomain).then(
    (addresses) => ({ ok: addresses.length > 0, addresses, error: null }),
    (error) => ({ ok: false, addresses: [], error: String(error?.code ?? error?.message ?? error) }),
  );
  // A server that never answered cannot be asked the second question meaningfully.
  const answered = control.ok || !["ETIMEOUT", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(control.error ?? "");

  const probe = answered
    ? await lookup(probeDomain).then(
        (addresses) => ({ addresses, error: null }),
        (error) => ({ addresses: [], error: String(error?.code ?? error?.message ?? error) }),
      )
    : { addresses: [], error: null };

  // Asking an address that cannot possibly answer. If it does, every query leaving this network is
  // being answered by something in the middle, and no recursive resolver here can work.
  const ask = resolveVia ?? (async (server, domain) => resolverFor(server, timeoutMs).resolve4(domain));
  let intercepted = null;
  let interceptorBlocking = null;
  if (checkInterception) {
    // An answer here is proof; silence is not, because an unroutable address is exactly the sort of
    // query that gets dropped rather than refused. So each address is asked twice before it is
    // believed to be quiet, and `false` means "not seen" rather than "definitely not happening".
    const answered = async (server) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const replied = await ask(server, controlDomain).then((addresses) => addresses.length > 0, () => false);
        if (replied) return true;
      }
      return false;
    };
    const replies = await Promise.all(impossibleResolvers.map(answered));
    intercepted = replies.some(Boolean);
    // Whatever is answering may be a blocker itself, which is the difference between "your DNS is
    // hijacked and broken" and "your blocking simply lives on the router". Those want opposite
    // responses from the owner, so they are not reported as the same thing.
    if (intercepted) {
      const refused = await ask(impossibleResolvers[0], probeDomain).then(
        (addresses) => addresses.length > 0 && addresses.every((entry) => blockedAnswers.has(entry)),
        (error) => ["ENOTFOUND", "ENODATA"].includes(String(error?.code ?? "")),
      );
      interceptorBlocking = refused;
    }
  }

  // NXDOMAIN or an all-zeroes answer both mean refused; a real address means it went through.
  const blocked = answered && (probe.error === "ENOTFOUND" || probe.error === "ENODATA"
    || (probe.addresses.length > 0 && probe.addresses.every((entry) => blockedAnswers.has(entry))));

  return {
    address,
    answering: answered,
    resolving: control.ok,
    blocking: blocked,
    control: { domain: controlDomain, addresses: control.addresses, error: control.error },
    probe: { domain: probeDomain, addresses: probe.addresses, error: probe.error },
    intercepted,
    interceptorBlocking,
    reason: !answered
      ? `Nothing answered a DNS query on ${address}. Either port 53 is not open to your network, or the blocker is only listening on this server itself.`
      : intercepted && interceptorBlocking
      ? "Your network's DNS is being handled somewhere else, and whatever is handling it blocks ads too, which usually means a blocker running on the router. Nothing on your network reaches this one, so it is installed and idle. That is a perfectly good arrangement, and DNS on an always-on router survives this server rebooting. Local names for your apps are the one thing it costs you, because those are served from here."
      : intercepted && !control.ok
      ? "Something between this server and the internet is answering every DNS query itself, including ones sent to addresses that cannot run a resolver. A recursive resolver cannot work through that, which is why lookups fail, and it also means devices on your network reach that thing rather than this blocker no matter what your router hands out. The setting is usually on the router, named something like \"Override DNS Settings of All Clients\", \"Force DNS\" or \"DNS Redirect\", and routers that run a blocker of their own (AdGuard Home, for instance) often switch it on. Turn it off to use this blocker, or keep the one on the router and leave this one to the apps on this server."
      : !control.ok
      ? "It answered, but could not look up a name that exists. Its upstream resolver is not working, so every device using it would lose the internet."
      : !blocked
      ? "It answered and resolved normally, but did not refuse a domain its blocklists should cover. The lists may not have loaded yet."
      : null,
  };
}
