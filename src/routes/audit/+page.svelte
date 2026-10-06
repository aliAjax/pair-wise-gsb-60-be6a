<script lang="ts">
  import { ledgerMeta, signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: auditEntries = signals
    .flatMap((signal) => signal.audit.map((entry) => ({ ...entry, signalId: signal.id, product: signal.product })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function exportAll() {
    const meta = $ledgerMeta;
    const payload = {
      generatedAt: new Date().toISOString(),
      ledgerRevision: meta?.revision ?? null,
      schemaVersion: meta?.schemaVersion ?? null,
      signals: signals.map((signal) => ({
        id: signal.id,
        revision: signal.revision,
        product: signal.product,
        batch: signal.batch,
        status: signal.status,
        risk: signal.riskLevel,
        versions: signal.versions.map((version) => ({
          version: version.version,
          state: version.state,
          author: version.author,
          summary: version.summary,
          evidenceRefs: version.evidenceRefs,
          staleReason: version.staleReason ?? null,
          confirmedBy: version.confirmedBy ?? null
        })),
        evidence: signal.evidence.map((item) => ({
          id: item.id,
          fingerprint: item.fingerprint,
          revision: item.revision,
          sourceBatch: item.sourceBatch,
          references: item.references
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
    <p class="mt-1 text-sm text-surface-600-300">
      所有新增证据、结论版本和状态流转均保留操作者与时间；当前显示台账
      v{$ledgerMeta?.schemaVersion ?? '-'} · R{$ledgerMeta?.revision ?? '-'}，与总览、信号详情和批次追踪为同一版本。
    </p>
  </div>
  <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
</div>

<section class="rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">审计时间线</h2>
    <p class="mt-1 text-xs text-surface-500-400">共 {auditEntries.length} 条持久化记录</p>
  </div>
  <div class="space-y-5 p-5">
    {#each auditEntries as entry}
      <article class="timeline-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
          <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
        </div>
        <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
        <p class="mt-1 text-xs text-surface-500-400">{entry.signalId} · {entry.product}</p>
      </article>
    {/each}
  </div>
</section>
