import type { NextFunction, Request, Response } from "express";

/**
 * CORS for /mcp only: any origin may call it with a bearer token (browser-based
 * MCP clients and inspectors). No credentials — cookies never authenticate MCP.
 * Registered in app.setup.ts before the routes, so preflights never reach the guards.
 */
export function mcpCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
