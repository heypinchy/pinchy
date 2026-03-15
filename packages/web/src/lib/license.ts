import * as jose from "jose";

export type LicenseType = "trial" | "paid";

export interface LicenseStatus {
  active: boolean;
  type?: LicenseType;
  org?: string;
  features: string[];
  expiresAt?: Date;
  daysRemaining?: number;
}

const INACTIVE: LicenseStatus = { active: false, features: [] };

/**
 * Validate a JWT license token against a public key.
 * Pure function — no side effects, no caching.
 */
export async function validateLicense(token: string, publicKeyPem: string): Promise<LicenseStatus> {
  if (!token) return INACTIVE;

  try {
    const publicKey = await jose.importSPKI(publicKeyPem, "ES256");
    const { payload } = await jose.jwtVerify(token, publicKey, {
      issuer: "heypinchy.com",
    });

    const features = (payload.features as string[]) ?? [];
    if (!features.includes("enterprise")) return INACTIVE;

    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : undefined;
    const now = new Date();
    const daysRemaining = expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 86400000))
      : undefined;

    return {
      active: true,
      type: payload.type as LicenseType | undefined,
      org: payload.sub,
      features,
      expiresAt,
      daysRemaining,
    };
  } catch {
    return INACTIVE;
  }
}
