import * as jose from "jose";

export type LicenseType = "trial" | "paid";

export interface LicenseStatus {
  active: boolean;
  /**
   * True when the token's signature is valid but its exp has passed.
   * Lets the app tell "expired" apart from "community" (no key at all)
   * while keeping the gates closed (`active` stays false).
   */
  expired?: boolean;
  type?: LicenseType;
  org?: string;
  features: string[];
  expiresAt?: Date;
  /**
   * End of the paid period (`paidUntil` claim, epoch seconds). For paid keys
   * `exp = paidUntil + grace`; absent on keys issued before the claim existed.
   */
  paidUntilAt?: Date;
  daysRemaining?: number;
  ver: number;
  maxUsers: number;
}

const INACTIVE: LicenseStatus = { active: false, features: [], ver: 1, maxUsers: 0 };

/**
 * Authentic signature, refused by policy.
 *
 * Distinct from INACTIVE because the difference is load-bearing downstream:
 * `deriveLicenseState` reads `expired` and answers "expired" rather than
 * "community", and `effectiveVisibility` widens `restricted` to `all` in the
 * community state alone. An install that refuses its key must not thereby
 * publish agents somebody deliberately restricted — a license verdict never
 * widens access (pricing concept § 5).
 *
 * Carries no claims on purpose: the key did not expire, so nothing may print a
 * date for it. The banner's expired copy degrades to "Your license period
 * ended. Existing access restrictions remain enforced; management features are
 * locked." — which is exactly what happened.
 */
const REFUSED: LicenseStatus = { active: false, expired: true, features: [], ver: 1, maxUsers: 0 };

const ISSUER = "heypinchy.com";

/**
 * Subject reserved for the development license this repository ships (in
 * `docker-compose.dev.yml` and the dev toolbar's toggle route).
 *
 * Two rules hang off it, and together they are the fix for #1083:
 *
 *   - the development key signs licenses for this subject and no other;
 *   - the PRODUCTION key never honours it.
 *
 * The second rule is what revokes the production-signed dev token this
 * repository shipped until v0.9. That token cannot be un-published — it is in
 * the history of every clone and every fork, and it verified against the key
 * every install trusts — so revoking it has to happen here, in the validator.
 * Changing this string un-revokes it; a test pins the value for that reason.
 */
export const DEV_LICENSE_SUBJECT = "pinchy-dev";

export interface ValidateLicenseOptions {
  /**
   * Honour a license issued to `DEV_LICENSE_SUBJECT`. Only the development key
   * passes this — under the production key such a license is always inactive.
   */
  honourDevSubject?: boolean;
}

function readClaims(payload: jose.JWTPayload): Omit<LicenseStatus, "active" | "expired"> {
  const features = (payload.features as string[]) ?? [];
  const ver = typeof payload.ver === "number" ? payload.ver : 1;
  const maxUsers = typeof payload.maxUsers === "number" ? payload.maxUsers : 0;

  if (ver > 1) {
    console.warn(
      `License token has ver=${ver}, this app understands up to ver=1. Unknown fields ignored.`
    );
  }

  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : undefined;
  const paidUntilAt =
    typeof payload.paidUntil === "number" ? new Date(payload.paidUntil * 1000) : undefined;
  const now = new Date();
  const daysRemaining = expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 86400000))
    : undefined;

  return {
    type: payload.type as LicenseType | undefined,
    org: payload.sub,
    features,
    expiresAt,
    paidUntilAt,
    daysRemaining,
    ver,
    maxUsers,
  };
}

/**
 * Whether this key refuses these claims outright — checked on the valid and
 * the expired path alike, so a dev license past its exp is refused under the
 * production key too rather than surfacing its claims.
 */
function refused(
  claims: Omit<LicenseStatus, "active" | "expired">,
  options: ValidateLicenseOptions
): boolean {
  return claims.org === DEV_LICENSE_SUBJECT && !options.honourDevSubject;
}

/**
 * Validate a JWT license token against a public key.
 * Pure function — no side effects, no caching.
 */
export async function validateLicense(
  token: string,
  publicKeyPem: string,
  options: ValidateLicenseOptions = {}
): Promise<LicenseStatus> {
  if (!token) return INACTIVE;

  try {
    const publicKey = await jose.importSPKI(publicKeyPem, "ES256");
    const { payload } = await jose.jwtVerify(token, publicKey, {
      issuer: ISSUER,
    });

    const claims = readClaims(payload);
    if (!claims.features.includes("enterprise")) return INACTIVE;
    if (refused(claims, options)) return REFUSED;

    return { active: true, ...claims };
  } catch (err) {
    // jose verifies the signature before validating claims, so a JWTExpired
    // error proves the token is authentic — only exp has passed. Preserve the
    // claims so the app can distinguish "expired" from "community", but
    // re-check the claims jose may not have reached before throwing.
    if (err instanceof jose.errors.JWTExpired) {
      const payload = jose.decodeJwt(token);
      if (payload.iss !== ISSUER) return INACTIVE;
      const claims = readClaims(payload);
      if (!claims.features.includes("enterprise")) return INACTIVE;
      if (refused(claims, options)) return REFUSED;
      return { active: false, expired: true, ...claims };
    }
    return INACTIVE;
  }
}
