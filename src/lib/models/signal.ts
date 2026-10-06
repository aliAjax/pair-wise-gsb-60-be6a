import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;
export const versionStates = ['active', 'pending_review', 'confirmed', 'superseded'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  sourceBatch: z.string().trim().min(2, '请填写来源批次'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export const confirmReviewSchema = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
  actor: z.string().trim().min(2, '请填写复核人'),
  note: z.string().trim().min(4, '请填写复核意见')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];
export type VersionState = (typeof versionStates)[number];

/** 同一内容指纹的证据被重复登记时，只追加一条来源批次关联。 */
export interface EvidenceReference {
  sourceBatch: string;
  actor: string;
  createdAt: string;
}

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  /** 首次登记时的来源批次（导入批次号）。 */
  sourceBatch: string;
  /** 内容指纹：题录 + 核查说明 + 强度归一化后的散列。 */
  fingerprint: string;
  /** 内容修订号，内容变化时递增。 */
  revision: number;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 同指纹重复登记时追加的关联记录。 */
  references: EvidenceReference[];
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
}

/** 结论形成时引用的证据版本快照。 */
export interface EvidenceRef {
  evidenceId: string;
  fingerprint: string;
  revision: number;
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
  /** 该结论基于的证据版本快照，用于事后核对“结论引用的证据版本”。 */
  evidenceRefs: EvidenceRef[];
  /** active 有效 / pending_review 证据变化待复核 / confirmed 复核确认 / superseded 已被新版本取代 */
  state: VersionState;
  staleReason?: string;
  staleAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  reviewNote?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  riskLevel: RiskLevel;
  severity: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  /** 乐观并发令牌：每次变更递增，提交时校验，后到者不得覆盖先行结果。 */
  revision: number;
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
}

/** 持久化台账：带架构版本与全局修订号，支持可恢复迁移。 */
export interface PersistedLedger {
  schemaVersion: number;
  /** 台账全局修订号，每次成功写入递增，各页面据此确认显示同一版本。 */
  revision: number;
  signals: SignalCase[];
  /** 已完成迁移的旧台账信号号，重试时跳过，保证不重复导入。 */
  migratedFromV1: string[];
  updatedAt: string;
}

export interface LedgerMeta {
  schemaVersion: number;
  revision: number;
  migrationPending: boolean;
  migrationRemaining: number;
  migrationError?: string;
  persistError?: string;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}
