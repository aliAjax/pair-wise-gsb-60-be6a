<script lang="ts">
  import { enhance } from '$app/forms';
  import { createEventDispatcher } from 'svelte';
  import type { CaseVersion, EvidenceItem, MutationResult } from '$lib/models/signal';
  import { shortFingerprint } from '$lib/services/fingerprint';
  import { signalStore } from '$lib/stores/signal-store';

  export let evidence: EvidenceItem[];
  export let signalId = '';
  export let expectedRevision = 0;
  export let reviewLocked = false;
  export let versions: CaseVersion[] = [];

  const dispatch = createEventDispatcher<{
    notify: { tone: 'error' | 'success'; message: string };
  }>();

  let openRevisionId: string | null = null;

  const strengthLabels: Record<EvidenceItem['strength'], string> = {
    strong: '强支持',
    moderate: '中等支持',
    weak: '弱支持',
    contrary: '相反证据'
  };

  const typeLabels: Record<EvidenceItem['type'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告',
    test: '测试',
    literature: '文献'
  };

  function citedLabels(item: EvidenceItem): string[] {
    return versions
      .filter((version) => version.evidenceRefs.some((ref) => ref.evidenceId === item.id))
      .map((version) => `V${version.version}`);
  }

  const reviseHandler = (item: EvidenceItem) =>
    (() => {
      return async ({ result, update }) => {
        if (result.type === 'success') {
          const payload = result.data as {
            expectedRevision: number;
            revision: {
              evidenceId: string;
              source: string;
              sourceBatch: string;
              strength: EvidenceItem['strength'];
              batch: string;
              note: string;
            };
            actor: string;
          };
          const outcome: MutationResult = signalStore.reviseEvidence(
            signalId,
            payload.expectedRevision,
            payload.revision.evidenceId,
            {
              source: payload.revision.source,
              sourceBatch: payload.revision.sourceBatch,
              strength: payload.revision.strength,
              batch: payload.revision.batch,
              note: payload.revision.note
            },
            payload.actor
          );
          if (outcome.ok) {
            openRevisionId = null;
            dispatch('notify', {
              tone: 'success',
              message:
                '证据修订已保存为新版本；引用它的旧结论已失效并转待复核，复核人确认前信号锁定。'
            });
          } else {
            dispatch('notify', { tone: 'error', message: outcome.message ?? '证据修订失败。' });
          }
        }
        await update();
      };
    }) satisfies Parameters<typeof enhance>[1];
</script>

<div class="grid gap-3 lg:grid-cols-2">
  {#each evidence as item (item.id)}
    <article
      class="rounded border border-surface-300-700 bg-surface-100-900 p-4 {item.strength === 'strong'
        ? 'evidence-strong'
        : item.strength === 'contrary'
          ? 'evidence-conflicting'
          : 'evidence-weak'}"
    >
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">{typeLabels[item.type]}</p>
          <h4 class="mt-1 font-semibold">{item.title}</h4>
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="badge">{strengthLabels[item.strength]}</span>
          {#if citedLabels(item).length > 0}
            <span class="badge variant-soft-secondary">被结论 {citedLabels(item).join('、')} 引用</span>
          {/if}
        </div>
      </div>
      <p class="mt-3 text-sm text-surface-600-300">{item.note}</p>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-500-400">
        <span>来源：{item.source}</span>
        <span>来源批次：{item.sourceBatch}</span>
        <span>关联批号：{item.batch}</span>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-500-400">
        <span title="同一内容指纹的证据只追加关联，不重复入库">
          内容指纹：<code class="font-mono">{shortFingerprint(item.fingerprint)}</code>
        </span>
        <span>关联批次追加：{item.linkedBatches.length} 个（{item.linkedBatches.join('、')}）</span>
        <span>修订：{item.revisions.length} 次</span>
        <span>录入：{item.createdAt.slice(0, 10)}</span>
      </div>

      {#if item.revisions.length > 0}
        <details class="mt-3 text-xs text-surface-500-400">
          <summary class="cursor-pointer">查看历史修订（保留 {item.revisions.length} 版）</summary>
          <ul class="mt-2 space-y-2 border-l border-surface-300-700 pl-3">
            {#each item.revisions as revision}
              <li>
                <p>
                  第 {revision.revision} 版 · {revision.actor} · {revision.changedAt.slice(0, 16).replace('T', ' ')}
                </p>
                <p class="mt-0.5">{revision.note}</p>
                <p class="mt-0.5 font-mono">{shortFingerprint(revision.fingerprint)}</p>
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if signalId}
        <div class="mt-3">
          {#if openRevisionId === item.id}
            <form method="POST" action="?/reviseEvidence" use:enhance={reviseHandler(item)} class="grid gap-2">
              <input type="hidden" name="id" value={signalId} />
              <input type="hidden" name="evidenceId" value={item.id} />
              <input type="hidden" name="expectedRevision" value={expectedRevision} />
              <div class="grid gap-2 md:grid-cols-2">
                <label>
                  <span class="mb-1 block text-xs font-medium">来源</span>
                  <input class="input input-sm" name="source" value={item.source} />
                </label>
                <label>
                  <span class="mb-1 block text-xs font-medium">来源批次</span>
                  <input class="input input-sm" name="sourceBatch" value={item.sourceBatch} />
                </label>
                <label>
                  <span class="mb-1 block text-xs font-medium">证据强度</span>
                  <select class="select input-sm" name="strength">
                    <option value="strong" selected={item.strength === 'strong'}>强支持</option>
                    <option value="moderate" selected={item.strength === 'moderate'}>中等支持</option>
                    <option value="weak" selected={item.strength === 'weak'}>弱支持</option>
                    <option value="contrary" selected={item.strength === 'contrary'}>相反证据</option>
                  </select>
                </label>
                <label>
                  <span class="mb-1 block text-xs font-medium">关联批号</span>
                  <input class="input input-sm" name="batch" value={item.batch} />
                </label>
              </div>
              <label>
                <span class="mb-1 block text-xs font-medium">修订后核查说明（内容变化将使引用结论失效）</span>
                <textarea class="textarea" name="note" rows="2">{item.note}</textarea>
              </label>
              <label class="max-w-[220px]">
                <span class="mb-1 block text-xs font-medium">操作人</span>
                <input class="input input-sm" name="actor" required minlength="2" />
              </label>
              <div class="flex gap-2">
                <button class="btn btn-sm variant-filled-error" type="submit">提交修订</button>
                <button class="btn btn-sm variant-ghost-surface" type="button" on:click={() => (openRevisionId = null)}>
                  取消
                </button>
              </div>
            </form>
          {:else}
            <button
              class="btn btn-sm variant-ghost-surface"
              type="button"
              disabled={reviewLocked}
              title={reviewLocked ? '待复核锁定解除后才能修订证据' : '修订证据内容（不是追加新证据）'}
              on:click={() => (openRevisionId = item.id)}
            >
              修订证据内容
            </button>
          {/if}
        </div>
      {/if}
    </article>
  {/each}
</div>
