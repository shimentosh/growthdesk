import type { EmailBlock, EmailTheme, PlatformEmailDesignStatus } from "@growthdesk/shared";
import type { Person } from "@/features/common/types";

/** GET /admin/email-designs (each row) and /admin/email-designs/:id */
export type LibraryDesign = {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  theme: EmailTheme;
  blocks: EmailBlock[];
  status: PlatformEmailDesignStatus;
  sortOrder: number;
  /** Shipped with the product; new workspaces start with a copy of it while it is published. */
  builtIn: boolean;
  createdBy: Person | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

/** GET /admin/email-designs/sources/:workspaceId */
export type WorkspaceDesignSources = {
  workspace: { id: string; name: string };
  designs: { id: string; name: string; fromLibrary: boolean; updatedAt: string }[];
};
