import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import * as schema from "@/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.users,
    },
  }),
  emailAndPassword: {
    enabled: true,
    password: {
      // Accept legacy bcrypt hashes from pre-migration users
      verify: async ({ password, hash }) => {
        if (hash.startsWith("$2")) {
          return bcrypt.compare(password, hash);
        }
        // Return undefined to fall through to Better Auth's scrypt
        return undefined;
      },
    },
  },
  user: {
    additionalFields: {
      context: {
        type: "string",
        required: false,
      },
    },
  },
  plugins: [
    admin({
      defaultRole: "user",
    }),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
  },
});

// Type export for use in other files
export type Session = typeof auth.$Infer.Session;
