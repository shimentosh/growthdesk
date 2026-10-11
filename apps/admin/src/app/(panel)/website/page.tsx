import { redirect } from "next/navigation";

/** /website → the first Website page. */
export default function Page() {
  redirect("/website/branding");
}
