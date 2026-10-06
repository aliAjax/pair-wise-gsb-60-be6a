<script lang="ts">
  import { page } from '$app/stores';
  import { ledgerMeta, signalStore } from '$lib/stores/signal-store';

  const navItems = [
    { href: '/', label: '总览', short: '览' },
    { href: '/signals', label: '信号台账', short: '信' },
    { href: '/trends', label: '趋势核对', short: '趋' },
    { href: '/batches', label: '批次追踪', short: '批' },
    { href: '/audit', label: '审计报告', short: '审' }
  ];
</script>

<div class="min-h-screen bg-surface-50-950">
  <header class="sticky top-0 z-20 border-b border-surface-300-700 bg-surface-50-950/95 backdrop-blur">
    <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4 px-4 py-3 lg:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded bg-teal-700 font-bold text-white">安</div>
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-surface-900-50">医疗器械上市后安全信号核查与处置平台</p>
          <p class="text-xs text-surface-500-400">Safety Signal Operations / SvelteKit</p>
        </div>
      </div>
      <nav class="order-3 flex w-full gap-1 overflow-x-auto lg:order-none lg:ml-auto lg:w-auto" aria-label="主导航">
        {#each navItems as item}
          <a
            href={item.href}
            class="btn btn-sm whitespace-nowrap {$page.url.pathname === item.href ? 'variant-filled-primary' : 'variant-ghost-surface'}"
          >
            {item.label}
          </a>
        {/each}
      </nav>
      <div class="ml-auto hidden items-center gap-3 lg:flex">
        {#if $ledgerMeta}
          <span
            class="badge variant-soft-secondary"
            title="台账架构 v{$ledgerMeta.schemaVersion} · 全局修订 R{$ledgerMeta.revision}，各页面显示同一版本"
          >
            台账 v{$ledgerMeta.schemaVersion} · R{$ledgerMeta.revision}
          </span>
        {/if}
        <div class="text-right">
          <p class="text-xs text-surface-500-400">当前角色</p>
          <p class="text-sm font-medium">安全评审专员</p>
        </div>
        <span class="badge variant-soft-primary">在线</span>
      </div>
    </div>
  </header>

  {#if $ledgerMeta?.migrationPending}
    <div class="border-b border-amber-300 bg-amber-50">
      <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2 text-sm text-amber-950 lg:px-6">
        <span>
          旧台账迁移未完成：剩余 {$ledgerMeta.migrationRemaining} 条信号待迁移。旧数据保持可读，重试只会补录未迁移信号，不会重复导入。
          {#if $ledgerMeta.migrationError}
            <span class="text-xs">（{$ledgerMeta.migrationError}）</span>
          {/if}
        </span>
        <button class="btn btn-sm variant-filled-warning" type="button" on:click={() => signalStore.retryMigration()}>
          重试迁移
        </button>
      </div>
    </div>
  {/if}

  {#if $ledgerMeta?.persistError}
    <div class="border-b border-error-300 bg-error-50">
      <div class="mx-auto max-w-[1600px] px-4 py-2 text-sm text-error-900 lg:px-6">
        本地写入失败：{$ledgerMeta.persistError}。当前更改仅保留在本页内存中，已保存的旧数据未受影响、继续可读。
      </div>
    </div>
  {/if}

  <main class="mx-auto max-w-[1600px] px-4 py-5 lg:px-6 lg:py-7">
    <slot />
  </main>
</div>
