import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorScreen } from "@/components/site/ErrorScreen";

export const metadata: Metadata = { title: "Page not found" };

/** Any URL nothing answers (and every notFound() without a closer not-found file). */
export default function NotFound() {
  return (
    <ErrorScreen
      code="404"
      title="This page does not exist"
      description="The link may be broken, or the page may have moved. Check the address, or head back to the start."
      actions={
        <>
          <Button href="/" variant="primary" icon={<ArrowLeft />}>
            Back to home
          </Button>
          <Button href="/pricing">See pricing</Button>
        </>
      }
    />
  );
}
