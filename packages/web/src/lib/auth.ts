import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { NextAuthConfig } from "next-auth";
import { appendAuditLog } from "@/lib/audit";

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db),
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await db.query.users.findFirst({
          where: eq(users.email, credentials.email as string),
        });

        if (!user || !user.passwordHash) {
          appendAuditLog({
            actorType: "system",
            actorId: "system",
            eventType: "auth.failed",
            detail: { email: credentials.email as string, reason: "user_not_found" },
          }).catch(() => {});
          return null;
        }

        const isValid = await bcrypt.compare(credentials.password as string, user.passwordHash);

        if (!isValid) {
          appendAuditLog({
            actorType: "system",
            actorId: "system",
            eventType: "auth.failed",
            detail: { email: credentials.email as string, reason: "invalid_password" },
          }).catch(() => {});
          return null;
        }

        appendAuditLog({
          actorType: "user",
          actorId: user.id,
          eventType: "auth.login",
          detail: { email: user.email },
        }).catch(() => {});
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (token?.sub) {
        await appendAuditLog({
          actorType: "user",
          actorId: token.sub,
          eventType: "auth.logout",
          detail: {},
        }).catch(() => {});
      }
    },
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.role = (token.role as string) ?? "user";
        session.user.id = token.sub!;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
