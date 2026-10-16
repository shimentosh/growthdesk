import { Module } from "@nestjs/common";
import { ThrottleStorageModule } from "../common/throttle.js";
import { McpController } from "./mcp.controller.js";
import { McpTokensController } from "./mcp-tokens.controller.js";
import { McpAuthService } from "./mcp-auth.service.js";
import { McpRuntime } from "./mcp-runtime.service.js";
import { McpConfirmationsService } from "./confirmations.service.js";
import { McpTokensService } from "./mcp-tokens.service.js";
import { McpOAuthConsentController, McpOAuthController } from "./oauth/mcp-oauth.controller.js";
import { McpOAuthService } from "./oauth/mcp-oauth.service.js";

/**
 * MCP for Claude and other AI clients (docs/MCP.md): the POST /mcp endpoint,
 * the tool runtime, the Settings → MCP / Claude routes, and the OAuth 2.1
 * authorization server for "Add custom connector" clients (src/mcp/oauth).
 * Tools reach every other module's services through ModuleRef (McpDeps.get),
 * so nothing is imported here for them. HTTP only — the worker does not load it.
 */
@Module({
  imports: [ThrottleStorageModule],
  controllers: [McpController, McpTokensController, McpOAuthController, McpOAuthConsentController],
  providers: [McpAuthService, McpRuntime, McpConfirmationsService, McpTokensService, McpOAuthService],
  exports: [McpRuntime, McpConfirmationsService],
})
export class McpModule {}
