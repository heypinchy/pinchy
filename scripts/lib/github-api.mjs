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
  const { ok, status, body } = await request(
    `/repos/${owner}/${name}/issues/${issueNumber}/labels`,
    { method: "POST", body: JSON.stringify({ labels }) },
  );

  if (!ok) {
    throw new Error(
      `Could not label issue #${issueNumber} (HTTP ${status}): ${body}`,
    );
  }
}
