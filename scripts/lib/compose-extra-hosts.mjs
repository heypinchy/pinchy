/**
 * Does Pinchy resolve a hostname the way OpenClaw does?
 *
 * Pinchy checks a stored Odoo URL or mail host before handing it to a plugin
 * (`lib/integrations/stored-destination.ts`): it resolves the name and refuses
 * internal addresses. The plugin then connects from the OpenClaw container. If
 * the two containers resolve the name differently, the check judged an address
 * the connection never goes to.
 *
 * That is not hypothetical. Compose gave OpenClaw `ollama.local:host-gateway`
 * and gave Pinchy nothing, so an Odoo URL of `http://ollama.local:8069` did not
 * resolve in Pinchy — which the guard deliberately treats as "allowed" (a DNS
 * blip must not break agents) — and pinchy-odoo then connected to the Docker
 * host. Every `extra_hosts` entry OpenClaw has, Pinchy needs too.
 *
 * The scan is a line reader, not a YAML parser, like the other compose guards
 * here (no dependency). It **throws** on a shape it cannot read rather than
 * skipping it: a guard that only reports on the lines it understands is not a
 * guard. That includes `!override` / `!reset` on `extra_hosts`, because those
 * break the one property that makes per-file checking sound (see
 * {@link resolverViewDrift}).
 */

/** Which of the two containers a compose service is, by name. */
export function serviceRole(name) {
  // `pinchy` / `openclaw` in compose; `$$cap_appname-pinchy` on CapRover.
  if (name === "pinchy" || name.endsWith("-pinchy")) return "pinchy";
  if (name === "openclaw" || name.endsWith("-openclaw")) return "openclaw";
  return null;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trim().startsWith("#");
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * `ollama.local:host-gateway`, `ollama.local=host-gateway` and the map form
 * `ollama.local: host-gateway` all mean the same mapping; compare them as one.
 * Split at the FIRST separator, since an IPv6 address carries colons of its own.
 */
export function normalizeHostEntry(raw, where) {
  const entry = unquote(raw);
  const match = /^([^:=\s]+)\s*[:=]\s*(\S+)$/.exec(entry);
  if (!match)
    throw new Error(
      `${where}: cannot read extra_hosts entry ${JSON.stringify(raw)}`,
    );
  return `${match[1]}=${unquote(match[2])}`;
}

/**
 * Every service a compose file defines, with its `extra_hosts` entries
 * (normalized, see {@link normalizeHostEntry}). A service without the key maps
 * to an empty list.
 *
 * @param {string} text
 * @param {string} file  used in error messages only
 * @returns {Map<string, string[]>}
 */
export function parseServiceExtraHosts(text, file) {
  const lines = text.split("\n");
  const services = new Map();
  const start = lines.findIndex((line) => /^services:\s*(#.*)?$/.test(line));
  if (start === -1) return services;

  let serviceIndent = null;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break; // next top-level key: `volumes:`, `networks:`, …

    serviceIndent ??= indent;
    if (indent === serviceIndent) {
      const name = /^\s*([^\s:#][^:]*):\s*(#.*)?$/.exec(line);
      if (!name)
        throw new Error(
          `${file}:${i + 1}: cannot read service name in ${line.trim()}`,
        );
      current = name[1];
      services.set(current, []);
      continue;
    }
    if (indent < serviceIndent) {
      throw new Error(
        `${file}:${i + 1}: unexpected indentation under services:`,
      );
    }

    const key = /^\s*extra_hosts:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!key || current === null) continue;
    const where = `${file}:${i + 1} (${current})`;
    if (key[1] !== "") {
      // `!override` / `!reset` replace instead of merge, and an inline flow
      // list is a shape this reader does not parse. Either way: say so.
      throw new Error(`${where}: unsupported extra_hosts form "${key[1]}"`);
    }

    const keyIndent = indent;
    for (i = i + 1; i < lines.length; i++) {
      const entry = lines[i];
      if (isSkippable(entry)) continue;
      if (indentOf(entry) <= keyIndent) {
        i--;
        break;
      }
      const body = entry.trim().replace(/\s+#.*$/, "");
      const listItem = /^-\s+(.+)$/.exec(body);
      services
        .get(current)
        .push(normalizeHostEntry(listItem ? listItem[1] : body, where));
    }
  }
  return services;
}

/**
 * The `extra_hosts` entries of the pinchy and openclaw services in one file,
 * or `null` for a role the file does not define.
 */
export function extraHostsByRole(text, file) {
  const byRole = { pinchy: null, openclaw: null };
  for (const [name, entries] of parseServiceExtraHosts(text, file)) {
    const role = serviceRole(name);
    if (role === null) continue;
    if (byRole[role] !== null)
      throw new Error(`${file}: more than one ${role} service`);
    byRole[role] = entries;
  }
  return byRole;
}

/**
 * Every OpenClaw `extra_hosts` entry that Pinchy lacks.
 *
 * - `base` (docker-compose.yml) and each `standalone` file (a deploy template
 *   that is not layered on anything) are checked on their own.
 * - Each `overlay` is checked as Compose would merge it onto `base`: entries
 *   are a union. Checking every overlay against the base alone is enough for
 *   any stack combining several overlays, because a union of files that each
 *   satisfy "OpenClaw's additions ⊆ Pinchy's (base ∪ own)" satisfies it too —
 *   which only holds while no overlay REPLACES the list, hence the throw on
 *   `!override` / `!reset` in {@link parseServiceExtraHosts}.
 *
 * `exemptions` are `{ file, entry, reason }`; an exemption that matches no
 * OpenClaw entry is reported as stale, so a reason cannot outlive its case.
 *
 * @returns {{ missing: Array<{file: string, entry: string}>, stale: Array<{file: string, entry: string}> }}
 */
export function resolverViewDrift({
  base,
  overlays = [],
  standalone = [],
  exemptions = [],
}) {
  const baseRoles = extraHostsByRole(base.text, base.file);
  const checks = [
    { file: base.file, roles: baseRoles },
    ...standalone.map(({ file, text }) => ({
      file,
      roles: extraHostsByRole(text, file),
    })),
    ...overlays.map(({ file, text }) => {
      const own = extraHostsByRole(text, file);
      return {
        file,
        roles: {
          pinchy: [...(baseRoles.pinchy ?? []), ...(own.pinchy ?? [])],
          openclaw: [...(baseRoles.openclaw ?? []), ...(own.openclaw ?? [])],
        },
      };
    }),
  ];

  const missing = [];
  const used = new Set();
  for (const { file, roles } of checks) {
    const pinchy = new Set(roles.pinchy ?? []);
    for (const entry of new Set(roles.openclaw ?? [])) {
      if (pinchy.has(entry)) continue;
      const exemption = exemptions.find(
        (e) => e.file === file && e.entry === entry,
      );
      if (exemption) {
        used.add(exemption);
        continue;
      }
      missing.push({ file, entry });
    }
  }
  const stale = exemptions
    .filter((e) => !used.has(e))
    .map(({ file, entry }) => ({ file, entry }));
  return { missing, stale };
}
