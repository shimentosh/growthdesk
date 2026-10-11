import { redirect } from "next/navigation";

/** /growth has no page of its own. */
export default function Page() {
  redirect("/growth/broadcasts");
}
