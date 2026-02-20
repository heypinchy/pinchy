import postgres from "postgres";
import { execSync } from "child_process";

const ADMIN_URL = "postgresql://pinchy:pinchy_dev@localhost:5432/postgres";
const TEST_DB = "pinchy_test";
const TEST_DB_URL = `postgresql://pinchy:pinchy_dev@localhost:5432/${TEST_DB}`;

export default async function globalSetup() {
  const sql = postgres(ADMIN_URL);

  // Drop if leftover from previous failed run
  await sql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE ${TEST_DB}`);
  await sql.end();

  // Run Drizzle migrations against test DB
  execSync("pnpm db:migrate", {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: "inherit",
  });
}
