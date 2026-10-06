<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    CaseVersion,
    SignalStatus,
    VersionState
  } from '$lib/models/signal';
  import { shortFingerprint } from '$lib/services/fingerprint';
  import { exportSignalReport } from '$lib/services/signal-service';
  import {
    pendingReviewVersions,
    signalStore,
    type EvidenceInput,
    type VersionInput
  } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  let actionError: string | null = null;
  let actionNotice: string | null = null;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions.reduce((max, version) => Math.max(max, version.version), 0) ?? 0) + 1;
  $: pendingVersions = signal ? pendingReviewVersions(signal) : [];

  const defaultSourceBatch = `IMP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const versionStateMeta: Record<VersionState, { label: string; badgeClass: string }> = {
    active: { label: '当前有效', badgeClass: 'bg-emerald-100 text-emerald-900' },
    pending_review: { label: '待复核', badgeClass: 'bg-amber-100 text-amber-950' },
    confirmed: { label: '复核确认', badgeClass: 'bg-teal-100 text-teal-900' },
    superseded: { label: '已取代', badgeClass: 'bg-surface-200-800 text-surface-500-400' }
  };

  const dispositionLabels: Record<CaseVersion['disposition'], string> = {
    continue_observation: '继续观察',
    risk_communication: '风险沟通',
    corrective_action: '纠正措施'
  };

  function baseRevisionOf(formData: FormData): number {
    return Number(formData.get('baseRevision') ?? 0);
  }

  function reportOutcome(outcome: { ok: boolean; message?: string }, notice: string) {
    if (outcome.ok) {
      actionNotice = notice;
    } else {
      actionError = outcome.message ?? '操作未完成，请核对后重试。';
    }
  }

  const transitionHandler: SubmitFunction = ({ formData }) => {
    const baseRevision = baseRevisionOf(formData);
    return async ({ result, update }) => {
      actionError = null;
      actionNotice = null;
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string };
        };
        if (payload.transition) {
          const outcome = await signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor,
            baseRevision
          );
          reportOutcome(outcome, '状态流转已记录。');
        }
      }
      await update({ reset: true });
    };
  };

  const evidenceHandler: SubmitFunction = ({ formData }) => {
    const baseRevision = baseRevisionOf(formData);
    return async ({ result, update }) => {
      actionError = null;
      actionNotice = null;
      if (result.type === 'success' && signal) {
        const payload = result.data as { evidence?: EvidenceInput; actor?: string };
        if (payload.evidence) {
          const outcome = await signalStore.addEvidence(
            signal.id,
            payload.evidence,
            payload.actor ?? signal.owner,
            baseRevision
          );
          if (outcome.ok) {
            actionNotice =
              outcome.value.outcome === 'associated'
                ? `内容指纹一致，已追加来源批次关联（${outcome.value.evidenceId}），未重复建档。`
                : outcome.value.outcome === 'revised'
                  ? `证据 ${outcome.value.evidenceId} 内容已修订，引用它的结论已转待复核。`
                  : `证据 ${outcome.value.evidenceId} 已登记来源批次与内容指纹。`;
          } else {
            actionError = outcome.message;
          }
        }
      }
      await update({ reset: true });
    };
  };

  const versionHandler: SubmitFunction = ({ formData }) => {
    const baseRevision = baseRevisionOf(formData);
    return async ({ result, update }) => {
      actionError = null;
      actionNotice = null;
      if (result.type === 'success' && signal) {
        const payload = result.data as { version?: VersionInput };
        if (payload.version) {
          const outcome = await signalStore.addVersion(signal.id, payload.version, baseRevision);
          reportOutcome(
            outcome,
            outcome.ok ? `结论 V${outcome.value.version} 已保存，并记录引用的证据版本指纹。` : ''
          );
        }
      }
      await update({ reset: true });
    };
  };

  const confirmReviewHandler: SubmitFunction = ({ formData }) => {
    const baseRevision = baseRevisionOf(formData);
    return async ({ result, update }) => {
      actionError = null;
      actionNotice = null;
      if (result.type === 'success' && signal) {
        const payload = result.data as {
          confirmReview?: { versionId: string; actor: string; note: string };
        };
        if (payload.confirmReview) {
          const outcome = await signalStore.confirmReview(
            signal.id,
            payload.confirmReview.versionId,
            payload.confirmReview.actor,
            payload.confirmReview.note,
            baseRevision
          );
          reportOutcome(
            outcome,
            outcome.ok ? `V${outcome.value.version} 复核确认完成，信号恢复可处置。` : ''
          );
        }
      }
      await update({ reset: true });
    };
  };

  const reopenHandler: SubmitFunction = ({ formData }) => {
    const baseRevision = baseRevisionOf(formData);
    return async ({ result, update }) => {
      actionError = null;
      actionNotice = null;
      if (result.type === 'success') {
        const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
        if (payload.reopen) {
          const outcome = await signalStore.reopen(
            payload.reopen.id,
            payload.reopen.actor,
            payload.reopen.reason,
            baseRevision
          );
          reportOutcome(outcome, '信号已重新打开。');
        }
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
        <span class="badge bg-surface-200-800">修订 R{signal.revision}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3"><RiskBadge risk={signal.riskLevel} status={signal.status} /></div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}
  {#if actionError}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{actionError}</div>
  {/if}
  {#if actionNotice}
    <div class="mb-5 rounded border border-teal-300 bg-teal-50 p-3 text-sm text-teal-900">{actionNotice}</div>
  {/if}

  {#if pendingVersions.length > 0}
    <section class="mb-6 rounded border border-amber-400 bg-amber-50 p-4">
      <h2 class="font-semibold text-amber-950">结论待复核：证据版本已变化</h2>
      <p class="mt-1 text-sm text-amber-900">
        以下结论引用的证据在其形成后发生变化，结论已失效并保留待复核。复核人确认（或形成新结论版本）前，不能继续处置本信号。
      </p>
      <div class="mt-4 space-y-4">
        {#each pendingVersions as version (version.id)}
          <article class="rounded border border-amber-300 bg-surface-50-950 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="text-xs text-surface-500-400">失效于 {version.staleAt?.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-amber-900">失效原因：{version.staleReason}</p>
            <form class="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]" method="POST" action="?/confirmReview" use:enhance={confirmReviewHandler}>
              <input type="hidden" name="id" value={signal.id} />
              <input type="hidden" name="versionId" value={version.id} />
              <input type="hidden" name="baseRevision" value={signal.revision} />
              <label>
                <span class="mb-1 block text-xs font-medium">复核人（须与作者不同）</span>
                <input class="input" name="actor" placeholder="第二名评审专员" />
              </label>
              <label>
                <span class="mb-1 block text-xs font-medium">复核意见</span>
                <input class="input" name="note" placeholder="核对当前证据后结论仍然有效的依据" />
              </label>
              <div class="flex items-end">
                <button class="btn variant-filled-primary" type="submit">确认仍然有效</button>
              </div>
            </form>
          </article>
        {/each}
      </div>
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
      <p class="mt-1 text-xs text-surface-500-400">每次流转都记录依据、操作人和时间。</p>
      {#if pendingVersions.length > 0}
        <div class="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          存在待复核结论，复核确认前不能继续处置。
        </div>
      {/if}
      <form
        class="mt-4 space-y-3"
        method="POST"
        action="?/transition"
        use:enhance={transitionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="baseRevision" value={signal.revision} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus" disabled={pendingVersions.length > 0}>
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论"></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit" disabled={pendingVersions.length > 0}>
          提交状态流转
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
            use:enhance={reopenHandler}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input type="hidden" name="baseRevision" value={signal.revision} />
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
          每项证据登记来源批次与内容指纹；同一指纹只追加关联，内容修订保留历史并触发结论复核。
        </p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix evidence={signal.evidence} />
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/evidence"
        use:enhance={evidenceHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="baseRevision" value={signal.revision} />
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
          <span class="mb-1 block text-sm font-medium">来源批次</span>
          <input class="input" name="sourceBatch" value={defaultSourceBatch} />
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
        保存时将记录当前 {signal.evidence.length} 项证据的版本指纹，作为结论引用的证据基线。
      </p>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/version"
        use:enhance={versionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="baseRevision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition">
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2"></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit">保存为 V{nextVersion}</button>
        </div>
      </form>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version (version.id)}
          <article class="border-l-2 pl-4 {version.state === 'pending_review' ? 'border-amber-500' : version.state === 'superseded' ? 'border-surface-300-700' : 'border-teal-600'}">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <div class="flex items-center gap-2">
                <span class="badge {versionStateMeta[version.state].badgeClass}">{versionStateMeta[version.state].label}</span>
                <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
              </div>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-1 text-xs text-surface-500-400">建议处置：{dispositionLabels[version.disposition]}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
            {#if version.evidenceRefs.length > 0}
              <div class="mt-2 flex flex-wrap gap-1">
                {#each version.evidenceRefs as ref}
                  <span class="badge bg-surface-200-800 text-xs" title="引用证据 {ref.evidenceId} 的修订 r{ref.revision}">
                    {ref.evidenceId} · r{ref.revision} · {shortFingerprint(ref.fingerprint)}
                  </span>
                {/each}
              </div>
            {/if}
            {#if version.state === 'pending_review' && version.staleReason}
              <p class="mt-2 text-xs text-amber-800">失效原因:{version.staleReason}</p>
            {/if}
            {#if version.confirmedBy}
              <p class="mt-2 text-xs text-teal-800">
                复核人 {version.confirmedBy} 于 {version.confirmedAt?.slice(0, 16).replace('T', ' ')} 确认：{version.reviewNote}
              </p>
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
              <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
