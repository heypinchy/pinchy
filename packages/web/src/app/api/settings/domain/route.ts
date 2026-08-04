import { NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getSetting } from "@/lib/settings";
import { setDomainAndRefreshCache, deleteDomainAndRefreshCache } from "@/lib/domain";
import { appendAuditLog } from "@/lib/audit";
import { readRequestHostFromHeaders } from "@/server/forwarded-host";
import { isValidLockableHost } from "@/lib/domain-validation";

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const proto = req.headers.get("x-forwarded-proto");
  if (proto !== "https") {
    return NextResponse.json(
      { error: "Domain lock requires HTTPS. Access this page over HTTPS to lock the domain." },
      { status: 400 }
    );
  }

  // Public hop only: behind chained proxies `X-Forwarded-Host` arrives as
  // "public.example.com, internal:7777", and storing that verbatim locks the
  // instance to a name no browser can send — the exact lockout this flow
  // exists to make impossible.
  const domain = readRequestHostFromHeaders(req.headers);

  if (!domain) {
    return NextResponse.json(
      { error: "Could not determine hostname from request." },
      { status: 400 }
    );
  }

  // The resolved host is client-influenced (X-Forwarded-Host, unless a
  // trusted proxy strips it before we see it) and gets stored verbatim as the
  // locked domain — then rendered into the Access Denied page every
  // unauthenticated visitor with a mismatched Host header is served. Reject
  // anything that isn't a plausible Host value before it is ever persisted.
  if (!isValidLockableHost(domain)) {
    return NextResponse.json({ error: `"${domain}" is not a valid domain name.` }, { status: 400 });
  }

  const previousDomain = await getSetting("domain");
  await setDomainAndRefreshCache(domain);

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.updated",
      resource: "settings:domain",
      detail: {
        changes: { domain: { from: previousDomain, to: domain } },
      },
      outcome: "success",
    })
  );

  if (process.env.PINCHY_E2E_DISABLE_DOMAIN_RESTART !== "1") {
    // Schedule a restart so useSecureCookies picks up the new domain.
    setTimeout(() => {
      console.log("Restarting to apply domain lock security settings...");
      process.exit(0);
    }, 500);
  }

  return NextResponse.json({ domain, restart: true });
}

export async function DELETE(_req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const previousDomain = await getSetting("domain");
  if (!previousDomain) {
    return NextResponse.json({ error: "No domain is locked" }, { status: 400 });
  }

  await deleteDomainAndRefreshCache();

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.updated",
      resource: "settings:domain",
      detail: {
        changes: { domain: { from: previousDomain, to: null } },
      },
      outcome: "success",
    })
  );

  if (process.env.PINCHY_E2E_DISABLE_DOMAIN_RESTART !== "1") {
    // Schedule a restart so useSecureCookies picks up the removed domain.
    setTimeout(() => {
      console.log("Restarting to apply domain unlock security settings...");
      process.exit(0);
    }, 500);
  }

  return NextResponse.json({ removed: true, restart: true });
}

export async function GET(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const domain = await getSetting("domain");
  const currentHost = readRequestHostFromHeaders(req.headers) ?? null;
  const isHttps = req.headers.get("x-forwarded-proto") === "https";

  return NextResponse.json({ domain, currentHost, isHttps });
}
