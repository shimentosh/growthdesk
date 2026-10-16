import { OUTREACH_CAMPAIGN_TOOLS } from "./campaigns.tools.js";
import { OUTREACH_ENROLLMENT_TOOLS } from "./enrollments.tools.js";
import { OUTREACH_MAILBOX_TOOLS } from "./mailboxes.tools.js";
import { OUTREACH_SEQUENCE_TOOLS } from "./sequences.tools.js";
import { OUTREACH_TEMPLATE_TOOLS } from "./templates.tools.js";

/*
 * Outreach over MCP (docs/MCP.md → "Outreach tools"): mailboxes and channels
 * (read), message templates, the sequence library, campaigns and their
 * enrollments.
 */

export const OUTREACH_TOOLS = [
  ...OUTREACH_MAILBOX_TOOLS,
  ...OUTREACH_TEMPLATE_TOOLS,
  ...OUTREACH_SEQUENCE_TOOLS,
  ...OUTREACH_CAMPAIGN_TOOLS,
  ...OUTREACH_ENROLLMENT_TOOLS,
];

export { OUTREACH_PROMPTS } from "./prompts.js";
