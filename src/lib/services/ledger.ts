import { browser } from '$app/environment';
import type { EvidenceItem, PersistedLedger, SignalCase } from '$lib/models/signal';
import { evidenceFingerprint, snapshotEvidenceRefs } from '$lib/services/fingerprint';
import { seedSignals } from '$lib/services/seed';

export const SCHEMA_VERSION = 2;
export const V1_STORAGE_KEY = 'medical-safety-signals-v1';
export const V2_STORAGE_KEY = 'medical-safety-signals-v2';

export interface LedgerLoadResult {
  ledger: PersistedLedger;
  /** 本次新迁移的信号数。 */
  migratedCount: number;
  /** 旧台账中尚未完成迁移、等待重试的信号数。 */
  migrationRemaining: number;
  migrationPending: boolean;
  migrationError?: string;
}

function now() {
  return new Date().toISOString();
}

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

export function buildSeedLedger(): PersistedLedger {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    signals: cloneSeed(),
    migratedFromV1: [],
    updatedAt: now()
  };
}

function readV1Signals(): SignalCase[] | null {
  try {
    const raw = localStorage.getItem(V1_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SignalCase[]) : null;
  } catch {
    return null;
  }
}

function readV2Ledger(): PersistedLedger | null {
  try {
    const raw = localStorage.getItem(V2_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedLedger;
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.signals)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 写入台账；失败时抛错，调用方保证旧数据保持可读。 */
export function persistLedger(ledger: PersistedLedger): void {
  localStorage.setItem(V2_STORAGE_KEY, JSON.stringify(ledger));
}

/**
 * 把旧版（v1）信号升级为带版本流程的 v2 结构：
 * 证据补登记来源批次与内容指纹，结论补登记引用的证据版本快照。
 */
function migrateLegacySignal(legacy: SignalCase): SignalCase {
  const migratedAt = now();
  const evidence: EvidenceItem[] = (legacy.evidence ?? []).map((item) => ({
    ...item,
    sourceBatch: item.sourceBatch ?? 'LEGACY-V1',
    fingerprint: item.fingerprint ?? evidenceFingerprint(item),
    revision: item.revision ?? 1,
    updatedAt: item.updatedAt ?? item.createdAt,
    references:
      item.references && item.references.length > 0
        ? item.references
        : [{ sourceBatch: 'LEGACY-V1', actor: '系统迁移', createdAt: item.createdAt }]
  }));

  return {
    ...legacy,
    revision: legacy.revision ?? 1,
    evidence,
    versions: (legacy.versions ?? []).map((version) => ({
      ...version,
      state: version.state ?? 'active',
      evidenceRefs: version.evidenceRefs ?? snapshotEvidenceRefs(evidence)
    })),
    audit: [
      {
        id: `AUD-MIG-${legacy.id}`,
        actor: '系统迁移',
        action: '台账迁移',
        detail: '由 v1 台账迁移至 v2：补登记证据来源批次、内容指纹与结论引用的证据版本。',
        createdAt: migratedAt
      },
      ...(legacy.audit ?? [])
    ]
  };
}

function okResult(ledger: PersistedLedger, migratedCount = 0): LedgerLoadResult {
  return { ledger, migratedCount, migrationRemaining: 0, migrationPending: false };
}

/**
 * 幂等合并迁移：只处理既不在 migratedFromV1、也不在现有台账中的旧信号。
 * 写入失败时返回合并后的内存视图，旧数据（v1 与旧 v2）原样保留、继续可读，
 * 重试时按存储中的真实状态重新计算待迁移集合，不会重复导入。
 */
function mergePendingMigration(v2: PersistedLedger | null, v1: SignalCase[]): LedgerLoadResult {
  const migratedIds = new Set(v2?.migratedFromV1 ?? []);
  const existingIds = new Set((v2?.signals ?? []).map((signal) => signal.id));
  const pending = v1.filter((signal) => !migratedIds.has(signal.id) && !existingIds.has(signal.id));

  if (pending.length === 0) {
    return okResult(v2 ?? buildSeedLedger());
  }

  const merged: PersistedLedger = {
    schemaVersion: SCHEMA_VERSION,
    revision: (v2?.revision ?? 0) + 1,
    signals: [...(v2?.signals ?? []), ...pending.map(migrateLegacySignal)],
    migratedFromV1: [...(v2?.migratedFromV1 ?? []), ...pending.map((signal) => signal.id)],
    updatedAt: now()
  };

  try {
    persistLedger(merged);
    return okResult(merged, pending.length);
  } catch (error) {
    return {
      ledger: merged,
      migratedCount: 0,
      migrationRemaining: pending.length,
      migrationPending: true,
      migrationError: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 启动加载：读 v2，存在未迁移的 v1 信号时执行幂等合并。 */
export function loadLedgerFromStorage(): LedgerLoadResult {
  if (!browser) return okResult(buildSeedLedger());

  const v2 = readV2Ledger();
  const v1 = readV1Signals();

  if (!v1) {
    if (v2) return okResult(v2);
    const seeded = buildSeedLedger();
    try {
      persistLedger(seeded);
    } catch {
      // 首次播种写失败不阻塞使用，后续变更会再次尝试持久化。
    }
    return okResult(seeded);
  }

  return mergePendingMigration(v2, v1);
}

/** 重试迁移：以存储中的真实状态为准，只补未迁移信号。 */
export function retryPendingMigration(): LedgerLoadResult {
  if (!browser) return okResult(buildSeedLedger());
  const v2 = readV2Ledger();
  const v1 = readV1Signals();
  if (!v1) return okResult(v2 ?? buildSeedLedger());
  return mergePendingMigration(v2, v1);
}

/** 重置：清除新旧台账并重新播种。 */
export function resetLedger(): PersistedLedger {
  const seeded = buildSeedLedger();
  if (browser) {
    localStorage.removeItem(V1_STORAGE_KEY);
    persistLedger(seeded);
  }
  return seeded;
}
