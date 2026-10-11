import { headers } from "next/headers";
import { customerAppUrl } from "@/lib/environment";

/** The customer site's base URL, for "View live" links (server-only; route files pass it down). */
export async function websiteAppUrl(): Promise<string | null> {
  const h = await headers();
  return customerAppUrl(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
}
