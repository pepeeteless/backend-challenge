// Contadores operacionais por processo; nunca usados para garantias financeiras.
export const reconciliationMetrics = {
  checks: 0,
  divergences: 0,
  record(consistent: boolean) {
    this.checks += 1;
    if (!consistent) this.divergences += 1;
  },
  render(): string {
    return `# TYPE reconciliation_checks_total counter\nreconciliation_checks_total ${this.checks}\n` +
      `# TYPE reconciliation_divergences_total counter\nreconciliation_divergences_total ${this.divergences}\n`;
  },
};

type Source = "http" | "sqs" | "reference";
type RetryComponent = "sqs" | "outbox" | "reference";
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5, 10, Infinity];
const durations = new Map<Source, { count: number; sum: number; buckets: number[] }>();
const retries: Record<RetryComponent, number> = { sqs: 0, outbox: 0, reference: 0 };
const countedErrors = new WeakSet<object>();

export const operationalMetrics = {
  duplicates: 0,
  dlq: 0,
  lockConflicts: 0,
  retry(component: RetryComponent) { retries[component] += 1; },
  observe(source: Source, seconds: number) {
    const sample = durations.get(source) ?? { count: 0, sum: 0, buckets: bounds.map(() => 0) };
    sample.count += 1;
    sample.sum += seconds;
    bounds.forEach((bound, index) => { if (seconds <= bound) sample.buckets[index]! += 1; });
    durations.set(source, sample);
  },
  databaseError(error: unknown) {
    if (!error || typeof error !== "object" || !("code" in error) || countedErrors.has(error)) return;
    if (["55P03", "40P01", "40001"].includes(String(error.code))) {
      countedErrors.add(error);
      this.lockConflicts += 1;
    }
  },
  render(): string {
    let output = `# TYPE wager_duplicates_total counter\nwager_duplicates_total ${this.duplicates}\n` +
      `# TYPE sqs_dlq_sent_total counter\nsqs_dlq_sent_total ${this.dlq}\n` +
      `# TYPE database_lock_conflicts_total counter\ndatabase_lock_conflicts_total ${this.lockConflicts}\n` +
      "# TYPE worker_retries_total counter\n";
    for (const component of ["sqs", "outbox", "reference"] as const) output += `worker_retries_total{component="${component}"} ${retries[component]}\n`;
    output += "# TYPE transaction_processing_seconds histogram\n";
    for (const source of ["http", "sqs", "reference"] as const) {
      const sample = durations.get(source) ?? { count: 0, sum: 0, buckets: bounds.map(() => 0) };
      bounds.forEach((bound, i) => { output += `transaction_processing_seconds_bucket{source="${source}",le="${bound === Infinity ? "+Inf" : bound}"} ${sample.buckets[i]}\n`; });
      output += `transaction_processing_seconds_count{source="${source}"} ${sample.count}\ntransaction_processing_seconds_sum{source="${source}"} ${sample.sum}\n`;
    }
    return output;
  },
};
