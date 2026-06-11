// Host-side connection URL for a compose-stack PostgreSQL (the DB behind
// docker-compose.yml's ${DB_PASSWORD:-pinchy_dev} interpolation).
//
// CI's production-image stack jobs set DB_PASSWORD because the server
// fail-closes on the default password in production (#156) — helpers that
// connect from the host must use the same value the stack was initialized
// with. Local runs without DB_PASSWORD keep the dev default.
export function stackDbUrl(port: number, db = "pinchy"): string {
  const password = process.env.DB_PASSWORD || "pinchy_dev";
  return `postgresql://pinchy:${encodeURIComponent(password)}@localhost:${port}/${db}`;
}
