"use client";

import { Fragment, useMemo, useState } from "react";
import { Lock, RotateCcw } from "lucide-react";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  labelOf,
  OWNER_ONLY_PERMISSIONS,
  PERMISSION_GROUPS,
  permissionsFor,
  rolePermissionTrouble,
  type RolePermissionOverrides,
} from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardFooter } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { ENTITY, EntityTile, type Entity } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { toast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { cn } from "@/lib/cn";
import { useApiMutation, useInvalidate } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { EditableRole, RolePermissionsResult } from "@/lib/types/admin";
import { EDITABLE_ROLES } from "./labels";

/*
 * The permission matrix. The rules the API enforces (rolePermissionTrouble +
 * "nobody grants what they do not hold") are applied as you click, so a
 * save never fails on them:
 *   - ticking an action also ticks its group's ".read"; unticking the read
 *     unticks the actions that depend on it
 *   - owner-only permissions cannot be ticked for any role
 *   - a permission you do not hold yourself cannot be ticked
 */

type Draft = Record<EditableRole, string[]>;

const readOf = (p: string): string | null => {
  const [group, action] = p.split(".");
  if (!group || action === "read" || action === "view_all") return null;
  const read = `${group}.read`;
  return ALL_PERMISSIONS.includes(read) ? read : null;
};

const dependentsOf = (read: string) => ALL_PERMISSIONS.filter((p) => readOf(p) === read);

/** Sorted in catalogue order, so comparing two lists is a string compare. */
const normalize = (list: Iterable<string>) => {
  const set = new Set(list);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

const defaultsFor = (role: EditableRole) => normalize(DEFAULT_ROLE_PERMISSIONS[role].filter((p) => !OWNER_ONLY_PERMISSIONS.includes(p)));
const same = (a: string[], b: string[]) => a.join("|") === b.join("|");

function draftFrom(overrides: RolePermissionOverrides): Draft {
  return Object.fromEntries(EDITABLE_ROLES.map((r) => [r, normalize(permissionsFor(r, overrides))])) as Draft;
}

/** Each permission group's glyph, borrowed from the screen it governs. */
const GROUP_ENTITY: Record<string, Entity> = {
  contacts: "contacts",
  deals: "deals",
  tasks: "tasks",
  campaigns: "campaigns",
  inbox: "inbox",
  calls: "calls",
  automation: "workflows",
  analytics: "reports",
  workspace: "settings",
};

function GroupGlyph({ id }: { id: string }) {
  const entity = GROUP_ENTITY[id];
  if (!entity) return null;
  const { icon: Icon } = ENTITY[entity];
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

/** Marks a role whose permissions differ from the defaults. */
function CustomDot() {
  return (
    <>
      <span aria-hidden className="size-1.5 rounded-full bg-accent" />
      <span className="sr-only">(customised)</span>
    </>
  );
}

function Matrix({ overrides }: { overrides: RolePermissionOverrides }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const held = useMemo(() => new Set(ws.permissions), [ws.permissions]);
  const hasFeature = ws.hasFeature("customRoles");
  const editable = ws.can("settings.manage") && hasFeature;

  const saved = useMemo(() => draftFrom(overrides), [overrides]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [saving, setSaving] = useState(false);

  const put = useApiMutation<RolePermissionsResult, { role: EditableRole; permissions: string[] | null }>({
    method: "PUT",
    path: ws.path("/role-permissions"),
  });

  const changed = EDITABLE_ROLES.filter((r) => !same(draft[r], saved[r]));
  const customised = (r: EditableRole) => Boolean(overrides[r]);

  function toggle(role: EditableRole, p: string, on: boolean) {
    setDraft((d) => {
      const next = new Set(d[role]);
      if (on) {
        next.add(p);
        const read = readOf(p);
        if (read && held.has(read)) next.add(read);
      } else {
        next.delete(p);
        if (p.endsWith(".read")) for (const dep of dependentsOf(p)) next.delete(dep);
      }
      return { ...d, [role]: normalize(next) };
    });
  }

  function resetRole(role: EditableRole) {
    setDraft((d) => ({ ...d, [role]: defaultsFor(role) }));
  }

  async function save() {
    // Check every changed role first, so nothing is half-saved on a rule the API would refuse.
    for (const role of changed) {
      const trouble = rolePermissionTrouble(draft[role]);
      if (trouble) {
        toast.error(`${labelOf(role)}: ${trouble}`);
        return;
      }
    }
    setSaving(true);
    try {
      for (const role of changed) {
        // Matching the defaults clears the override, so future default changes reach this role too.
        const permissions = same(draft[role], defaultsFor(role)) ? null : draft[role];
        await put.mutateAsync({ role, permissions });
      }
      toast.success(changed.length === 1 ? `${labelOf(changed[0]!)} permissions saved` : "Permissions saved");
    } catch {
      // useApiMutation has already shown the error (or the upgrade dialog).
    } finally {
      await invalidate(workspaceDetailKey(ws.id));
      setSaving(false);
    }
  }

  const disabledReason = (role: EditableRole, p: string, checked: boolean): string | null => {
    if (!editable) return null;
    if (OWNER_ONLY_PERMISSIONS.includes(p)) return "Only the owner can hold this.";
    if (!held.has(p) && !checked) return "You can't grant a permission your own role doesn't have.";
    const read = readOf(p);
    if (!checked && read && !held.has(read) && !draft[role].includes(read)) return `Needs "${read}", which your role doesn't have.`;
    return null;
  };

  return (
    <>
      {!hasFeature && (
        <UpgradePrompt className="mb-5" details={{ feature: "customRoles", plan: ws.plan.name }} message="Every role uses the default permissions shown below. Upgrade to change what each role can do." />
      )}
      {hasFeature && !ws.can("settings.manage") && (
        <Callout tone="info" className="mb-5">
          Only people who can change workspace settings can edit role permissions.
        </Callout>
      )}
      {editable && changed.includes(ws.role as EditableRole) && (
        <Callout tone="warn" className="mb-5">
          You are changing the permissions of your own role ({labelOf(ws.role)}). Removing one takes it away from you as well.
        </Callout>
      )}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="h-10 border-b border-line bg-well px-4 text-left text-xs font-medium text-text-3"><ColumnLabel icon={COL.role}>Permission</ColumnLabel></th>
                <th className="h-10 w-20 border-b border-line bg-well px-2 text-center text-xs font-medium text-text-3">Owner</th>
                {EDITABLE_ROLES.map((r) => (
                  <th key={r} className="h-10 w-24 border-b border-line bg-well px-2 text-center text-xs font-medium text-text-3">
                    {editable ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 hover:bg-hover hover:text-text">
                          {labelOf(r)}
                          {(customised(r) || changed.includes(r)) && <CustomDot />}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="center">
                          <DropdownMenuLabel>{labelOf(r)}</DropdownMenuLabel>
                          <DropdownMenuItem icon={<RotateCcw />} disabled={same(draft[r], defaultsFor(r))} onSelect={() => resetRole(r)}>
                            Reset to defaults
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {labelOf(r)}
                        {customised(r) && <CustomDot />}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_GROUPS.map((g) => (
                <Fragment key={g.id}>
                  <tr>
                    <th colSpan={2 + EDITABLE_ROLES.length} scope="colgroup" className="border-b border-line bg-s-2 px-4 py-1.5 text-left text-2xs font-semibold tracking-wide text-text-3 uppercase">
                      <span className="inline-flex items-center gap-1.5">
                        <GroupGlyph id={g.id} />
                        {g.label}
                      </span>
                    </th>
                  </tr>
                  {g.permissions.map((p) => {
                    const ownerOnly = OWNER_ONLY_PERMISSIONS.includes(p.id);
                    return (
                      <tr key={p.id} className="hover:bg-hover">
                        <td className="border-b border-line px-4 py-2">
                          <div className="text-text">{p.label}</div>
                          <div className="font-mono text-2xs text-text-3">{p.id}</div>
                        </td>
                        <td className="border-b border-line px-2 py-2 text-center">
                          <span className="inline-flex">
                            <Checkbox checked onCheckedChange={() => undefined} disabled aria-label={`Owner: ${p.label}`} />
                          </span>
                        </td>
                        {EDITABLE_ROLES.map((r) => {
                          const checked = draft[r].includes(p.id);
                          const reason = disabledReason(r, p.id, checked);
                          const box = (
                            <span className="inline-flex">
                              {ownerOnly ? (
                                <Lock aria-label={`${labelOf(r)}: owner only`} className="size-3.5 text-text-3" />
                              ) : (
                                <Checkbox
                                  checked={checked}
                                  disabled={!editable || Boolean(reason)}
                                  onCheckedChange={(on) => toggle(r, p.id, on)}
                                  aria-label={`${labelOf(r)}: ${p.label}`}
                                />
                              )}
                            </span>
                          );
                          return (
                            <td key={r} className={cn("border-b border-line px-2 py-2 text-center", !same(draft[r], saved[r]) && "bg-accent/5")}>
                              {reason || ownerOnly ? <Tooltip content={ownerOnly ? "Only the owner can hold this." : reason}>{box}</Tooltip> : box}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <CardFooter className="justify-between">
            <span className="text-xs text-text-3">
              {changed.length ? `Unsaved changes to ${changed.map((r) => labelOf(r)).join(", ")}` : "A dot marks a role whose permissions differ from the defaults."}
            </span>
            <span className="flex gap-2">
              <Button disabled={!changed.length || saving} onClick={() => setDraft(saved)}>
                Discard
              </Button>
              <Button variant="primary" loading={saving} disabled={!changed.length} onClick={save}>
                Save permissions
              </Button>
            </span>
          </CardFooter>
        )}
      </Card>
    </>
  );
}

/** Settings → Roles & permissions: what each role may do in this workspace. */
export function RolesSettings() {
  const ws = useWorkspace();
  const overrides = (ws.detail.rolePermissions ?? {}) as RolePermissionOverrides;
  // Remount the editor when the saved permissions change, so the draft starts from the server's copy.
  const version = JSON.stringify(overrides);
  return (
    <RequirePermission permission="members.read">
      <PageHeader
        icon={<EntityTile of="roles" />}
        title="Roles & permissions"
        description="What each role can do in this workspace. The owner always has every permission."
        meta={Object.keys(overrides).length ? <Badge tone="info">Customised</Badge> : undefined}
      />
      <Matrix key={version} overrides={overrides} />
      <p className="mt-3 text-xs text-text-3">
        By default admins have everything except changing the plan and payment details, and viewers can read but not change. A role can&apos;t be given an action without being able to see
        what it acts on.
      </p>
    </RequirePermission>
  );
}
