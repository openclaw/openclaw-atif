import { asRecord, readFiniteNumber } from "./json.js";
import { compareCodeUnits } from "./ordering.js";

const COMPONENTS = ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const;
type Component = (typeof COMPONENTS)[number];
export interface UsageSummary {
  messages: number;
  components: Record<Component, { observed: number; total: number | null }>;
}
export interface ModelUsageSummary extends UsageSummary {
  model: string | null;
}
export interface NodeUsageSummary extends UsageSummary {
  models: ModelUsageSummary[];
}
export interface UsageObservation {
  model: string | null;
  usage: Record<string, unknown>;
}
export interface AccountingEvidence {
  scope: "observed-assistant-messages";
  providerRequests: "not-established";
  costProvenance: "runtime-reported-unreconciled";
  family: UsageSummary;
  nodes: (NodeUsageSummary & { sessionKey: string })[];
}

function emptySummary(): UsageSummary {
  return {
    messages: 0,
    components: {
      input: { observed: 0, total: null },
      output: { observed: 0, total: null },
      cacheRead: { observed: 0, total: null },
      cacheWrite: { observed: 0, total: null },
      costUsd: { observed: 0, total: null },
    },
  };
}

function mergeSummary(target: UsageSummary, source: UsageSummary): void {
  target.messages += source.messages;
  for (const key of COMPONENTS) {
    const component = source.components[key];
    target.components[key].observed += component.observed;
    if (component.total !== null)
      target.components[key].total = (target.components[key].total ?? 0) + component.total;
  }
}

function observeUsage(summary: UsageSummary, usage: Record<string, unknown>): void {
  summary.messages += 1;
  const values: Record<string, unknown> = {
    ...usage,
    costUsd: asRecord(usage.cost)?.total ?? usage.cost,
  };
  for (const key of COMPONENTS) {
    const raw = values[key];
    const value = readFiniteNumber(raw);
    if (value === undefined || value < 0) continue;
    summary.components[key].observed += 1;
    summary.components[key].total =
      (summary.components[key].total ?? 0) + (key === "costUsd" ? value : Math.trunc(value));
  }
}

export function summarizeUsage(observations: readonly UsageObservation[]): NodeUsageSummary {
  const models = new Map<string | null, ModelUsageSummary>();
  for (const { model, usage } of observations) {
    const summary = models.get(model) ?? { model, ...emptySummary() };
    observeUsage(summary, usage);
    models.set(model, summary);
  }
  const total = emptySummary();
  for (const summary of models.values()) mergeSummary(total, summary);
  return {
    ...total,
    models: [...models.values()].sort((a, b) => compareCodeUnits(a.model ?? "", b.model ?? "")),
  };
}

export function accountingEvidence(
  nodes: ReadonlyMap<string, NodeUsageSummary>,
): AccountingEvidence {
  const family = emptySummary();
  for (const summary of nodes.values()) mergeSummary(family, summary);
  return {
    scope: "observed-assistant-messages",
    providerRequests: "not-established",
    costProvenance: "runtime-reported-unreconciled",
    family,
    nodes: [...nodes]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([sessionKey, summary]) => ({
        sessionKey,
        ...summary,
      })),
  };
}
