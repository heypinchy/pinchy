import { resetAdminPassword } from "../src/lib/reset-admin";

async function main() {
  // Parse --email argument
  let email: string | undefined;
  const emailIndex = process.argv.indexOf("--email");
  if (emailIndex !== -1 && process.argv[emailIndex + 1]) {
    email = process.argv[emailIndex + 1];
  }

  try {
    const result = await resetAdminPassword(email);
    console.log(`Admin password reset for: ${result.email}`);
    console.log(`New password: ${result.password}`);
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

main();
