import { browser } from '$app/environment';
import type {
  CaseVersion,
  Disposition,
  EvidenceItem,
  LedgerMeta,
  PersistedLedger,
  RiskLevel,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';
import {
  evidenceDedupeKey,
  evidenceFingerprint,
  evidenceRefsMatch,
  shortFingerprint,
  snapshotEvidenceRefs
} from '$lib/services/fingerprint';
import {
  loadLedgerFromStorage,
  persistLedger,
  resetLedger,
  retryPendingMigration,
  SCHEMA_VERSION,
  V2_STORAGE_KEY
} from '$lib/services/ledger';
import { get, writable } from 'svelte/store';

export interface MutationSuccess<T> {
  ok: true;
  value: T;
}

export interface MutationFailure {
  ok: false;
  code: 'conflict' | 'missing' | 'pending_review' | 'not_pending' | 'reviewer_must_differ';
  message: string;
  currentRevision?: number;
}

export type MutationOutcome<T = undefined> = MutationSuccess<T> | MutationFailure;

export type EvidenceOutcome = 'created' | 'associated' | 'revised';

export interface EvidenceInput {
  type: EvidenceItem['type'];
  title: string;
  source: string;
  sourceBatch: string;
  strength: EvidenceItem['strength'];
  batch: string;
  note: string;
}

export interface VersionInput {
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
}

class DomainError extends Error {
  constructor(
    public code: MutationFailure['code'],
    message: string
  ) {
    super(message);
  }
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

const strengthLabels: Record<EvidenceItem['strength'], string> = {
  strong: '强支持',
  moderate: '中等支持',
  weak: '弱支持',
  contrary: '相反证据'
};

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

/** 证据矩阵内容变化后，引用失配的结论失效转待复核（保留原版本，不删除）。 */
function invalidateStaleVersions(signal: SignalCase, changeDetail: string): string[] {
  const stale: string[] = [];
  for (const version of signal.versions) {
    if (version.state !== 'active' && version.state !== 'confirmed') continue;
    if (evidenceRefsMatch(version.evidenceRefs, signal.evidence)) continue;
    version.state = 'pending_review';
    version.staleReason = changeDetail;
    version.staleAt = now();
    stale.push(`V${version.version}`);
  }
  return stale;
}

export function pendingReviewVersions(signal: SignalCase): CaseVersion[] {
  return signal.versions.filter((version) => version.state === 'pending_review');
}

function nextSignalId(signals: SignalCase[]): string {
  const year = new Date().getFullYear();
  const max = signals.reduce((acc, signal) => {
    const match = signal.id.match(/^SIG-(\d{4})-(\d+)$/);
    return match && Number(match[1]) === year ? Math.max(acc, Number(match[2])) : acc;
  }, 0);
  return `SIG-${year}-${String(max + 1).padStart(3, '0')}`;
}

function nextEvidenceId(signal: SignalCase): string {
  const suffix = signal.id.replace(/^SIG-\d{4}-/, '');
  const max = signal.evidence.reduce((acc, item) => {
    const match = item.id.match(/-(\d+)$/);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `E-${suffix}-${String(max + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 台账状态：内存视图 + 元信息。所有变更先经 localStorage 读-校验-写，
// 再更新内存视图，保证两个标签页不会互相覆盖。
// ---------------------------------------------------------------------------

const initial = loadLedgerFromStorage();

let ledgerState: PersistedLedger = initial.ledger;
let lastPersistError: string | undefined;
let migrationState = {
  pending: initial.migrationPending,
  remaining: initial.migrationRemaining,
  error: initial.migrationError as string | undefined
};

const internal = writable<SignalCase[]>(ledgerState.signals);
const metaInternal = writable<LedgerMeta>();

function publish(ledger: PersistedLedger) {
  ledgerState = ledger;
  internal.set(ledger.signals);
  metaInternal.set({
    schemaVersion: ledger.schemaVersion,
    revision: ledger.revision,
    migrationPending: migrationState.pending,
    migrationRemaining: migrationState.remaining,
    migrationError: migrationState.error,
    persistError: lastPersistError
  });
}

publish(ledgerState);

/** 读取当前最新台账：优先取 localStorage（其他标签页可能已写入），修订号更高者为准。 */
function currentLedger(): PersistedLedger {
  if (!browser) return ledgerState;
  try {
    const raw = localStorage.getItem(V2_STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as PersistedLedger;
      if (
        stored?.schemaVersion === SCHEMA_VERSION &&
        Array.isArray(stored.signals) &&
        stored.revision >= ledgerState.revision
      ) {
        return stored;
      }
    }
  } catch {
    // 存储读取失败时退回内存视图
  }
  return ledgerState;
}

function commit(ledger: PersistedLedger) {
  try {
    persistLedger(ledger);
    lastPersistError = undefined;
  } catch (error) {
    // 写入失败：旧数据在存储中原样保留、继续可读，内存视图先行，界面提示重试。
    lastPersistError = error instanceof Error ? error.message : String(error);
  }
}

const LEDGER_LOCK = 'medical-safety-ledger';

/**
 * 跨标签页互斥执行读-校验-写：持锁期间其他标签页的变更排队等待，
 * 后到者读到先行者的结果后重新校验，不会整包覆盖。
 */
async function withLedgerLock<T>(fn: () => T): Promise<T> {
  if (browser && typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(LEDGER_LOCK, fn);
  }
  return fn();
}

/**
 * 乐观并发变更：基于 baseRevision 校验，一致才应用；
 * 不一致则载入最新内容并返回冲突，后到者不得覆盖先行结果。
 */
async function mutateSignal<T>(
  id: string,
  baseRevision: number,
  fn: (signal: SignalCase) => T
): Promise<MutationOutcome<T>> {
  return withLedgerLock(() => {
    const ledger = currentLedger();
    const index = ledger.signals.findIndex((signal) => signal.id === id);
    if (index < 0) {
      publish(ledger);
      return { ok: false as const, code: 'missing' as const, message: '信号不存在或已被移除，已为你载入最新台账。' };
    }
    const signal = ledger.signals[index];
    if (signal.revision !== baseRevision) {
      publish(ledger);
      return {
        ok: false as const,
        code: 'conflict' as const,
        message: `该信号刚被其他操作更新（当前修订 R${signal.revision}），已为你载入最新内容，请核对后重新提交。`,
        currentRevision: signal.revision
      };
    }

    const updated = structuredClone(signal);
    let value: T;
    try {
      value = fn(updated);
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false as const, code: error.code, message: error.message };
      }
      throw error;
    }

    updated.revision = signal.revision + 1;
    updated.updatedAt = now();
    const nextLedger: PersistedLedger = {
      ...ledger,
      signals: ledger.signals.map((item, itemIndex) => (itemIndex === index ? updated : item)),
      revision: ledger.revision + 1,
      updatedAt: now()
    };
    commit(nextLedger);
    publish(nextLedger);
    return { ok: true as const, value };
  });
}

if (browser) {
  window.addEventListener('storage', (event) => {
    if (event.key !== V2_STORAGE_KEY || !event.newValue) return;
    try {
      const ledger = JSON.parse(event.newValue) as PersistedLedger;
      if (ledger?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(ledger.signals)) return;
      if (ledger.revision === ledgerState.revision) return;
      publish(ledger);
    } catch {
      // 忽略无法解析的写入
    }
  });
}

export const ledgerMeta = {
  subscribe: metaInternal.subscribe
};

export const signalStore = {
  subscribe: internal.subscribe,

  /** 新增信号：写入时分配唯一信号号，避免两个标签页同时登记产生重号。 */
  async add(signal: SignalCase): Promise<MutationOutcome<SignalCase>> {
    return withLedgerLock(() => {
      const ledger = currentLedger();
      const created: SignalCase = {
        ...structuredClone(signal),
        id: nextSignalId(ledger.signals),
        revision: 1
      };
      const nextLedger: PersistedLedger = {
        ...ledger,
        signals: [created, ...ledger.signals],
        revision: ledger.revision + 1,
        updatedAt: now()
      };
      commit(nextLedger);
      publish(nextLedger);
      return { ok: true as const, value: created };
    });
  },

  transition(
    id: string,
    nextStatus: SignalStatus,
    reason: string,
    actor: string,
    baseRevision: number
  ): Promise<MutationOutcome> {
    return mutateSignal(id, baseRevision, (signal) => {
      const pending = pendingReviewVersions(signal);
      if (pending.length > 0) {
        throw new DomainError(
          'pending_review',
          `结论 ${pending.map((version) => `V${version.version}`).join('、')} 因证据变化待复核，复核人确认前不能继续处置。`
        );
      }
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
      return undefined;
    });
  },

  /**
   * 补入证据：登记来源批次与内容指纹。
   * 同一指纹只追加关联；同来源内容变化记为修订并使引用它的结论失效待复核。
   */
  addEvidence(
    id: string,
    input: EvidenceInput,
    actor: string,
    baseRevision: number
  ): Promise<MutationOutcome<{ outcome: EvidenceOutcome; evidenceId: string }>> {
    return mutateSignal(id, baseRevision, (signal) => {
      const fingerprint = evidenceFingerprint(input);
      const dedupeKey = evidenceDedupeKey(input);
      const existing = signal.evidence.find((item) => evidenceDedupeKey(item) === dedupeKey);
      const createdAt = now();

      if (existing && existing.fingerprint === fingerprint) {
        existing.references.push({ sourceBatch: input.sourceBatch, actor, createdAt });
        existing.updatedAt = createdAt;
        appendAudit(
          signal,
          actor,
          '证据关联追加',
          `《${existing.title}》内容指纹 ${shortFingerprint(fingerprint)} 一致，仅追加来源批次 ${input.sourceBatch} 的关联，不重复建档。`
        );
        return { outcome: 'associated' as const, evidenceId: existing.id };
      }

      if (existing) {
        const previousFingerprint = existing.fingerprint;
        existing.revision += 1;
        existing.note = input.note;
        existing.strength = input.strength;
        existing.fingerprint = fingerprint;
        existing.updatedAt = createdAt;
        existing.references.push({ sourceBatch: input.sourceBatch, actor, createdAt });
        appendAudit(
          signal,
          actor,
          '证据修订',
          `《${existing.title}》内容修订（指纹 ${shortFingerprint(previousFingerprint)} → ${shortFingerprint(fingerprint)}），来源批次 ${input.sourceBatch}。`
        );
        const stale = invalidateStaleVersions(
          signal,
          `证据 ${existing.id} 内容修订（指纹 ${shortFingerprint(previousFingerprint)}→${shortFingerprint(fingerprint)}）`
        );
        if (stale.length > 0) {
          appendAudit(
            signal,
            '系统',
            '结论失效',
            `${stale.join('、')} 引用的证据版本发生变化，结论失效转待复核（原版本保留），复核确认前不能继续处置。`
          );
        }
        return { outcome: 'revised' as const, evidenceId: existing.id };
      }

      const item: EvidenceItem = {
        id: nextEvidenceId(signal),
        type: input.type,
        title: input.title,
        source: input.source,
        sourceBatch: input.sourceBatch,
        fingerprint,
        revision: 1,
        strength: input.strength,
        batch: input.batch,
        note: input.note,
        createdAt,
        updatedAt: createdAt,
        references: [{ sourceBatch: input.sourceBatch, actor, createdAt }]
      };
      signal.evidence.unshift(item);
      if (!signal.affectedBatches.includes(input.batch)) {
        signal.affectedBatches.push(input.batch);
      }
      appendAudit(
        signal,
        actor,
        '新增证据',
        `《${item.title}》登记来源批次 ${input.sourceBatch}，内容指纹 ${shortFingerprint(fingerprint)}，证据强度：${strengthLabels[item.strength]}。`
      );
      const stale = invalidateStaleVersions(signal, `新增证据 ${item.id}《${item.title}》`);
      if (stale.length > 0) {
        appendAudit(
          signal,
          '系统',
          '结论失效',
          `${stale.join('、')} 形成后证据矩阵发生变化，结论失效转待复核（原版本保留），复核确认前不能继续处置。`
        );
      }
      return { outcome: 'created' as const, evidenceId: item.id };
    });
  },

  /** 形成结论版本：记录引用的证据版本快照，旧版本转已取代。 */
  addVersion(id: string, input: VersionInput, baseRevision: number): Promise<MutationOutcome<CaseVersion>> {
    return mutateSignal(id, baseRevision, (signal) => {
      const createdAt = now();
      const nextNumber = signal.versions.reduce((max, version) => Math.max(max, version.version), 0) + 1;
      for (const version of signal.versions) {
        if (version.state === 'active' || version.state === 'confirmed' || version.state === 'pending_review') {
          version.state = 'superseded';
        }
      }
      const evidenceRefs = snapshotEvidenceRefs(signal.evidence);
      const version: CaseVersion = {
        id: makeId('V'),
        version: nextNumber,
        author: input.author,
        summary: input.summary,
        disposition: input.disposition,
        rationale: input.rationale,
        createdAt,
        evidenceRefs,
        state: 'active'
      };
      signal.versions.unshift(version);
      appendAudit(
        signal,
        input.author,
        '形成版本',
        `版本 V${nextNumber}：${input.summary}（引用 ${evidenceRefs.length} 项证据的当前版本指纹）`
      );
      return version;
    });
  },

  /** 复核确认：复核人须与结论作者不同；确认后引用快照对齐当前证据版本。 */
  confirmReview(
    id: string,
    versionId: string,
    actor: string,
    note: string,
    baseRevision: number
  ): Promise<MutationOutcome<CaseVersion>> {
    return mutateSignal(id, baseRevision, (signal) => {
      const version = signal.versions.find((item) => item.id === versionId);
      if (!version) throw new DomainError('missing', '未找到待复核的结论版本。');
      if (version.state !== 'pending_review') {
        throw new DomainError('not_pending', `V${version.version} 当前不在待复核状态。`);
      }
      if (version.author.trim() === actor.trim()) {
        throw new DomainError('reviewer_must_differ', '复核人不能与结论作者相同，请由第二名评审专员确认。');
      }
      version.state = 'confirmed';
      version.confirmedBy = actor;
      version.confirmedAt = now();
      version.reviewNote = note;
      version.evidenceRefs = snapshotEvidenceRefs(signal.evidence);
      appendAudit(
        signal,
        actor,
        '复核确认',
        `V${version.version} 经复核确认仍然有效，信号恢复可处置：${note}`
      );
      return version;
    });
  },

  reopen(id: string, actor: string, reason: string, baseRevision: number): Promise<MutationOutcome> {
    return mutateSignal(id, baseRevision, (signal) => {
      signal.status = 'investigating';
      signal.reopenedCount += 1;
      appendAudit(signal, actor, '重新打开', reason);
      return undefined;
    });
  },

  /** 重试迁移：只补未迁移的旧信号，不重复导入。 */
  async retryMigration() {
    return withLedgerLock(() => {
      const result = retryPendingMigration();
      migrationState = {
        pending: result.migrationPending,
        remaining: result.migrationRemaining,
        error: result.migrationError
      };
      publish(result.ledger);
      return result;
    });
  },

  async reset() {
    return withLedgerLock(() => {
      migrationState = { pending: false, remaining: 0, error: undefined };
      lastPersistError = undefined;
      publish(resetLedger());
    });
  },

  getSnapshot() {
    return get(internal);
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
  return {
    id: 'SIG-PENDING',
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
    revision: 1,
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
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0
  };
}
