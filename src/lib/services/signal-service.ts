import { get } from 'svelte/store';
import type { SignalCase, SignalFilters } from '$lib/models/signal';
import { ledgerMeta, signalStore } from '$lib/stores/signal-store';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listSignals(filters: SignalFilters = {}): Promise<SignalCase[]> {
  await wait(80);
  const query = filters.query?.trim().toLowerCase();

  return signalStore
    .getSnapshot()
    .filter((signal) => {
      const matchesQuery =
        !query ||
        [signal.id, signal.title, signal.product, signal.batch]
          .join(' ')
          .toLowerCase()
          .includes(query);
      const matchesStatus = !filters.status || filters.status === 'all' || signal.status === filters.status;
      const matchesRisk =
        !filters.riskLevel || filters.riskLevel === 'all' || signal.riskLevel === filters.riskLevel;
      const matchesSource =
        !filters.sourceType || filters.sourceType === 'all' || signal.sourceType === filters.sourceType;
      return matchesQuery && matchesStatus && matchesRisk && matchesSource;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function exportSignalReport(id: string) {
  const signal = get(signalStore).find((item) => item.id === id);
  if (!signal) return;
  const meta = get(ledgerMeta);
  const currentVersion = signal.versions.find(
    (version) => version.state === 'active' || version.state === 'confirmed'
  );

  const report = {
    generatedAt: new Date().toISOString(),
    ledgerRevision: meta.revision,
    schemaVersion: meta.schemaVersion,
    signalRevision: signal.revision,
    product: signal.product,
    batch: signal.batch,
    status: signal.status,
    riskLevel: signal.riskLevel,
    conclusion: currentVersion?.summary ?? '尚未形成核查结论',
    versions: signal.versions.map((version) => ({
      version: version.version,
      state: version.state,
      author: version.author,
      summary: version.summary,
      disposition: version.disposition,
      createdAt: version.createdAt,
      evidenceRefs: version.evidenceRefs,
      staleReason: version.staleReason ?? null,
      confirmedBy: version.confirmedBy ?? null,
      confirmedAt: version.confirmedAt ?? null
    })),
    evidence: signal.evidence.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      source: item.source,
      sourceBatch: item.sourceBatch,
      fingerprint: item.fingerprint,
      revision: item.revision,
      strength: item.strength,
      batch: item.batch,
      note: item.note,
      references: item.references
    })),
    audit: signal.audit
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${signal.id}-traceability-report.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
