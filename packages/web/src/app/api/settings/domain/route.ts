import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getSetting } from "@/lib/settings";
import { setDomainAndRefreshCache, deleteDomainAndRefreshCache } from "@/lib/domain";
import { appendAuditLog } from "@/lib/audit";

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

  const domain = req.headers.get("x-forwarded-host") || req.headers.get("host");

  if (!domain) {
    return NextResponse.json(
      { error: "Could not determine hostname from request." },
      { status: 400 }
    );
  }

  const previousDomain = await getSetting("domain");
  await setDomainAndRefreshCache(domain);

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "settings.updated",
    resource: "settings:domain",
    detail: {
      changes: { domain: { from: previousDomain, to: domain } },
    },
  }).catch(() => {});

  // Schedule a restart so useSecureCookies picks up the new domain
  setTimeout(() => {
    console.log("Restarting to apply domain lock security settings...");
    process.exit(0);
  }, 500);

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

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "settings.updated",
    resource: "settings:domain",
    detail: {
      changes: { domain: { from: previousDomain, to: null } },
    },
  }).catch(() => {});

  // Schedule a restart so useSecureCookies picks up the removed domain
  setTimeout(() => {
    console.log("Restarting to apply domain unlock security settings...");
    process.exit(0);
  }, 500);

  return NextResponse.json({ removed: true, restart: true });
}

export async function GET(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const domain = await getSetting("domain");
  const currentHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const isHttps = req.headers.get("x-forwarded-proto") === "https";

  return NextResponse.json({ domain, currentHost, isHttps });
}
