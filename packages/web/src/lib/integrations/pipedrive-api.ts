/**
 * Pipedrive API base URL resolver.
 *
 * Defaults to the production Pipedrive API. In E2E test environments, set
 * `PIPEDRIVE_API_URL` to point at the mock server (e.g. http://pipedrive-mock:8080).
 *
 * Resolved lazily on each call so tests can override the env var at runtime.
 */
export function getPipedriveBaseUrl(): string {
  return process.env.PIPEDRIVE_API_URL || "https://api.pipedrive.com";
}
