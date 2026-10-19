import {
  proposedMetric,
  type IncomeItem,
  type PERIOD_FIELDS,
  type RequestedMetric,
  type ScopeFacet,
  type ScopeProposal,
} from "../src/research-scope.ts";

type Metric = string | { metric: string; adjustment?: string; qualifier?: string };

// A model's proposal (scope-proposal.ts) as a test writes it: catalog metric
// keys (or a key with its adjustment or qualifier), facets, what it turns off,
// and income items.
export function proposal(reply: {
  metrics?: ReadonlyArray<Metric>;
  asks?: ReadonlyArray<ScopeFacet>;
  off?: ReadonlyArray<ScopeFacet | (typeof PERIOD_FIELDS)[number]>;
  offMetrics?: ReadonlyArray<Metric>;
  items?: ReadonlyArray<IncomeItem>;
} = {}): ScopeProposal {
  return {
    metrics: (reply.metrics ?? []).map(built),
    asks: new Set(reply.asks),
    turns_off: { facets: new Set(reply.off), metrics: new Set((reply.offMetrics ?? []).map((metric) => built(metric).metric_key)) },
    income_items: reply.items ?? [],
  };
}

function built(metric: Metric): RequestedMetric {
  const { metric: key, adjustment = null, qualifier = null } = typeof metric === "string" ? { metric } : metric;
  const named = proposedMetric(key, adjustment, qualifier);
  if (!named) throw new Error(`not in the catalog: ${JSON.stringify(metric)}`);
  return named;
}
