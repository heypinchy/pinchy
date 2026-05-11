import {
  FileText,
  Bot,
  TrendingUp,
  Warehouse,
  Calculator,
  Handshake,
  ShoppingCart,
  Headset,
  Scale,
  Users,
  GitCompareArrows,
  ShieldCheck,
  GraduationCap,
  UserCog,
  FolderKanban,
  Factory,
  UserSearch,
  Repeat,
  Store,
  Megaphone,
  Receipt,
  Car,
  Globe,
  Mail,
  ClipboardList,
  UsersRound,
  PackageOpen,
  Wrench,
  BadgeCheck,
  type LucideIcon,
} from "lucide-react";

/**
 * Central registry of lucide icons available to agent templates.
 *
 * Templates declare an `iconName` string that must be a key of this record.
 * The TemplateIconName union type is derived from this map so TypeScript
 * rejects typos at the call site and new icons are added here first.
 *
 * `Bot` is intentionally exported as the generic fallback and must never be
 * assigned as the primary icon for a shipping template — `agent-templates`
 * tests enforce this.
 */
export const TEMPLATE_ICON_COMPONENTS = {
  FileText,
  Bot,
  TrendingUp,
  Warehouse,
  Calculator,
  Handshake,
  ShoppingCart,
  Headset,
  Scale,
  Users,
  GitCompareArrows,
  ShieldCheck,
  GraduationCap,
  UserCog,
  FolderKanban,
  Factory,
  UserSearch,
  Repeat,
  Store,
  Megaphone,
  Receipt,
  Car,
  Globe,
  Mail,
  ClipboardList,
  UsersRound,
  PackageOpen,
  Wrench,
  BadgeCheck,
} as const satisfies Record<string, LucideIcon>;

export type TemplateIconName = keyof typeof TEMPLATE_ICON_COMPONENTS;
