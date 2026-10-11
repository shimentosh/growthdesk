import { Injectable } from "@nestjs/common";
import { type FeatureKey, flowTrouble, unknownVariables } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { badRequest } from "../common/errors.js";
import type { Template } from "../generated/prisma/client.js";
import { MESSAGE_STEPS, MULTICHANNEL_STEPS, type StepLike, configOf, flowOf, updateFieldTrouble } from "./campaign-config.js";

export type StepProblem = { field: string; message: string };

export type StepReport = {
  /** A structural problem that makes the flow unwalkable (adapted from LinkDesk assertWalkable). */
  structure: string | null;
  /** Content problems, each blocking. */
  problems: StepProblem[];
  /** Variables that are neither standard nor a contact custom field. */
  unknown: string[];
  /** Plan features the step kinds need. */
  features: FeatureKey[];
  /** The personalised text of every message step (subject + body), for missing-variable sampling. */
  messageTexts: string[];
  templates: Map<string, Template>;
  customKeys: string[];
};

/*
 * The rules a sequence must satisfy before it is saved or launched — shared
 * by library sequences, campaign steps and campaign readiness so the three
 * can never disagree.
 */
@Injectable()
export class StepRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async customKeys(workspaceId: string): Promise<string[]> {
    const defs = await this.prisma.db.customFieldDefinition.findMany({ where: { workspaceId, entity: "contact" }, select: { key: true } });
    return defs.map((d) => d.key);
  }

  async inspect(workspaceId: string, steps: StepLike[]): Promise<StepReport> {
    const customKeys = await this.customKeys(workspaceId);
    const report: StepReport = { structure: null, problems: [], unknown: [], features: [], messageTexts: [], templates: new Map(), customKeys };
    if (!steps.length) return report;
    report.structure = flowTrouble(flowOf(steps));

    const templateIds = [...new Set(steps.map((s) => configOf(s).templateId).filter((v): v is string => typeof v === "string" && v.length > 0))];
    if (templateIds.length) {
      const rows = await this.prisma.db.template.findMany({ where: { workspaceId, id: { in: templateIds } } });
      for (const t of rows) report.templates.set(t.id, t);
    }
    const userIds = [...new Set(steps.map((s) => configOf(s).userId).filter((v): v is string => typeof v === "string" && v.length > 0))];
    const members = userIds.length
      ? new Set((await this.prisma.db.membership.findMany({ where: { workspaceId, userId: { in: userIds } }, select: { userId: true } })).map((m) => m.userId))
      : new Set<string>();

    const features = new Set<FeatureKey>();
    const texts: string[] = [];
    let firstEmailSeen = false;
    steps.forEach((step, i) => {
      const type = String(step.type);
      const cfg = configOf(step);
      const at = (key: string) => `steps.${i}.config.${key}`;
      const say = (key: string, message: string) => report.problems.push({ field: at(key), message: `Step ${i + 1}: ${message}` });
      if (MULTICHANNEL_STEPS.has(type)) features.add("multichannel");
      if (type === "branch") features.add("branching");

      const template = cfg.templateId ? report.templates.get(cfg.templateId) : undefined;
      if (cfg.templateId && !template) say("templateId", "that template does not exist in this workspace.");

      if (MESSAGE_STEPS.has(type)) {
        const channel = type === "email" ? "email" : type;
        if (template && template.channel !== channel) say("templateId", `the template “${template.name}” is a ${template.channel} template, not ${channel}.`);
        const body = cfg.body?.trim() ? cfg.body : (template?.body ?? "");
        const subject = cfg.subject?.trim() ? cfg.subject : (template?.subject ?? "");
        if (!body.trim()) say("body", type === "email" ? "an email needs a body or a template." : `a ${type} message needs a body or a template.`);
        if (type === "email") {
          if (!firstEmailSeen && !subject.trim()) say("subject", "the first email needs a subject — it opens the thread the follow-ups reply in.");
          firstEmailSeen = true;
          texts.push(`${subject}\n${body}`);
        } else {
          texts.push(body);
        }
      }
      if (type === "call_task" || type === "create_task") {
        texts.push(cfg.taskTitle ?? "", cfg.body ?? "", typeof cfg.description === "string" ? cfg.description : "");
      }
      if (type === "notify") {
        texts.push(cfg.message ?? "");
        if (cfg.userId && !members.has(cfg.userId)) say("userId", "the person to notify is not a member of this workspace.");
      }
      if (type === "update_field") {
        const trouble = updateFieldTrouble(cfg.field, cfg.value, customKeys);
        if (trouble) say("field", `${trouble}.`);
      }
      if (type === "assign_owner") {
        const strategy = cfg.strategy ?? (cfg.userId ? "user" : "round_robin");
        if (strategy === "user") {
          if (!cfg.userId) say("userId", "choose the person to assign.");
          else if (!members.has(cfg.userId)) say("userId", "the person to assign is not a member of this workspace.");
        }
      }
    });

    report.features = [...features];
    // Only message texts can stop an enrollment for a missing value; internal texts drop unresolved tokens.
    report.messageTexts = steps
      .map((s) => {
        const cfg = configOf(s);
        const template = cfg.templateId ? report.templates.get(cfg.templateId) : undefined;
        if (!MESSAGE_STEPS.has(String(s.type))) return null;
        const body = cfg.body?.trim() ? cfg.body : (template?.body ?? "");
        const subject = String(s.type) === "email" ? (cfg.subject?.trim() ? cfg.subject : (template?.subject ?? "")) : "";
        return `${subject}\n${body}`;
      })
      .filter((t): t is string => t !== null);
    report.unknown = unknownVariables(texts.join("\n"), customKeys);
    return report;
  }

  /** Refuses steps that could not be saved: 400 for shape/content, 402 for step kinds the plan lacks. */
  async validate(workspaceId: string, billingAccountId: string, steps: StepLike[]): Promise<StepReport> {
    const report = await this.inspect(workspaceId, steps);
    if (report.structure) throw badRequest(report.structure, { steps: report.structure });
    for (const feature of report.features) await this.entitlements.assertFeature(billingAccountId, feature);
    if (report.problems.length) {
      const fields = Object.fromEntries(report.problems.map((p) => [p.field, p.message]));
      throw badRequest(report.problems[0]!.message, fields);
    }
    if (report.unknown.length) {
      const message = `Unknown personalization ${report.unknown.length === 1 ? "variable" : "variables"}: ${report.unknown.map((v) => `{{${v}}}`).join(", ")}. Use a standard variable or a contact custom field.`;
      throw badRequest(message, { steps: message });
    }
    return report;
  }
}
