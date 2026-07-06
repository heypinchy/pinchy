import { Mail } from "lucide-react";

/**
 * IMAP has no single brand mark — unlike Google/Microsoft/Odoo/Brave, "IMAP /
 * Other email" covers arbitrary providers. A generic envelope icon (lucide's
 * Mail) stands in for the brand SVGs in integration-icons.tsx.
 */
export function ImapIcon({ className }: { className?: string }) {
  return <Mail className={className} />;
}
