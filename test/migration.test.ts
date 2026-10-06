import { check, failNextWrite, installLocalStorage, rawGet, summary } from './harness';

installLocalStorage();

const V1_KEY = 'medical-safety-signals-v1';
const V2_KEY = 'medical-safety-signals-v2';

// 构造两条旧版（v1）信号：无修订号、无指纹、结论无证据引用。
const legacySignals = [
  {
    id: 'SIG-2026-018',
    title: '输注泵阻塞报警集中发生于同一批管路',
    product: '智能输液泵 IP-800',
    batch: 'IP8-260401',
    sourceType: 'complaint',
    status: 'investigating',
    riskLevel: 'high',
    severity: 4,
    reportCount: 17,
    exposedUnits: 2048,
    occurrenceRate: 0.83,
    occurredAt: '2026-09-08',
    openedAt: '2026-09-09T02:10:00.000Z',
    updatedAt: '2026-09-28T08:30:00.000Z',
    owner: '周宁',
    description: '旧台账记录。',
    affectedBatches: ['IP8-260401'],
    evidence: [
      {
        id: 'E-018-01',
        type: 'complaint',
        title: '华东区域 11 起同类投诉',
        source: '客服工单系统',
        strength: 'strong',
        batch: 'IP8-260401',
        note: '报警发生时间集中在装机后第 7 至 14 天。',
        createdAt: '2026-09-09T02:30:00.000Z'
      }
    ],
    tasks: [],
    versions: [
      {
        id: 'V-018-01',
        version: 1,
        author: '周宁',
        summary: '旧结论。',
        disposition: 'continue_observation',
        rationale: '旧依据。',
        createdAt: '2026-09-24T10:00:00.000Z'
      }
    ],
    audit: [],
    reopenedCount: 0
  },
  {
    id: 'SIG-2026-015',
    title: '监护仪电池续航低于标称值',
    product: '多参数监护仪 M12',
    batch: 'M12-251118',
    sourceType: 'repair',
    status: 'observed',
    riskLevel: 'medium',
    severity: 3,
    reportCount: 9,
    exposedUnits: 876,
    occurrenceRate: 1.03,
    occurredAt: '2026-08-22',
    openedAt: '2026-08-23T05:00:00.000Z',
    updatedAt: '2026-09-25T04:30:00.000Z',
    owner: '林澈',
    description: '旧台账记录。',
    affectedBatches: ['M12-251118'],
    evidence: [],
    tasks: [],
    versions: [],
    audit: [],
    reopenedCount: 0
  }
];

localStorage.setItem(V1_KEY, JSON.stringify(legacySignals));
const v1Snapshot = rawGet(V1_KEY);

console.log('— 迁移写入失败：旧数据继续可读 —');
failNextWrite(1); // 首次迁移写入失败
const { signalStore, ledgerMeta } = await import('../src/lib/stores/signal-store');
const { get } = await import('svelte/store');

{
  const meta = get(ledgerMeta);
  check('迁移标记为待完成', meta.migrationPending && meta.migrationRemaining === 2, meta);
  check('v2 未写入', rawGet(V2_KEY) === null);
  check('v1 旧数据原样保留', rawGet(V1_KEY) === v1Snapshot);
  const signals = signalStore.getSnapshot();
  check('内存视图仍提供全部信号', signals.length === 2, signals.length);
  check('旧信号已升级出指纹', signals.every((s) => s.evidence.every((e) => e.fingerprint?.length === 16)));
}

console.log('— 重试只补未迁移信号 —');
{
  const retry = await signalStore.retryMigration();
  check('重试后迁移完成', !retry.migrationPending && retry.migratedCount === 2, retry);
  const meta = get(ledgerMeta);
  check('元信息清除待办', !meta.migrationPending && meta.migrationRemaining === 0, meta);
  const stored = JSON.parse(rawGet(V2_KEY) ?? '{}');
  check('v2 已写入 2 条信号', stored.signals?.length === 2, stored.signals?.length);
  check('迁移清单记录 2 条', stored.migratedFromV1?.length === 2, stored.migratedFromV1);
  check('证据补登记来源批次', stored.signals[0].evidence[0]?.sourceBatch === 'LEGACY-V1');
  check('结论补登记证据引用', stored.signals[0].versions[0]?.evidenceRefs?.length === 1);
  check('审计含迁移记录', stored.signals.every((s: { audit: Array<{ action: string }> }) => s.audit.some((a) => a.action === '台账迁移')));
}

console.log('— 重复重试不重复导入 —');
{
  const again = await signalStore.retryMigration();
  check('无新增迁移', again.migratedCount === 0, again);
  const stored = JSON.parse(rawGet(V2_KEY) ?? '{}');
  check('信号数量不变', stored.signals?.length === 2, stored.signals?.length);
  check('v1 旧数据仍可读取', rawGet(V1_KEY) === v1Snapshot);
}

console.log('— 部分迁移恢复：只补缺失信号 —');
{
  // 模拟：v2 已有 018，v1 又出现一条未迁移的 021
  const stored = JSON.parse(rawGet(V2_KEY) ?? '{}');
  const extra = { ...legacySignals[1], id: 'SIG-2026-021', title: '新增的未迁移旧信号' };
  localStorage.setItem(V1_KEY, JSON.stringify([...legacySignals, extra]));
  const retry = await signalStore.retryMigration();
  check('只补 1 条未迁移信号', retry.migratedCount === 1, retry);
  const after = JSON.parse(rawGet(V2_KEY) ?? '{}');
  check('台账共 3 条且无重复', after.signals?.length === 3 && new Set(after.signals.map((s: { id: string }) => s.id)).size === 3);
}

summary();
