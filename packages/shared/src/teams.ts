import { z } from "zod";
import { requiredText, text } from "./schemas.js";

/*
 * Teams: named groups of teammates (Sales, Marketing, SDR…). They decide who
 * sees whose records under team visibility, can be a lead-routing pool, and
 * group the team activity feed and reports.
 */

export const TEAM_COLORS = ["blue", "green", "purple", "orange", "pink", "teal", "indigo", "red", "yellow", "gray"] as const;

export const TeamInput = z.object({
  name: requiredText(60),
  description: text(300).optional(),
  color: z.enum(TEAM_COLORS).default("blue"),
  /** The team's lead (manager); must be one of its members. */
  leadUserId: z.string().uuid().nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(200).default([]),
});
export type TeamInputT = z.infer<typeof TeamInput>;

export const RECORD_VISIBILITIES = ["everyone", "team"] as const;
export type RecordVisibilityT = (typeof RECORD_VISIBILITIES)[number];

/** everyone: members see every record. team: members and viewers see their own, their teams' and unowned records (managers and up still see all). */
export const RecordVisibilityInput = z.object({ recordVisibility: z.enum(RECORD_VISIBILITIES) });

/**
 * "This week's focus": a short note managers pin on everyone's Home (or a
 * team lead pins for their team). Empty text clears it; `notify` also rings
 * the bell for the people it is for.
 */
export const TeamFocusInput = z.object({
  text: text(1000),
  teamId: z.string().uuid().nullable().optional(),
  notify: z.boolean().default(false),
});
export type TeamFocusInputT = z.infer<typeof TeamFocusInput>;
