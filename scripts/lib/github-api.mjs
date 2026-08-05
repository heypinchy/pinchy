/**
 * The thinnest possible GitHub API client for the triage scripts.
 *
 * Deliberately not the `gh` CLI: these run in Actions where a token is already
 * in the environment, and a fetch keeps the failure modes visible (a non-2xx
 * throws with the body) instead of buried in a subprocess's stderr.
 */

const API_ROOT = "https://api.github.com";

function token() {
  const value = process.env.GITHUB_TOKEN;
  if (!value) {
    throw new Error(
      "GITHUB_TOKEN is not set — the triage scripts need it to reach the API",
    );
  }
  return value;
}

/** Owner and repo name, from Actions' own environment. */
export function currentRepo() {
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug?.includes("/")) {
    throw new Error(
      `GITHUB_REPOSITORY is missing or malformed: ${slug ?? "(unset)"}`,
    );
  }
  const [owner, name] = slug.split("/");
  return { owner, name };
}

async function request(path, init = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

/** Runs a GraphQL query and returns the raw JSON envelope (errors included). */
export async function graphql(query, variables) {
  const { ok, status, body } = await request("/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });

  if (!ok) {
    throw new Error(`GitHub GraphQL request failed (HTTP ${status}): ${body}`);
  }
  return JSON.parse(body);
}

/**
 * Creates a label, treating "already exists" as success.
 *
 * Keeping this in code rather than as a one-off manual step means a fresh
 * fork or a restored repo gets the label the workflow depends on without
 * anyone remembering to click it.
 */
export async function ensureLabel({ owner, name }, label) {
  const { ok, status, body } = await request(`/repos/${owner}/${name}/labels`, {
    method: "POST",
    body: JSON.stringify(label),
  });

  // 422 is GitHub's "already_exists" for labels.
  if (!ok && status !== 422) {
    throw new Error(
      `Could not create label "${label.name}" (HTTP ${status}): ${body}`,
    );
  }
}

export async function addLabels({ owner, name }, issueNumber, labels) {
  // The caller's number originates in a webhook payload read off disk, so it
  // reaches this path as untrusted input. parseIssueEvent already rejects a
  // non-integer, but the function that builds the URL should not depend on
  // that: anything but a positive integer here would let the payload steer
  // the request path.
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `Refusing to build a request path for issue "${issueNumber}"`,
    );
  }

  const { ok, status, body } = await request(
    `/repos/${owner}/${name}/issues/${number}/labels`,
    { method: "POST", body: JSON.stringify({ labels }) },
  );

  if (!ok) {
    throw new Error(
      `Could not label issue #${number} (HTTP ${status}): ${body}`,
    );
  }
}

/** The repo roles that can push. `triage` manages issues but cannot write. */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Every value the permission API's `permission` field may take.
 *
 * We read that field rather than the neighbouring `role_name` deliberately:
 * `permission` is the collapsed *base* permission, so an org's CUSTOM role
 * arrives as the role it inherits instead of as a name this set has never
 * heard of. `maintain` and `triage` are listed because the field may stop
 * collapsing them; measured on 2026-08-05 they arrive as `write` and `read`.
 *
 * An unrecognised value THROWS, for the same reason a failed lookup does. A
 * renamed or absent field parses fine and yields `undefined`, which set
 * membership answers "cannot write" — every author silently demoted to
 * outsider, which is the 2026-08-05 incident reproduced with no trace of why.
 */
const KNOWN_PERMISSIONS = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);

/**
 * GitHub logins are 1–39 alphanumerics and hyphens, never leading or
 * trailing. The strictness is not decoration: these arrive from the tracker,
 * so a stranger picks them, and they go straight into a request path. Bots
 * (`x[bot]`) fail this on purpose — callers must not ask about them at all.
 *
 * Consecutive hyphens are allowed, deliberately. Today's signup rule forbids
 * them, but accounts that predate it are still around (`J--J` is real), and
 * refusing to resolve one would hold the sweep red for as long as that person
 * has an issue open — an alarm nobody can clear, which is the state this
 * whole check exists to end. Rejecting them buys no path safety: a hyphen
 * cannot steer a URL.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * Answers "may this person write to the repo?" from the permission API,
 * caching one answer per login.
 *
 * This exists because `authorAssociation` answers a different question than
 * it appears to. It is computed relative to the asking token, and an Actions
 * `GITHUB_TOKEN` cannot see a private org membership — so on 2026-08-05 the
 * sweep saw this repo's admin as CONTRIBUTOR and reported 99 of our own
 * issues as strangers waiting for a reply. This endpoint returns the
 * effective permission and does not depend on who is asking; a canary run
 * confirmed the workflow's existing `contents: read` is enough to call it.
 *
 * A failed lookup THROWS rather than answering "no write access". Guessing
 * would recreate the incident silently, which is the one outcome worth a red
 * run to avoid.
 */
export function createWriteAccessResolver({ owner, name }) {
  const answers = new Map();

  return async function hasWriteAccess(login) {
    if (typeof login !== "string" || !LOGIN.test(login)) {
      throw new Error(`Refusing to build a request path for login "${login}"`);
    }
    if (answers.has(login)) return answers.get(login);

    const { ok, status, body } = await request(
      `/repos/${owner}/${name}/collaborators/${login}/permission`,
    );

    // 404 is the honest "no such collaborator" — a deleted or renamed
    // account, which is an outsider for our purposes. Every other non-2xx is
    // us failing to ask, not an answer.
    if (!ok && status !== 404) {
      throw new Error(
        `Could not read repo permission for @${login} (HTTP ${status}): ${body}`,
      );
    }

    let permission = "none";
    if (ok) {
      try {
        permission = JSON.parse(body).permission;
      } catch {
        throw new Error(
          `Could not read repo permission for @${login}: unparseable response ${body}`,
        );
      }
      if (!KNOWN_PERMISSIONS.has(permission)) {
        throw new Error(
          `Could not read repo permission for @${login}: unexpected permission ${JSON.stringify(permission)} in ${body}`,
        );
      }
    }

    const answer = WRITE_PERMISSIONS.has(permission);
    answers.set(login, answer);
    return answer;
  };
}
