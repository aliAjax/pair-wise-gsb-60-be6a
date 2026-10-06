<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { useQueryClient } from '@tanstack/svelte-query';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import LedgerStamp from '$lib/components/LedgerStamp.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    CaseVersion,
    EvidenceItem,
    EvidenceInput,
    MutationResult,
    SignalStatus
  } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  const queryClient = useQueryClient();

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  $: reviewLocked = Boolean(signal?.reviewBlock);

  let banner: { tone: 'error' | 'success'; message: string } | null = null;

  function notify(event: CustomEvent<{ tone: 'error' | 'success'; message: string }>) {
    banner = event.detail;
    queryClient.invalidateQueries({ queryKey: ['signals'] });
  }

  function apply(result: MutationResult, successMessage?: string) {
    if (result.ok) {
      banner = { tone: 'success', message: successMessage ?? '已写入版本化台账。' };
      queryClient.invalidateQueries({ queryKey: ['signals'] });
    } else {
      banner = { tone: 'error', message: result.message ?? '提交失败。' };
    }
  }

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const versionStateLabels: Record<CaseVersion['state'], string> = {
    active: '现行有效',
    stale_pending_review: '失效 · 待复核',
    superseded: '已被替代'
  };

  const versionStateClass: Record<CaseVersion['state'], string> = {
    active: 'variant-soft-secondary',
    stale_pending_review: 'variant-soft-error',
    superseded: 'variant-soft-surface'
  };

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition: {
            id: string;
            expectedRevision: number;
            nextStatus: SignalStatus;
            reason: string;
            actor: string;
          };
        };
        apply(
          signalStore.transition(
            payload.transition.id,
            payload.transition.expectedRevision,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          ),
          '状态流转已记录。'
        );
      }
      await update({ reset: true });
    };
  };
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal}
  <section class="rounded border border-error-300 bg-error-50 p-6 text-error-900">
    未找到信号 {data.id}。它可能已被本地数据重置。
  </section>
{:else}
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
        <span class="text-surface-400">/</span>
        <span class="text-sm text-surface-500-400">{signal.id}</span>
        <LedgerStamp scope="信号详情" />
        <span class="badge variant-soft-surface">信号修订 R{signal.revision}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3"><RiskBadge risk={signal.riskLevel} status={signal.status} /></div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if banner}
    <div
      class="mb-5 rounded border p-3 text-sm {banner.tone === 'error'
        ? 'border-error-300 bg-error-50 text-error-900'
        : 'border-teal-300 bg-teal-50 text-teal-900'}"
    >
      {banner.message}
    </div>
  {:else if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}

  {#if reviewLocked && signal.reviewBlock}
    <section class="mb-6 rounded border-2 border-error-400 bg-error-50 p-5 text-error-900">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">待复核锁定：引用证据已变化</h2>
          <p class="mt-2 text-sm leading-6">{signal.reviewBlock.reason}</p>
          <p class="mt-2 text-xs">
            自 {signal.reviewBlock.since.slice(0, 16).replace('T', ' ')} 起锁定；复核确认前不能继续处置（状态流转、形成结论均已禁用），证据补入不受影响。
          </p>
        </div>
        <span class="badge variant-soft-error">禁止处置</span>
      </div>

      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/review"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as {
                review: {
                  id: string;
                  expectedRevision: number;
                  reviewer: string;
                  disposition: CaseVersion['disposition'];
                  summary: string;
                  rationale: string;
                };
              };
              apply(
                signalStore.confirmReview(
                  payload.review.id,
                  payload.review.expectedRevision,
                  {
                    reviewer: payload.review.reviewer,
                    disposition: payload.review.disposition,
                    summary: payload.review.summary,
                    rationale: payload.review.rationale
                  }
                ),
                '复核确认完成：失效旧结论保留，新结论生效，处置锁已解除。'
              );
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="expectedRevision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">复核人</span>
          <input class="input" name="reviewer" required minlength="2" placeholder="与结论作者不同的复核人" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">复核后处置意见</span>
          <select class="select" name="disposition">
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">复核结论摘要</span>
          <textarea class="textarea" name="summary" rows="2" required minlength="8"></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">复核依据（确认证据变化后的判断）</span>
          <textarea class="textarea" name="rationale" rows="2" required minlength="6"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-error" type="submit">复核确认并解除锁定</button>
        </div>
      </form>
    </section>
  {/if}

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{signal.affectedBatches.join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {signal.updatedAt.slice(0, 16).replace('T', ' ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露</p>
          <p class="metric-value mt-1 font-medium">{signal.reportCount} 条 / {signal.exposedUnits} 台</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率</p>
          <p class="metric-value mt-1 font-medium">{signal.occurrenceRate.toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
      </div>
    </article>

    <aside class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-4">
      <h2 class="font-semibold">状态流转</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        每次流转携带信号修订号；两个标签页并发时，后到者必须重新校验，不能覆盖先行结果。
      </p>
      <form class="mt-4 space-y-3" method="POST" action="?/transition" use:enhance={transitionHandler}>
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="expectedRevision" value={signal.revision} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus" disabled={reviewLocked}>
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} disabled={reviewLocked} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea
            class="textarea"
            name="reason"
            rows="3"
            placeholder="说明新增证据、风险判断或复核结论"
            disabled={reviewLocked}
          ></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit" disabled={reviewLocked}>
          {reviewLocked ? '待复核确认，禁止处置' : '提交状态流转'}
        </button>
      </form>

      {#if signal.status === 'closed'}
        <div class="section-rule mt-5 pt-5">
          <h3 class="font-medium">新事件重新打开</h3>
          <p class="mt-1 text-xs text-surface-500-400">关闭信号收到新报告时，不允许静默修改结论。</p>
          <form
            class="mt-3 space-y-3"
            method="POST"
            action="?/reopen"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'success') {
                  const payload = result.data as {
                    reopen: { id: string; expectedRevision: number; actor: string; reason: string };
                  };
                  apply(
                    signalStore.reopen(
                      payload.reopen.id,
                      payload.reopen.expectedRevision,
                      payload.reopen.actor,
                      payload.reopen.reason
                    ),
                    '信号已重新打开，原结论保留为历史版本。'
                  );
                }
                await update({ reset: true });
              }}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input type="hidden" name="expectedRevision" value={signal.revision} />
            <input class="input" name="actor" value={signal.owner} aria-label="操作人" />
            <textarea class="textarea" name="reason" rows="2" placeholder="描述新报告及其影响"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">重新打开信号</button>
          </form>
        </div>
      {/if}
    </aside>
  </section>

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">
          证据按内容指纹去重：同指纹只追加来源批次关联；修订内容会使引用它的旧结论失效。
        </p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix
      evidence={signal.evidence}
      versions={signal.versions}
      signalId={signal.id}
      expectedRevision={signal.revision}
      reviewLocked={reviewLocked}
      on:notify={notify}
    />
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        登记来源批次与内容指纹；同指纹证据不会重复入库，只把新来源批次追加为关联。
      </p>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/evidence"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as {
                expectedRevision: number;
                evidence: EvidenceInput;
                actor: string;
              };
              apply(
                signalStore.addEvidence(
                  signal.id,
                  payload.expectedRevision,
                  payload.evidence,
                  payload.actor
                )
              );
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="expectedRevision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType">
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
            <option value="field_report">现场报告</option>
            <option value="test">测试</option>
            <option value="literature">文献</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据强度</span>
          <select class="select" name="strength">
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源批次（导入批次/系统批次号）</span>
          <input class="input" name="sourceBatch" placeholder="如 BATCH-20260930-A" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" value={signal.batch} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">录入人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">核查说明</span>
          <textarea class="textarea" name="note" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit">加入证据矩阵</button>
        </div>
      </form>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        结论固化当前全部证据的指纹快照；被引用证据变化后，本结论自动失效转待复核。
      </p>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/version"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as {
                expectedRevision: number;
                version: Omit<CaseVersion, 'id' | 'version' | 'createdAt' | 'evidenceRefs' | 'state'>;
                actor: string;
              };
              apply(
                signalStore.addVersion(signal.id, payload.expectedRevision, payload.version),
                `结论 V${nextVersion} 已保存，证据指纹快照随之固化。`
              );
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="expectedRevision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} disabled={reviewLocked} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition" disabled={reviewLocked}>
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2" disabled={reviewLocked}></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3" disabled={reviewLocked}></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit" disabled={reviewLocked}>
            {reviewLocked ? '待复核确认，禁止形成新结论' : `保存为 V${nextVersion}`}
          </button>
        </div>
      </form>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      <p class="mt-1 text-xs text-surface-500-400">失效与被替代的版本均保留，可恢复查看其引用的证据快照。</p>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          <article
            class="border-l-2 pl-4 {version.state === 'active'
              ? 'border-teal-600'
              : version.state === 'stale_pending_review'
                ? 'border-red-600'
                : 'border-surface-400'}"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="badge {versionStateClass[version.state]}">{versionStateLabels[version.state]}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{version.createdAt.slice(0, 16).replace('T', ' ')}</p>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
            <p class="mt-2 text-xs text-surface-500-400">
              引用证据（{version.evidenceRefs.length}）：
              {version.evidenceRefs
                .map((ref) => `${ref.title}[${ref.fingerprint.slice(8, 18)}]`)
                .join('、')}
            </p>
            {#if version.state === 'stale_pending_review' && version.staleReason}
              <p class="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{version.staleReason}</p>
            {/if}
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 space-y-5">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
              <span class="text-xs text-surface-500-400">
                {entry.createdAt.slice(0, 16).replace('T', ' ')} · 台账 V{entry.dataVersion}
              </span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
