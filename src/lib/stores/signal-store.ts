import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceInput,
  EvidenceItem,
  EvidenceRef,
  LegacySignalCase,
  MutationResult,
  ReviewBlock,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import { contentFingerprint } from '$lib/services/fingerprint';
import { derived, get, writable } from 'svelte/store';

/** 旧台账整包 key：迁移完成前保持不动，迁移期间旧数据继续可读 */
const LEGACY_STORAGE_KEY = 'medical-safety-signals-v1';
/** 可恢复版本台账：{ revision, signals }，所有写入只动 v2，绝不覆盖 v1 */
const LEDGER_STORAGE_KEY = 'medical-safety-signals-v2';
const MIGRATION_STATE_KEY = 'medical-safety-signals-migration-v1';
/** 迁移演练：剩余的失败注入次数（由总览页“模拟迁移失败”设置） */
const MIGRATION_FAILPOINT_KEY = 'medical-safety-signals-migration-failpoint';

export type MigrationStatus = 'idle' | 'running' | 'failed' | 'completed';

export interface MigrationState {
  status: MigrationStatus;
  total: number;
  migrated: number;
  /** 已迁移的信号 ID，重试时据此跳过，保证不重复导入 */
  migratedIds: string[];
  failedAt?: string;
  error?: string;
}

interface Ledger {
  /** 台账全局版本号，每次成功写入加一，总览/详情/批次/审计显示同一版本 */
  revision: number;
  signals: SignalCase[];
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

// ---------------------------------------------------------------------------
// 旧数据规范化：把 v1/种子数据升级为可恢复版本结构，补建指纹与引用快照
// ---------------------------------------------------------------------------

function normalizeEvidence(raw: LegacySignalCase['evidence'][number]): EvidenceItem {
  const fingerprint =
    raw.fingerprint ??
    contentFingerprint({ type: raw.type, title: raw.title, source: raw.source, note: raw.note });
  return {
    id: raw.id,
    type: raw.type,
    title: raw.title,
    source: raw.source,
    sourceBatch: raw.sourceBatch ?? raw.source,
    strength: raw.strength,
    batch: raw.batch,
    note: raw.note,
    fingerprint,
    linkedBatches: raw.linkedBatches ?? [raw.batch],
    revisions: raw.revisions ?? [],
    createdAt: raw.createdAt
  };
}

function buildEvidenceRefs(evidence: EvidenceItem[]): EvidenceRef[] {
  return evidence.map((item) => ({
    evidenceId: item.id,
    fingerprint: item.fingerprint,
    title: item.title,
    strength: item.strength
  }));
}

function normalizeVersion(
  raw: LegacySignalCase['versions'][number],
  evidence: EvidenceItem[]
): CaseVersion {
  return {
    id: raw.id,
    version: raw.version,
    author: raw.author,
    summary: raw.summary,
    disposition: raw.disposition,
    rationale: raw.rationale,
    evidenceRefs: raw.evidenceRefs ?? buildEvidenceRefs(evidence),
    state: raw.state ?? 'active',
    staleReason: raw.staleReason,
    supersededBy: raw.supersededBy,
    createdAt: raw.createdAt
  };
}

function normalizeSignal(raw: LegacySignalCase, fromLegacy: boolean): SignalCase {
  const evidence = raw.evidence.map(normalizeEvidence);
  const versions = raw.versions.map((version) => normalizeVersion(version, evidence));
  return {
    ...(raw as SignalCase),
    evidence,
    versions,
    audit: raw.audit.map((entry) => ({ ...entry, dataVersion: entry.dataVersion ?? 0 })),
    revision: raw.revision ?? 1,
    reviewBlock: raw.reviewBlock,
    migratedFromLegacy: raw.migratedFromLegacy ?? fromLegacy
  };
}

function seedLedger(): Ledger {
  return {
    revision: 1,
    signals: seedSignals.map((signal) => normalizeSignal(signal as LegacySignalCase, false))
  };
}

// ---------------------------------------------------------------------------
// 持久化（v2）。写入失败不触碰内存与 v1 旧数据，旧台账因此始终可读
// ---------------------------------------------------------------------------

function readJSON<T>(key: string): T | undefined {
  if (!browser) return undefined;
  const raw = localStorage.getItem(key);
  if (!raw) return undefined;
  return JSON.parse(raw) as T;
}

function persistLedger(ledger: Ledger, failpoint: boolean): void {
  if (!browser) return;
  // failpoint 仅用于迁移演练。语义：先放行 N 次写入，第 N+1 次失败一次（随后解除），
  // 因此 N=1 时第 1 个信号落盘、第 2 个信号写入失败，可验证部分迁移与重试。
  if (failpoint) {
    const remaining = Number(localStorage.getItem(MIGRATION_FAILPOINT_KEY) ?? '-1');
    if (remaining === 0) {
      localStorage.setItem(MIGRATION_FAILPOINT_KEY, '-1');
      throw new Error('模拟写入失败：迁移批次写入被拒绝');
    }
    if (remaining > 0) {
      localStorage.setItem(MIGRATION_FAILPOINT_KEY, String(remaining - 1));
    }
  }
  localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger));
}

function persistMigration(state: MigrationState): void {
  if (!browser) return;
  localStorage.setItem(MIGRATION_STATE_KEY, JSON.stringify(state));
}

function readLegacySignals(): LegacySignalCase[] | undefined {
  if (!browser) return undefined;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LegacySignalCase[]) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 内存状态
// ---------------------------------------------------------------------------

const ledgerStore = writable<Ledger>(seedLedger());
const legacyStore = writable<SignalCase[]>([]);
const migrationStore = writable<MigrationState>({
  status: 'idle',
  total: 0,
  migrated: 0,
  migratedIds: []
});

/** 合并视图：v2 已迁移信号 + 尚未迁移的 v1 信号（旧数据只读展示） */
const viewStore = derived([ledgerStore, legacyStore], ([$ledger, $legacy]) =>
  [...$ledger.signals, ...$legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
);

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string): AuditEntry {
  const entry: AuditEntry = {
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now(),
    dataVersion: 0
  };
  signal.audit.unshift(entry);
  signal.updatedAt = entry.createdAt;
  return entry;
}

// 守卫类错误：mutator 用抛异常表达业务拒绝，commit 统一转换错误码
class ReviewLockError extends Error {}
class NotFoundError extends Error {}
class NoEvidenceError extends Error {}

/**
 * 乐观锁提交。写入前重新读取磁盘上的 v2 台账：
 * - 磁盘已被其他标签页更新（expectedRevision 不符）→ 采用先行结果并返回 conflict，不覆盖；
 * - 信号尚在旧台账 → unmigrated，拒绝处置。
 */
function commit(
  signalId: string,
  expectedRevision: number,
  mutate: (signal: SignalCase) => { deduped?: boolean } | void
): MutationResult {
  let fresh: Ledger;
  try {
    fresh = readJSON<Ledger>(LEDGER_STORAGE_KEY) ?? get(ledgerStore);
  } catch {
    fresh = get(ledgerStore);
  }

  const target = fresh.signals.find((signal) => signal.id === signalId);
  if (!target) {
    const legacyExists = get(legacyStore).some((signal) => signal.id === signalId);
    return legacyExists
      ? {
          ok: false,
          errorCode: 'unmigrated',
          message: '该信号仍在旧台账中，请等待迁移完成或在总览页重试迁移后再操作。'
        }
      : { ok: false, errorCode: 'not_found', message: '信号不存在或已被移除。' };
  }
  if (target.revision !== expectedRevision) {
    ledgerStore.set(fresh);
    return {
      ok: false,
      errorCode: 'conflict',
      message: `该信号已被其他人更新（当前修订号 R${target.revision}，你提交基于 R${expectedRevision}），页面已重新校验，请核对后再提交。`,
      currentRevision: target.revision
    };
  }

  let outcome: { deduped?: boolean } | void;
  try {
    outcome = mutate(target);
  } catch (error) {
    if (error instanceof ReviewLockError) {
      return {
        ok: false,
        errorCode: 'review_locked',
        message: '存在待复核的失效结论，须由复核人确认后才能继续处置。'
      };
    }
    if (error instanceof NotFoundError) {
      return { ok: false, errorCode: 'not_found', message: '目标记录不存在。' };
    }
    if (error instanceof NoEvidenceError) {
      return {
        ok: false,
        errorCode: 'no_evidence',
        message: '证据矩阵为空，不能形成结论；请先补入至少一项证据。'
      };
    }
    throw error;
  }

  target.revision += 1;
  fresh.revision += 1;
  // 本次写入新追加的审计记录挂到新台账版本，四页版本号即可对齐
  for (const signal of fresh.signals) {
    for (const entry of signal.audit) {
      if (entry.dataVersion === 0) entry.dataVersion = fresh.revision;
    }
  }

  try {
    persistLedger(fresh, false);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'unknown',
      message: `台账写入失败，本次提交未保存：${(error as Error).message}`
    };
  }
  ledgerStore.set(fresh);

  const result: MutationResult = { ok: true };
  if (outcome?.deduped) {
    result.deduped = true;
    result.message = '命中相同内容指纹：已仅追加来源批次关联，未重复建立证据。';
  }
  return result;
}

// ---------------------------------------------------------------------------
// 旧台账迁移（可恢复、可重试、不重复导入）
// ---------------------------------------------------------------------------

export function runMigration(): void {
  if (!browser) return;
  const legacy = readLegacySignals();
  const previous = get(migrationStore);

  if (!legacy || legacy.length === 0) {
    const completed: MigrationState = {
      status: 'completed',
      total: previous.total || 0,
      migrated: previous.migrated || 0,
      migratedIds: previous.migratedIds
    };
    migrationStore.set(completed);
    persistMigration(completed);
    return;
  }

  const migratedIds = new Set(previous.migratedIds);
  // 每次都从磁盘重读 v2：重试时基于已落盘部分继续，只补未迁移信号
  const base = readJSON<Ledger>(LEDGER_STORAGE_KEY) ?? { revision: 1, signals: [] };
  const ledger: Ledger = structuredClone(base);

  migrationStore.set({
    status: 'running',
    total: legacy.length,
    migrated: migratedIds.size,
    migratedIds: [...migratedIds]
  });

  for (const rawSignal of legacy) {
    if (migratedIds.has(rawSignal.id)) continue;

    const signal = normalizeSignal(rawSignal, true);
    appendAudit(
      signal,
      '迁移服务',
      '台账迁移',
      `由旧台账升级为可恢复版本结构，补登证据来源批次与内容指纹（${signal.evidence.length} 项证据、${signal.versions.length} 个结论版本）。`
    );
    ledger.signals = [signal, ...ledger.signals];
    ledger.revision += 1;
    for (const entry of signal.audit) {
      if (entry.dataVersion === 0) entry.dataVersion = ledger.revision;
    }

    try {
      // 一次只落盘一个信号：失败时前面已迁移信号已经可读
      persistLedger(ledger, true);
    } catch (error) {
      const failed: MigrationState = {
        status: 'failed',
        total: legacy.length,
        migrated: migratedIds.size,
        migratedIds: [...migratedIds],
        failedAt: now(),
        error: (error as Error).message
      };
      persistMigration(failed);
      migrationStore.set(failed);
      // 内存以“最后成功落盘”的 v2 为准：当前失败信号未落盘，绝不半写入
      ledgerStore.set(readJSON<Ledger>(LEDGER_STORAGE_KEY) ?? { revision: base.revision, signals: [] });
      // v1 旧数据原封不动，未迁移部分继续在合并视图中可读
      legacyStore.set(
        legacy
          .filter((item) => !migratedIds.has(item.id))
          .map((item) => normalizeSignal(item, true))
      );
      return;
    }

    migratedIds.add(rawSignal.id);
    persistMigration({
      status: 'running',
      total: legacy.length,
      migrated: migratedIds.size,
      migratedIds: [...migratedIds]
    });
  }

  // 全部信号落盘成功后才删除旧 key（任一步失败都会保留旧数据，可再次重试）
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  const completed: MigrationState = {
    status: 'completed',
    total: legacy.length,
    migrated: legacy.length,
    migratedIds: legacy.map((signal) => signal.id)
  };
  persistMigration(completed);
  migrationStore.set(completed);
  legacyStore.set([]);
  ledgerStore.set(ledger);
}

/** 总览页演练：把当前台账快照写成“旧台账”，并安排迁移到第 2 个信号时写入失败 */
export function primeMigrationFailureDemo(): void {
  if (!browser) return;
  const ledger = readJSON<Ledger>(LEDGER_STORAGE_KEY);
  const signals = (ledger?.signals ?? get(ledgerStore).signals).map(
    (signal) => structuredClone(signal) as LegacySignalCase
  );
  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(signals));
  localStorage.removeItem(LEDGER_STORAGE_KEY);
  localStorage.removeItem(MIGRATION_STATE_KEY);
  localStorage.setItem(MIGRATION_FAILPOINT_KEY, '1');
  location.reload();
}

function bootstrap(): void {
  if (!browser) return;
  const legacy = readLegacySignals();
  const disk = readJSON<Ledger>(LEDGER_STORAGE_KEY);

  if (disk) ledgerStore.set(disk);

  if (legacy && legacy.length > 0) {
    const previous = readJSON<MigrationState>(MIGRATION_STATE_KEY);
    if (previous && previous.status === 'failed') {
      // 上次迁移失败：保留状态，不自动重试，由用户在总览页点击重试（只补未迁移信号）
      migrationStore.set(previous);
      const migratedIds = new Set(previous.migratedIds);
      legacyStore.set(
        legacy
          .filter((item) => !migratedIds.has(item.id))
          .map((item) => normalizeSignal(item, true))
      );
    } else {
      runMigration();
    }
  } else if (disk) {
    const state = readJSON<MigrationState>(MIGRATION_STATE_KEY);
    if (state) migrationStore.set(state);
    else migrationStore.set({ status: 'completed', total: 0, migrated: 0, migratedIds: [] });
  } else {
    // 首次使用（无 v1、无 v2）：种子直接落 v2，不产生旧 key
    persistLedger(get(ledgerStore), false);
    migrationStore.set({ status: 'completed', total: 0, migrated: 0, migratedIds: [] });
  }
}

bootstrap();

// 跨标签页：其他标签页先行提交后，本标签页直接采用磁盘结果，不覆盖
if (browser) {
  window.addEventListener('storage', (event) => {
    if (event.key === LEDGER_STORAGE_KEY && event.newValue) {
      try {
        ledgerStore.set(JSON.parse(event.newValue) as Ledger);
      } catch {
        /* 保留当前内存状态 */
      }
    }
    if (event.key === LEGACY_STORAGE_KEY || event.key === MIGRATION_STATE_KEY) {
      const state = readJSON<MigrationState>(MIGRATION_STATE_KEY);
      if (state) migrationStore.set(state);
      const legacy = readLegacySignals();
      if (legacy) {
        const migratedIds = new Set(state?.migratedIds ?? []);
        legacyStore.set(
          legacy
            .filter((item) => !migratedIds.has(item.id))
            .map((item) => normalizeSignal(item, true))
        );
      } else {
        legacyStore.set([]);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 业务变更
// ---------------------------------------------------------------------------

function activeVersion(signal: SignalCase): CaseVersion | undefined {
  return signal.versions.find((version) => version.state === 'active');
}

/** 证据内容指纹变化：引用它的有效结论失效转待复核并加锁，旧版本保留不删 */
function invalidateCitations(signal: SignalCase, evidence: EvidenceItem, actor: string): void {
  const changedIds: string[] = [];
  for (const version of signal.versions) {
    if (version.state !== 'active') continue;
    const staleRefs = version.evidenceRefs.filter(
      (ref) => ref.evidenceId === evidence.id && ref.fingerprint !== evidence.fingerprint
    );
    if (staleRefs.length === 0) continue;

    version.state = 'stale_pending_review';
    version.staleReason = `引用证据「${evidence.title}」内容指纹由 ${staleRefs
      .map((ref) => ref.fingerprint.slice(0, 16))
      .join('、')} 变为 ${evidence.fingerprint.slice(0, 16)}，结论转待复核但保留。`;
    changedIds.push(evidence.id);
  }

  if (changedIds.length > 0 && !signal.reviewBlock) {
    signal.reviewBlock = {
      since: now(),
      reason: `被引用证据「${evidence.title}」已修订，引用它的结论失效，须复核人确认后方可继续处置。`,
      changedEvidenceIds: changedIds,
      previousStatus: signal.status
    } satisfies ReviewBlock;
    signal.status = 'review';
    appendAudit(
      signal,
      actor,
      '结论失效待复核',
      `证据「${evidence.title}」内容指纹变化，旧结论保留并转待复核；复核确认前禁止继续处置。`
    );
  }
}

export const ledgerRevisionStore = derived(ledgerStore, ($ledger) => $ledger.revision);
export const migrationStateStore = migrationStore;

export const signalStore = {
  subscribe: viewStore.subscribe,

  getSnapshot(): SignalCase[] {
    return get(viewStore);
  },

  getLedgerRevision(): number {
    return get(ledgerStore).revision;
  },

  add(signal: SignalCase): MutationResult {
    let ledger: Ledger;
    try {
      ledger = readJSON<Ledger>(LEDGER_STORAGE_KEY) ?? get(ledgerStore);
    } catch {
      ledger = get(ledgerStore);
    }
    ledger.signals = [signal, ...ledger.signals];
    ledger.revision += 1;
    for (const entry of signal.audit) {
      if (entry.dataVersion === 0) entry.dataVersion = ledger.revision;
    }
    try {
      persistLedger(ledger, false);
    } catch (error) {
      return {
        ok: false,
        errorCode: 'unknown',
        message: `台账写入失败，新信号未保存：${(error as Error).message}`
      };
    }
    ledgerStore.set(ledger);
    return { ok: true };
  },

  transition(
    id: string,
    expectedRevision: number,
    nextStatus: SignalStatus,
    reason: string,
    actor: string
  ): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      if (signal.reviewBlock && nextStatus !== 'review') throw new ReviewLockError();
      const previous = signal.status;
      signal.status = nextStatus;
      if (nextStatus === 'action_required' && signal.riskLevel === 'low') {
        signal.riskLevel = 'medium';
      }
      appendAudit(
        signal,
        actor,
        '状态流转',
        `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
      );
    });
  },

  addEvidence(id: string, expectedRevision: number, input: EvidenceInput, actor: string): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      const fingerprint = contentFingerprint(input);
      const existing = signal.evidence.find((item) => item.fingerprint === fingerprint);

      if (existing) {
        // 同一指纹：只追加来源批次关联，不重复建证据、不覆盖内容
        if (!existing.linkedBatches.includes(input.batch)) existing.linkedBatches.push(input.batch);
        if (!signal.affectedBatches.includes(input.batch)) signal.affectedBatches.push(input.batch);
        appendAudit(
          signal,
          actor,
          '证据关联追加',
          `来源批次 ${input.sourceBatch}（批号 ${input.batch}）命中证据「${existing.title}」同指纹 ${fingerprint.slice(0, 16)}，仅追加关联，未重复入库。`
        );
        return { deduped: true };
      }

      const evidence: EvidenceItem = {
        id: makeId('E'),
        type: input.type,
        title: input.title,
        source: input.source,
        sourceBatch: input.sourceBatch,
        strength: input.strength,
        batch: input.batch,
        note: input.note,
        fingerprint,
        linkedBatches: [input.batch],
        revisions: [],
        createdAt: now()
      };
      signal.evidence.unshift(evidence);
      if (!signal.affectedBatches.includes(input.batch)) signal.affectedBatches.push(input.batch);
      appendAudit(
        signal,
        actor,
        '新增证据',
        `${evidence.title}（来源批次 ${input.sourceBatch}，指纹 ${fingerprint.slice(0, 16)}），证据强度：${evidence.strength}`
      );
    });
  },

  reviseEvidence(
    id: string,
    expectedRevision: number,
    evidenceId: string,
    next: Omit<EvidenceInput, 'type' | 'title'>,
    actor: string
  ): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      const evidence = signal.evidence.find((item) => item.id === evidenceId);
      if (!evidence) throw new NotFoundError();

      const previousFingerprint = evidence.fingerprint;
      evidence.revisions.push({
        revision: evidence.revisions.length + 1,
        actor,
        source: evidence.source,
        sourceBatch: evidence.sourceBatch,
        strength: evidence.strength,
        batch: evidence.batch,
        note: evidence.note,
        fingerprint: previousFingerprint,
        changedAt: now()
      });

      evidence.source = next.source;
      evidence.sourceBatch = next.sourceBatch;
      evidence.strength = next.strength;
      evidence.batch = next.batch;
      evidence.note = next.note;
      if (!evidence.linkedBatches.includes(next.batch)) evidence.linkedBatches.push(next.batch);
      evidence.fingerprint = contentFingerprint({
        type: evidence.type,
        title: evidence.title,
        source: next.source,
        note: next.note
      });

      appendAudit(
        signal,
        actor,
        '证据修订',
        `证据「${evidence.title}」修订为第 ${evidence.revisions.length + 1} 版；指纹 ${previousFingerprint.slice(0, 16)} -> ${evidence.fingerprint.slice(0, 16)}，旧版本保留。`
      );

      invalidateCitations(signal, evidence, actor);
    });
  },

  addVersion(
    id: string,
    expectedRevision: number,
    version: Omit<CaseVersion, 'id' | 'version' | 'createdAt' | 'evidenceRefs' | 'state'>
  ): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      if (signal.reviewBlock) throw new ReviewLockError();
      if (signal.evidence.length === 0) throw new NoEvidenceError();

      const current = activeVersion(signal);
      const next: CaseVersion = {
        ...version,
        id: makeId('V'),
        version: signal.versions.reduce((max, item) => Math.max(max, item.version), 0) + 1,
        evidenceRefs: buildEvidenceRefs(signal.evidence),
        state: 'active',
        createdAt: now()
      };
      if (current) {
        current.state = 'superseded';
        current.supersededBy = next.id;
      }
      signal.versions.unshift(next);
      appendAudit(
        signal,
        version.author,
        '形成版本',
        `版本 V${next.version}：${version.summary}；固化引用 ${next.evidenceRefs.length} 项证据指纹。`
      );
    });
  },

  /** 复核人在待复核锁上确认：保留失效版本，登记新的有效结论，解锁并恢复处置 */
  confirmReview(
    id: string,
    expectedRevision: number,
    input: {
      reviewer: string;
      disposition: CaseVersion['disposition'];
      summary: string;
      rationale: string;
    }
  ): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      if (!signal.reviewBlock) throw new NotFoundError();

      const current = activeVersion(signal);
      const next: CaseVersion = {
        id: makeId('V'),
        version: signal.versions.reduce((max, item) => Math.max(max, item.version), 0) + 1,
        author: input.reviewer,
        summary: input.summary,
        disposition: input.disposition,
        rationale: input.rationale,
        evidenceRefs: buildEvidenceRefs(signal.evidence),
        state: 'active',
        createdAt: now()
      };
      if (current) {
        current.state = 'superseded';
        current.supersededBy = next.id;
      }
      signal.versions.unshift(next);

      const restored = signal.reviewBlock.previousStatus;
      signal.reviewBlock.confirmedAt = now();
      signal.reviewBlock.reviewer = input.reviewer;
      appendAudit(
        signal,
        input.reviewer,
        '复核确认',
        `复核人确认证据变化后的结论 V${next.version}（${input.summary}），解除待复核锁，状态恢复为${statusLabel(restored)}；失效旧版本保留可追溯。`
      );
      signal.status = restored;
      signal.reviewBlock = undefined;
    });
  },

  reopen(id: string, expectedRevision: number, actor: string, reason: string): MutationResult {
    return commit(id, expectedRevision, (signal) => {
      signal.status = 'investigating';
      signal.reopenedCount += 1;
      appendAudit(signal, actor, '重新打开', reason);
    });
  },

  retryMigration() {
    runMigration();
  },

  reset() {
    if (browser) {
      localStorage.removeItem(LEDGER_STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(MIGRATION_STATE_KEY);
      localStorage.removeItem(MIGRATION_FAILPOINT_KEY);
    }
    const ledger = seedLedger();
    persistLedger(ledger, false);
    legacyStore.set([]);
    migrationStore.set({ status: 'completed', total: 0, migrated: 0, migratedIds: [] });
    ledgerStore.set(ledger);
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  const signal: SignalCase = {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [],
    reopenedCount: 0,
    revision: 1
  };
  signal.audit.push({
    id: makeId('AUD'),
    actor: '安全台账',
    action: '建立信号',
    detail: '由人工登记表单创建初始信号。',
    createdAt: nowIso,
    dataVersion: 0
  });
  return signal;
}
