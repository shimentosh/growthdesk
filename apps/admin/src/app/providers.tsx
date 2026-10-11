"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { QueryProvider } from "@/lib/query";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <TooltipProvider>
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryProvider>
  );
}
