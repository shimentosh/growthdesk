import { assertScoped, TenantScopeError, whereIsScoped } from "./tenant-guard.js";

describe("tenant guard", () => {
  it("accepts queries that name a workspace", () => {
    expect(whereIsScoped({ workspaceId: "w1", id: "x" })).toBe(true);
    expect(whereIsScoped({ workspaceId: { in: ["w1", "w2"] } })).toBe(true);
    expect(whereIsScoped({ workspaceId_email: { workspaceId: "w1", email: "a" } })).toBe(true);
    expect(whereIsScoped({ AND: [{ status: "open" }, { workspaceId: "w1" }] })).toBe(true);
    expect(() => assertScoped("Contact", "findMany", { where: { workspaceId: "w1" } })).not.toThrow();
    expect(() => assertScoped("Contact", "create", { data: { workspaceId: "w1", fullName: "x" } })).not.toThrow();
    expect(() => assertScoped("ContactTag", "createMany", { data: [] })).not.toThrow();
  });

  it("refuses tenant queries without a workspace", () => {
    expect(() => assertScoped("Contact", "findMany", { where: { email: "a@b.c" } })).toThrow(TenantScopeError);
    expect(() => assertScoped("Contact", "findFirst", {})).toThrow(TenantScopeError);
    expect(() => assertScoped("Contact", "update", { where: { id: "x" }, data: {} })).toThrow(TenantScopeError);
    expect(() => assertScoped("Deal", "deleteMany", { where: { OR: [{ workspaceId: "w1" }, { id: "x" }] } })).toThrow(TenantScopeError);
    expect(() => assertScoped("Message", "create", { data: { body: "x" } })).toThrow(TenantScopeError);
    expect(() => assertScoped("Task", "createMany", { data: [{ workspaceId: "w1" }, { title: "x" }] })).toThrow(TenantScopeError);
    expect(() => assertScoped("Enrollment", "upsert", { where: { workspaceId: "w1", id: "x" }, create: {}, update: {} })).toThrow(TenantScopeError);
    expect(() => assertScoped("Contact", "findMany", { where: { workspaceId: "" } })).toThrow(TenantScopeError);
  });

  it("ignores identity and platform models", () => {
    expect(() => assertScoped("User", "findMany", {})).not.toThrow();
    expect(() => assertScoped("Plan", "findFirst", {})).not.toThrow();
  });
});
