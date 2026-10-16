import type { McpPrompt, McpResource, McpTool } from "../tool.js";
import { CORE_PROMPTS, CORE_RESOURCES, CORE_TOOLS } from "./core.tools.js";
import { CRM_TOOLS } from "./crm.tools.js";
import { SALES_PROMPTS, SALES_TOOLS } from "./sales.tools.js";
import { INBOX_TOOLS } from "./inbox.tools.js";
import { AUTOMATION_PROMPTS, AUTOMATION_TOOLS } from "./automation.tools.js";
import { REPORT_TOOLS } from "./reports.tools.js";
import { OUTREACH_PROMPTS, OUTREACH_TOOLS } from "./outreach/index.js";
import { MARKETING_PROMPTS, MARKETING_TOOLS } from "./marketing.tools.js";
import { SEARCH_TOOLS } from "./search.tools.js";
import { VALIDATION_TOOLS } from "./validation.tools.js";
import { WORKFLOW_REFERENCE_TOOLS } from "./workflow-reference.tools.js";

/*
 * Every MCP tool, prompt and resource. A domain adds one file in this folder
 * that exports an array made with defineTool() (docs/MCP.md → "Adding tools"),
 * and one line to each list below. Names must be unique across all files —
 * registry.spec.ts checks, and the API refuses to start otherwise.
 *
 * The framework's own tools (confirm_action, cancel_action,
 * list_pending_actions) are added by McpRuntime, not listed here.
 */

export const MCP_TOOLS: McpTool[] = [
  ...CORE_TOOLS,
  ...CRM_TOOLS,
  ...SALES_TOOLS,
  ...INBOX_TOOLS,
  ...AUTOMATION_TOOLS,
  ...REPORT_TOOLS,
  ...OUTREACH_TOOLS,
  ...MARKETING_TOOLS,
  ...SEARCH_TOOLS,
  ...VALIDATION_TOOLS,
  ...WORKFLOW_REFERENCE_TOOLS,
];

export const MCP_PROMPTS: McpPrompt[] = [
  ...CORE_PROMPTS,
  ...SALES_PROMPTS,
  ...AUTOMATION_PROMPTS,
  ...OUTREACH_PROMPTS,
  ...MARKETING_PROMPTS,
];

export const MCP_RESOURCES: McpResource[] = [
  ...CORE_RESOURCES,
];
