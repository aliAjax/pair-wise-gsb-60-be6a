<script lang="ts">
  import LedgerStamp from '$lib/components/LedgerStamp.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import {
    ledgerRevisionStore,
    migrationStateStore,
    primeMigrationFailureDemo,
    signalStore
  } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: migration = $migrationStateStore;
  $: ledgerRevision = $ledgerRevisionStore;
  $: openSignals = signals.filter((signal) => !signal.reviewBlock && signal.status !== 'closed');
  $: criticalSignals = signals.filter(
    (signal) => signal.riskLevel === 'critical' || signal.riskLevel === 'high'
  );
  $: pendingReview = signals.filter((signal) => signal.reviewBlock);
  $: overdueTasks = signals.flatMap((signal) =>
    signal.tasks
      .filter((task) => task.status !== 'done' && task.dueAt < new Date().toISOString().slice(0, 10))
      .map((task) => ({ ...task, signalId: signal.id }))
  );

  $: metrics = [
    { label: '开放信号', value: openSignals.length, note: '含调查、观察与处置队列（待复核单独统计）' },
    { label: '高及以上风险', value: criticalSignals.length, note: '需复核人优先确认' },
    {
      label: '待复核（结论失效）',
      value: pendingReview.length,
      note: '被引用证据变化，复核确认前锁定处置'
    },
    { label: '逾期任务', value: overdueTasks.length, note: '按任务截止日计算' }
  ];

  let migrationNotice: string | null = null;

  function retry() {
    migrationNotice = null;
    signalStore.retryMigration();
    const state = $migrationStateStore;
    migrationNotice =
      state.status === 'completed'
        ? '迁移重试完成：全部信号已写入版本化台账，未重复导入。'
        : `迁移仍有 ${state.total - state.migrated} 个信号未完成，旧台账保持可读，可再次重试。`;
  }
</script>

<svelte:head><title>总览 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <p class="text-sm font-medium text-teal-700">上市后安全运营</p>
    <h1 class="mt-1 text-2xl font-semibold tracking-normal">信号核查总览</h1>
    <p class="mt-2 text-sm text-surface-600-300">汇总投诉、维修、不良事件和现场报告，按风险推进核查闭环。</p>
  </div>
  <div class="flex items-center gap-3">
    <LedgerStamp scope="总览" />
    <a class="btn variant-filled-primary" href="/signals">进入信号台账</a>
  </div>
</div>

{#if migration.status === 'failed'}
  <section class="mb-6 rounded border-2 border-error-400 bg-error-50 p-5 text-error-900">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">旧台账迁移中断（旧数据继续可读）</h2>
        <p class="mt-2 text-sm">
          已迁移 {migration.migrated}/{migration.total} 个信号。已迁移部分可正常使用，未迁移信号以只读形式展示，
          重试只会补写未迁移信号，已迁移信号不会重复导入。
        </p>
        {#if migration.error}
          <p class="mt-2 text-xs">失败原因：{migration.error}（{migration.failedAt?.slice(0, 19).replace('T', ' ')}）</p>
        {/if}
        {#if migrationNotice}
          <p class="mt-2 rounded bg-white/70 p-2 text-xs">{migrationNotice}</p>
        {/if}
      </div>
      <button class="btn variant-filled-primary" type="button" on:click={retry}>重试迁移（只补未迁移信号）</button>
    </div>
  </section>
{:else if migration.status === 'completed'}
  <section class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded border border-teal-300 bg-teal-50 p-4 text-sm text-teal-900">
    <p>
      可恢复版本台账已就绪（全局版本 V{ledgerRevision}）。
      {#if migration.migrated > 0}上次旧台账迁移已完成：{migration.migrated} 个信号升级为版本结构。{/if}
    </p>
    <button class="btn btn-sm variant-ghost-surface" type="button" on:click={primeMigrationFailureDemo}>
      演练：模拟迁移写入失败
    </button>
  </section>
{/if}

<section class="workspace-grid mb-6">
  {#each metrics as metric}
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 sm:col-span-6 xl:col-span-3">
      <p class="text-sm text-surface-500-400">{metric.label}</p>
      <p class="metric-value mt-2 text-3xl font-semibold {metric.label.includes('待复核') && metric.value > 0
        ? 'text-red-700'
        : ''}">{metric.value}</p>
      <p class="mt-2 text-xs text-surface-500-400">{metric.note}</p>
    </article>
  {/each}
</section>

{#if pendingReview.length > 0}
  <section class="mb-6 rounded border border-error-300 bg-error-50 p-4">
    <h2 class="font-semibold text-error-900">待复核信号（处置锁定中）</h2>
    <div class="mt-3 grid gap-3 md:grid-cols-2">
      {#each pendingReview as signal}
        <a class="block rounded border border-error-200 bg-white p-3 hover:bg-red-50" href={`/signals/${signal.id}`}>
          <p class="text-xs text-surface-500-400">{signal.id} · {signal.product}</p>
          <p class="mt-1 text-sm font-medium text-error-900">{signal.reviewBlock?.reason}</p>
        </a>
      {/each}
    </div>
  </section>
{/if}

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="flex items-center justify-between border-b border-surface-300-700 px-4 py-3">
      <div>
        <h2 class="font-semibold">近期信号</h2>
        <p class="text-xs text-surface-500-400">按最后更新时间排序，与详情/批次/审计读取同一台账版本</p>
      </div>
      <a class="text-sm text-primary-700-300 hover:underline" href="/signals">查看全部</a>
    </div>
    <div class="divide-y divide-surface-300-700">
      {#each signals.slice(0, 4) as signal}
        <a class="block px-4 py-4 hover:bg-surface-200-800" href={`/signals/${signal.id}`}>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-xs text-surface-500-400">{signal.id} · {signal.product}</p>
              <h3 class="mt-1 font-medium">{signal.title}</h3>
            </div>
            <RiskBadge risk={signal.riskLevel} status={signal.status} />
          </div>
          <p class="mt-2 text-sm text-surface-600-300">
            {signal.reportCount} 条报告 · 发生率 {signal.occurrenceRate.toFixed(2)}% · 负责人 {signal.owner} · R{signal.revision}
          </p>
        </a>
      {/each}
    </div>
  </section>

  <aside class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">任务与复核提醒</h2>
      <p class="text-xs text-surface-500-400">优先处理逾期及高风险事项</p>
    </div>
    <div class="space-y-4 p-4">
      {#each signals
        .flatMap((signal) => signal.tasks.map((task) => ({ ...task, signalId: signal.id })))
        .filter((task) => task.status !== 'done')
        .slice(0, 5) as task}
        <div class="border-l-2 border-amber-500 pl-3">
          <p class="text-sm font-medium">{task.title}</p>
          <p class="mt-1 text-xs text-surface-500-400">{task.signalId} · {task.owner} · 截止 {task.dueAt}</p>
        </div>
      {/each}
    </div>
  </aside>
</div>
