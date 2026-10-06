import { check, installLocalStorage, summary } from './harness';

installLocalStorage();

const { signalStore, ledgerMeta, pendingReviewVersions } = await import('../src/lib/stores/signal-store');
const { evidenceFingerprint } = await import('../src/lib/services/fingerprint');
const { get } = await import('svelte/store');

const SIGNAL = 'SIG-2026-018';

function current() {
  const signal = signalStore.getSnapshot().find((item) => item.id === SIGNAL);
  if (!signal) throw new Error('信号不存在');
  return signal;
}

console.log('— 指纹与去重 —');
{
  const base = {
    type: 'complaint' as const,
    title: '华东区域 11 起同类投诉',
    source: '客服工单系统',
    batch: 'IP8-260401',
    note: '报警发生时间集中在装机后第 7 至 14 天。',
    strength: 'strong' as const
  };
  check('相同内容指纹一致', evidenceFingerprint(base) === evidenceFingerprint({ ...base }));
  check(
    '内容变化指纹不同',
    evidenceFingerprint(base) !== evidenceFingerprint({ ...base, note: '修订后的说明' })
  );
  check('空白差异不影响指纹', evidenceFingerprint(base) === evidenceFingerprint({ ...base, title: '  华东区域 11 起同类投诉 ' }));
}

console.log('— 初始状态 —');
{
  const signal = current();
  check('种子数据带修订号', signal.revision === 1);
  check('种子证据带指纹与来源批次', signal.evidence.every((item) => item.fingerprint.length === 16 && item.sourceBatch === 'SEED-2026Q3'));
  check('种子结论为有效且引用证据版本', signal.versions[0].state === 'active' && signal.versions[0].evidenceRefs.length === signal.evidence.length);
}

console.log('— 同一指纹只追加关联 —');
{
  const before = current();
  const rev = before.revision;
  const count = before.evidence.length;
  const existing = before.evidence.find((item) => item.id === 'E-018-01');
  if (!existing) throw new Error('缺少种子证据');
  const outcome = await signalStore.addEvidence(
    SIGNAL,
    {
      type: existing.type,
      title: existing.title,
      source: existing.source,
      sourceBatch: 'IMP-20261002',
      strength: existing.strength,
      batch: existing.batch,
      note: existing.note
    },
    '林澈',
    rev
  );
  const after = current();
  check('返回关联追加', outcome.ok && outcome.value.outcome === 'associated', outcome);
  check('证据数量不变', after.evidence.length === count);
  check('关联批次追加', (after.evidence.find((i) => i.id === 'E-018-01')?.references.length ?? 0) === 2);
  check('结论不受影响', after.versions[0].state === 'active');
}

console.log('— 后到者不得覆盖先行结果 —');
{
  const rev = current().revision;
  const first = await signalStore.addEvidence(
    SIGNAL,
    {
      type: 'test',
      title: '现场复现压力测试',
      source: '质量实验室',
      sourceBatch: 'IMP-20261002',
      strength: 'strong',
      batch: 'IP8-260401',
      note: '按现场安装扭矩复现了阻塞报警。'
    },
    '周宁',
    rev
  );
  check('先行提交成功', first.ok, first);
  const stale = await signalStore.transition(SIGNAL, 'closed', '基于旧修订号的提交', '林澈', rev);
  check('后到提交被判冲突', !stale.ok && stale.code === 'conflict', stale);
  check('状态未被覆盖', current().status === 'investigating');
  check('审计保留先行记录', current().audit.some((entry) => entry.action === '新增证据' && entry.actor === '周宁'));
}

console.log('— 新证据使结论失效待复核，处置被阻断 —');
{
  const signal = current();
  check('结论转待复核', pendingReviewVersions(signal).length === 1, signal.versions.map((v) => v.state));
  check('失效原因记录', Boolean(signal.versions[0].staleReason));
  const blocked = await signalStore.transition(SIGNAL, 'action_required', '尝试处置', '周宁', signal.revision);
  check('处置被阻断', !blocked.ok && blocked.code === 'pending_review', blocked);
  check('状态保持', current().status === 'investigating');
}

console.log('— 复核人确认 —');
{
  const signal = current();
  const pending = pendingReviewVersions(signal)[0];
  const sameAuthor = await signalStore.confirmReview(SIGNAL, pending.id, '周宁', '自行确认', signal.revision);
  check('作者不能自审', !sameAuthor.ok && sameAuthor.code === 'reviewer_must_differ', sameAuthor);
  const confirmed = await signalStore.confirmReview(SIGNAL, pending.id, '赵珂', '核对新证据后结论仍然成立', signal.revision);
  check('第二名复核人确认成功', confirmed.ok, confirmed);
  const after = current();
  check('结论状态为复核确认', after.versions[0].state === 'confirmed');
  check('引用快照对齐当前证据', after.versions[0].evidenceRefs.length === after.evidence.length);
  const allowed = await signalStore.transition(SIGNAL, 'observed', '复核完成，继续观察', '周宁', after.revision);
  check('确认后恢复处置', allowed.ok, allowed);
}

console.log('— 被引用证据修订使结论再次失效 —');
{
  const signal = current();
  const target = signal.evidence.find((item) => item.id === 'E-018-02');
  if (!target) throw new Error('缺少证据 E-018-02');
  const revised = await signalStore.addEvidence(
    SIGNAL,
    {
      type: target.type,
      title: target.title,
      source: target.source,
      sourceBatch: 'IMP-20261003',
      strength: 'strong',
      batch: target.batch,
      note: '补充装配记录后确认零点漂移与扭矩相关。'
    },
    '陈明',
    signal.revision
  );
  check('返回修订', revised.ok && revised.value.outcome === 'revised', revised);
  const after = current();
  const item = after.evidence.find((entry) => entry.id === 'E-018-02');
  check('证据修订号递增', item?.revision === 2, item?.revision);
  check('旧结论再次待复核且保留', after.versions.some((v) => v.state === 'pending_review' && v.staleReason?.includes('E-018-02')));
}

console.log('— 新结论版本取代待复核版本 —');
{
  const signal = current();
  const added = await signalStore.addVersion(
    SIGNAL,
    {
      author: '周宁',
      summary: '综合修订后证据，确认装配扭矩为根本原因。',
      disposition: 'corrective_action',
      rationale: '修订后的维修记录与现场复现一致。'
    },
    signal.revision
  );
  check('新版本形成', added.ok && added.value.version === 2, added);
  const after = current();
  check('旧版本全部转为已取代', after.versions.filter((v) => v.version < 2).every((v) => v.state === 'superseded'));
  check('无待复核阻塞', pendingReviewVersions(after).length === 0);
  check('新版本引用全部证据指纹', after.versions[0].evidenceRefs.length === after.evidence.length);
}

console.log('— 台账版本一致性 —');
{
  const meta = get(ledgerMeta);
  const signal = current();
  check('台账全局修订号递增', meta.revision > 1, meta.revision);
  check('信号修订号随变更递增', signal.revision > 1, signal.revision);
  check('无迁移待办', !meta.migrationPending && meta.migrationRemaining === 0);
  check('无持久化错误', !meta.persistError);
}

summary();
