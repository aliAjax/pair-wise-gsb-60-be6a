<script lang="ts">
  import LedgerStamp from '$lib/components/LedgerStamp.svelte';
  import { ledgerRevisionStore, signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: ledgerRevision = $ledgerRevisionStore;
  $: auditEntries = signals
    .flatMap((signal) => signal.audit.map((entry) => ({ ...entry, signalId: signal.id, product: signal.product })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function exportAll() {
    const payload = {
      generatedAt: new Date().toISOString(),
      ledgerVersion: signalStore.getLedgerRevision(),
      signals: signals.map((signal) => ({
        id: signal.id,
        product: signal.product,
        batch: signal.batch,
        status: signal.status,
        risk: signal.riskLevel,
        signalRevision: signal.revision,
        reviewBlock: signal.reviewBlock ?? null,
        conclusion: signal.versions.find((version) => version.state === 'active') ?? null,
        versions: signal.versions.map((version) => ({
          version: version.version,
          state: version.state,
          author: version.author,
          summary: version.summary,
          evidenceRefs: version.evidenceRefs,
          staleReason: version.staleReason ?? null,
          createdAt: version.createdAt
        })),
        evidence: signal.evidence.map((item) => ({
          id: item.id,
          title: item.title,
          source: item.source,
          sourceBatch: item.sourceBatch,
          fingerprint: item.fingerprint,
          linkedBatches: item.linkedBatches,
          revisions: item.revisions.length
        })),
        audit: signal.audit
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'medical-device-safety-audit-report.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head><title>审计报告 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">审计与可追溯报告</h1>
    <p class="mt-1 text-sm text-surface-600-300">证据补入（含来源批次与指纹）、证据修订、结论失效、复核确认和状态流转均保留操作者与时间。</p>
  </div>
  <div class="flex items-center gap-3">
    <LedgerStamp scope="审计" />
    <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
  </div>
</div>

<section class="rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">审计时间线</h2>
    <p class="mt-1 text-xs text-surface-500-400">
      共 {auditEntries.length} 条记录 · 全部来自台账版本 V{ledgerRevision}（每条标注写入时的版本号）
    </p>
  </div>
  <div class="space-y-5 p-5">
    {#each auditEntries as entry}
      <article class="timeline-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
          <span class="text-xs text-surface-500-400">
            {entry.createdAt.slice(0, 16).replace('T', ' ')} · 台账 V{entry.dataVersion}
          </span>
        </div>
        <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
        <p class="mt-1 text-xs text-surface-500-400">{entry.signalId} · {entry.product}</p>
      </article>
    {/each}
  </div>
</section>
