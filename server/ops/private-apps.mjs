/**
 * Private apps (M71, ADR-019): the owner's own apps, whose source and images are private, run and
 * managed like catalog apps. Their manifests live on this server only (private-catalog.mjs), and
 * their images come from a registry the helper is signed in to (registry-auth.mjs).
 *
 * Everything that changes either is the owner's, at high risk: a manifest decides what the root
 * helper deploys, and can ask for a writable host folder, Docker's socket, a device or a capability,
 * which is root on this server whatever risk it declares. Listing the sign-ins runs in the helper and
 * shows what the caller could not read themselves, so it is an operator's at least (ADR-003).
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { defineOperation } from "./registry.mjs";
import { createPrivateCatalogStore, privateAppIdPattern, privateManifestLimit } from "../private-catalog.mjs";
import { createRegistryAuth, registryHostPattern, registryUsernamePattern } from "../registry-auth.mjs";

const minutes = (count) => count * 60_000;
const privateIdField = { type: "string", maxLength: 63, pattern: privateAppIdPattern };
const registryField = { type: "string", maxLength: 260, pattern: registryHostPattern };

const catalogOf = (privateCatalog) => privateCatalog ?? createPrivateCatalogStore();
const authOf = (registryAuth) => registryAuth ?? createRegistryAuth();

/** Why private app `id` must keep its manifest, or null: installed, or its data folder still here. */
async function stillUsed(apps, id) {
  const { applications = [] } = await apps.inspect({ id });
  const app = applications.find((entry) => entry.id === id);
  const name = app?.name ?? id;
  if (app?.installed) return `${name} is installed: uninstall it first`;
  const folder = path.join(apps.catalogRoot, id);
  if (app?.dataPresent || await lstat(folder).then(() => true, () => false)) return `${name}'s data is still on this server (${folder}): uninstall it and delete its data first`;
  return null;
}

export function privateAppOperations() {
  return [
    defineOperation({
      // high and the id typed: a manifest can give a container the whole server.
      id: "catalog.private.save", title: "Add or replace a private app", risk: "high", minimumRole: "owner", timeoutMs: minutes(1),
      confirm: (parameters) => parameters.id,
      description: "Saves an app manifest to this server's private catalog, where it is listed, installed, updated, backed up and restored like a catalog app. Its id starts with private- and its image is pinned by digest. A manifest saved before under the same id is replaced; when that app is installed, the new image is offered as an update.",
      parameters: { fields: {
        id: privateIdField,
        manifest: { type: "string", maxLength: privateManifestLimit },
      } },
      run: (parameters, { privateCatalog }) => catalogOf(privateCatalog).save({ id: parameters.id, text: parameters.manifest }),
    }),
    defineOperation({
      id: "catalog.private.remove", title: "Remove a private app", risk: "high", minimumRole: "owner", timeoutMs: minutes(1),
      confirm: (parameters) => parameters.id,
      description: "Deletes a private app's manifest from this server, once the app is uninstalled and its data deleted.",
      parameters: { fields: { id: privateIdField } },
      run: async (parameters, { privateCatalog, apps }) => {
        const problem = await stillUsed(apps, parameters.id);
        if (problem) throw new Error(problem);
        return catalogOf(privateCatalog).remove({ id: parameters.id });
      },
    }),
    defineOperation({
      // high: the token reaches the owner's private images, and is root's alone once saved.
      id: "registry.signin", title: "Sign in to a container registry", risk: "high", minimumRole: "owner", timeoutMs: minutes(2),
      description: "Checks a user name and token with a container registry (ghcr.io unless another is named) and saves them for pulling private apps' images, readable by root only. Only private apps' downloads use them. A sign-in the registry refuses is not kept, and the one saved before stays.",
      parameters: { fields: {
        registry: { ...registryField, optional: true },
        username: { type: "string", maxLength: 255, pattern: registryUsernamePattern },
        token: { type: "string", secret: true, maxLength: 4096, validate: (value) => (/^[!-~]{8,4096}$/.test(value) ? null : "must be the token the registry gave you: 8 to 4096 characters, no spaces") },
      } },
      run: (parameters, { registryAuth }) => authOf(registryAuth).signIn({ registry: parameters.registry ?? "ghcr.io", username: parameters.username, token: parameters.token }),
    }),
    defineOperation({
      id: "registry.signout", title: "Sign out of a container registry", risk: "medium", minimumRole: "owner", timeoutMs: minutes(1),
      description: "Forgets the saved sign-in for one container registry. Private apps already running keep running; downloading their images again needs a new sign-in.",
      parameters: { fields: { registry: registryField } },
      run: (parameters, { registryAuth }) => authOf(registryAuth).signOut({ registry: parameters.registry }),
    }),
    defineOperation({
      // operator (ADR-003): it reads the helper's root-only sign-ins, user names only.
      id: "registry.inspect", title: "List container registry sign-ins", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 30_000,
      description: "The container registries BoxPilot is signed in to for private apps, and the user name of each. No token is ever returned.",
      parameters: { fields: {} },
      run: async (_parameters, { registryAuth }) => ({ registries: await authOf(registryAuth).list() }),
    }),
  ];
}
