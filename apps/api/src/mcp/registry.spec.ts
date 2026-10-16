import { jsonSchemaOf, toolDefinitionTrouble } from "./mcp-runtime.service.js";
import { MCP_PROMPTS, MCP_RESOURCES, MCP_TOOLS } from "./tools/index.js";

/** Keeps every domain's tool file honest: valid definitions, unique names, schemas a client can read. */
describe("MCP tool registry", () => {
  it("has valid tool definitions", () => {
    for (const t of MCP_TOOLS) expect([t.name, toolDefinitionTrouble(t)]).toEqual([t.name, null]);
  });

  it("has unique names, none taken by the framework's own tools", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const builtin of ["confirm_action", "cancel_action", "list_pending_actions"]) expect(names).not.toContain(builtin);
  });

  it("converts every input to an object JSON Schema", () => {
    for (const t of MCP_TOOLS) {
      const schema = jsonSchemaOf(t.input);
      expect([t.name, schema.type]).toEqual([t.name, "object"]);
      expect(schema.$schema).toBeUndefined();
    }
  });

  it("has unique prompt names and resource URIs", () => {
    expect(new Set(MCP_PROMPTS.map((p) => p.name)).size).toBe(MCP_PROMPTS.length);
    expect(new Set(MCP_RESOURCES.map((r) => r.uri)).size).toBe(MCP_RESOURCES.length);
  });
});
