import {
  Building2,
  Send,
  UserCheck,
  UsersRound,
  Workflow,
  FileText,
  Settings2,
  Fingerprint,
  LayoutTemplate,
  Megaphone,
  Scale,
  Search,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  MailCheck,
  Package,
  Palette,
  ScrollText,
  Settings,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PlatformRole } from "@growthdesk/shared";

/*
 * The operator console's navigation — the ONE place the sidebar, the top
 * bar's breadcrumbs and the global search's "Pages" results read from.
 *
 * Adding a page:
 *   1. Create the route under src/app/(panel)/<path>/page.tsx.
 *   2. Add one line to the right group below, e.g.
 *        { href: "/revenue", label: "Revenue & MRR", icon: TrendingUp },
 *   A new group is one more object in NAV ({ id, label, items }).
 *
 * Only list pages that exist. `minRole` hides an item from staff below that
 * platform role (the API enforces the same ranks regardless).
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active only on this exact path (the dashboard), not on its children. */
  exact?: boolean;
  /** Lowest platform role that sees the item. Default: every staff role. */
  minRole?: Exclude<PlatformRole, "none">;
  /** Extra words the global search matches this page on. */
  keywords?: string[];
};

export type NavGroup = { id: string; label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true, keywords: ["home", "overview", "kpi"] }],
  },
  {
    id: "customers",
    label: "Customers",
    items: [
      { href: "/users", label: "Users", icon: Users, keywords: ["accounts", "people", "staff"] },
      { href: "/workspaces", label: "Workspaces", icon: Building2, keywords: ["tenants", "teams"] },
      { href: "/billing", label: "Billing accounts", icon: CreditCard, keywords: ["subscriptions", "invoices"] },
      { href: "/support", label: "Support", icon: LifeBuoy, keywords: ["cases", "tickets", "grants"] },
    ],
  },
  {
    id: "revenue",
    label: "Revenue",
    items: [
      { href: "/revenue", label: "Revenue & MRR", icon: TrendingUp, minRole: "admin", keywords: ["mrr", "arr", "churn", "invoices", "income"] },
      { href: "/plans", label: "Plans", icon: Package, keywords: ["pricing", "limits", "features"] },
    ],
  },
  {
    id: "growth",
    label: "Growth",
    items: [
      { href: "/growth/audiences", label: "Audiences", icon: UsersRound, keywords: ["segments", "filters"] },
      { href: "/growth/broadcasts", label: "Broadcasts", icon: Send, keywords: ["newsletter", "announcement", "product update"] },
      { href: "/growth/sequences", label: "Onboarding sequences", icon: Workflow, keywords: ["drip", "lifecycle", "onboarding"] },
      { href: "/growth/subscribers", label: "Subscribers", icon: UserCheck, keywords: ["consent", "unsubscribe", "suppression"] },
    ],
  },
  {
    id: "website",
    label: "Website",
    items: [
      { href: "/website/branding", label: "Branding", icon: Fingerprint, keywords: ["logo", "favicon", "colour", "product name", "brand"] },
      { href: "/website/landing", label: "Landing page", icon: LayoutTemplate, keywords: ["home page", "hero", "features", "faq", "marketing site"] },
      { href: "/website/legal", label: "Legal pages", icon: Scale, keywords: ["terms", "privacy", "policy"] },
      { href: "/website/announcement", label: "Announcement", icon: Megaphone, keywords: ["banner", "notice", "news"] },
      { href: "/website/seo", label: "SEO & analytics", icon: Search, keywords: ["meta", "og image", "plausible", "google analytics", "ga4"] },
    ],
  },
  {
    id: "library",
    label: "Library",
    items: [
      {
        href: "/library/email-templates",
        label: "Email templates",
        icon: Palette,
        keywords: ["design templates", "marketing email", "newsletter", "gallery", "email designs", "start from template"],
      },
    ],
  },
  {
    id: "email",
    label: "Email",
    items: [
      { href: "/email/templates", label: "Templates", icon: FileText, keywords: ["email templates", "verify email", "password reset", "invitation"] },
      { href: "/email", label: "Delivery log", icon: MailCheck, exact: true, keywords: ["email log", "mail", "bounces", "complaints"] },
      { href: "/email/settings", label: "Email settings", icon: Settings2, keywords: ["resend", "smtp", "webhook", "domains", "dns", "from address"] },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    items: [
      {
        href: "/registration",
        label: "Registration",
        icon: UserPlus,
        keywords: ["signups", "sign-up", "waitlist", "invitations", "invite", "domains", "disposable", "verification", "trial"],
      },
      { href: "/settings", label: "General settings", icon: Settings, keywords: ["maintenance", "outreach"] },
      { href: "/audit", label: "Audit log", icon: ScrollText, keywords: ["events", "history"] },
    ],
  },
];

const RANK: Record<PlatformRole, number> = { none: 0, support: 1, admin: 2, owner: 3 };

/** The groups and items this role may see; empty groups are dropped. */
export function navFor(role: PlatformRole): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => RANK[role] >= RANK[i.minRole ?? "support"]) })).filter((g) => g.items.length > 0);
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.exact || item.href === "/") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The nav item a path belongs to (longest matching href), with its group. */
export function navMatch(pathname: string): { group: NavGroup; item: NavItem } | null {
  let best: { group: NavGroup; item: NavItem } | null = null;
  for (const group of NAV) {
    for (const item of group.items) {
      if (isActive(item, pathname) && (!best || item.href.length > best.item.href.length)) best = { group, item };
    }
  }
  return best;
}

export type Crumb = { label: string; href?: string };

/** Words for the path segments below a nav item: /workspaces/:id/support → "Workspace", "Support view". */
const SEGMENT_LABELS: Record<string, string> = { support: "Support view" };
const DETAIL_LABELS: Record<string, string> = {
  "/users": "User",
  "/workspaces": "Workspace",
  "/billing": "Billing account",
  "/support": "Case",
  "/email/templates": "Template",
  "/library/email-templates": "Template",
  "/growth/broadcasts": "Broadcast",
  "/growth/sequences": "Sequence",
};

/** Group › Page › detail…, for the top bar. */
export function breadcrumbs(pathname: string): Crumb[] {
  const match = navMatch(pathname);
  if (!match) return [];
  const { group, item } = match;
  const crumbs: Crumb[] = [];
  if (group.label !== item.label) crumbs.push({ label: group.label });
  crumbs.push({ label: item.label, href: item.href });
  if (item.exact) return crumbs;
  const rest = pathname.slice(item.href.length).split("/").filter(Boolean);
  let href = item.href;
  rest.forEach((segment, i) => {
    href += `/${segment}`;
    const label = i === 0 ? (DETAIL_LABELS[item.href] ?? "Details") : (SEGMENT_LABELS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1));
    crumbs.push({ label, href: i < rest.length - 1 ? href : undefined });
  });
  return crumbs;
}
