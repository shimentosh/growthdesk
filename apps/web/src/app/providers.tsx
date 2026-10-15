"use client";

import { Suspense, type ReactNode } from "react";
import { NavigationProgress } from "@/components/shell/NavigationProgress";
import { Toaster } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { UnsavedChangesGuard } from "@/components/ui/UnsavedChangesGuard";
import { QueryProvider } from "@/lib/query";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <TooltipProvider>
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
        <Toaster />
        <UnsavedChangesGuard />
      </TooltipProvider>
    </QueryProvider>
  );
}
