/**
 * Conversion link targets and UTM vocabulary from the pricing concept (§ 6).
 *
 * D-011 zero-telemetry: every link is passive and fully static. The UTM
 * params identify the in-app SURFACE, never the instance or user. Adding a
 * dynamic value here would violate the concept — don't.
 */

export const PRICING_URL = "https://heypinchy.com/pricing";
export const PRICING_TRIAL_URL = "https://heypinchy.com/pricing#trial";
/** Odoo resolves the trailing product id, so this survives the Pro-10 rename. */
export const BUY_PRO_URL = "https://buy.heypinchy.com/shop/pinchy-pro-5";
/** Odoo customer portal — renewal keys are delivered there and by email. */
export const PORTAL_URL = "https://buy.heypinchy.com/my";
export const SALES_MAILTO = "mailto:sales@heypinchy.com?subject=Pinchy%20seats%20quote%20request";
export const CALENDLY_URL = "https://calendly.com/clemenshelm/pinchy-demo";

/** In-app UTM mediums (§ 6 vocabulary — do not invent new values). */
export type UtmMedium =
  | "cliff-modal"
  | "trial-banner"
  | "expired-banner"
  | "seat-limit-banner"
  | "seat-limit-modal"
  | "settings-license";

/** In-app UTM campaigns (§ 6 vocabulary — feature cliffs and the one SKU). */
export type UtmCampaign =
  | "groups"
  | "visibility"
  | "analytics"
  | "csv-export"
  | "seat-limit"
  | "pro-10";

/**
 * Append the static UTM triple to a target URL, keeping any #fragment
 * after the query string (e.g. /pricing#trial).
 */
export function conversionLink(url: string, medium: UtmMedium, campaign: UtmCampaign): string {
  const [base, fragment] = url.split("#");
  const separator = base.includes("?") ? "&" : "?";
  const utm = `utm_source=pinchy-app&utm_medium=${medium}&utm_campaign=${campaign}`;
  return `${base}${separator}${utm}${fragment ? `#${fragment}` : ""}`;
}
