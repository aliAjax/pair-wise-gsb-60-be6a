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

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

/** 所有处置类动作都必须携带客户端读取时的信号修订号，用于并发重校验 */
const expectedRevisionInput = z.preprocess((value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}, z.number({ error: '修订号缺失，请刷新页面重试' }).int().positive());

export const transitionSchema = z.object({
  id: z.string().min(1),
  expectedRevision: expectedRevisionInput,
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  expectedRevision: expectedRevisionInput,
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  sourceBatch: z.string().trim().min(2, '请填写来源批次（如导入批次号或系统单号）'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明'),
  actor: z.string().trim().min(2, '请填写录入人')
});

/** 修订证据内容（不是追加新证据），用于触发引用版本失效流程 */
export const evidenceRevisionSchema = z.object({
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  expectedRevision: expectedRevisionInput,
  source: z.string().trim().min(2, '请填写来源'),
  sourceBatch: z.string().trim().min(2, '请填写来源批次'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写修订后的核查说明'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  expectedRevision: expectedRevisionInput,
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export const reviewSchema = z.object({
  id: z.string().min(1),
  expectedRevision: expectedRevisionInput,
  reviewer: z.string().trim().min(2, '请填写复核人'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  summary: z.string().trim().min(8, '复核结论摘要至少 8 个字符'),
  rationale: z.string().trim().min(6, '请填写复核依据')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];

export interface EvidenceRef {
  evidenceId: string;
  /** 结论形成时引用的证据内容指纹；引用版本据此判断证据是否变化 */
  fingerprint: string;
  title: string;
  strength: EvidenceStrength;
}

export interface EvidenceRevision {
  revision: number;
  actor: string;
  source: string;
  sourceBatch: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  /** 本次修订后的内容指纹；内容未变时与上一版相同 */
  fingerprint: string;
  changedAt: string;
}

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  /** 证据进入台账的来源批次（导入批次/报告批次号），同指纹再次补入时只追加关联 */
  sourceBatch: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  /** 规范化证据内容指纹，命中已有指纹时不重复建证据 */
  fingerprint: string;
  /** 同一指纹在不同来源批次补入时，逐条追加，不去重覆盖 */
  linkedBatches: string[];
  revisions: EvidenceRevision[];
  createdAt: string;
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
}

export type CaseVersionState = 'active' | 'stale_pending_review' | 'superseded';

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  /** 结论引用的证据快照（证据 ID + 当时指纹），旧台账缺字段时迁移补建 */
  evidenceRefs: EvidenceRef[];
  state: CaseVersionState;
  /** 失效原因：哪些证据指纹发生变化 */
  staleReason?: string;
  supersededBy?: string;
  createdAt: string;
}

/** 被引用证据变化后形成的待复核锁；复核人确认前不得继续处置 */
export interface ReviewBlock {
  since: string;
  reason: string;
  changedEvidenceIds: string[];
  /** 进入复核前的状态，确认后恢复，避免静默跳过处置环节 */
  previousStatus: SignalStatus;
  confirmedAt?: string;
  reviewer?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
  /** 写入该记录时的台账全局版本号，四个页面据此显示同一版本 */
  dataVersion: number;
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
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
  /** 信号级修订号，每次追加记录加一，两个标签页并发提交时作为乐观锁 */
  revision: number;
  reviewBlock?: ReviewBlock;
  /** v1 台账迁移为可恢复版本结构时的来源标记 */
  migratedFromLegacy?: boolean;
}

/** 旧版种子与 localStorage v1 数据的结构（新字段均可能缺失） */
export type LegacySignalCase = Omit<
  SignalCase,
  'revision' | 'reviewBlock' | 'migratedFromLegacy' | 'evidence' | 'versions' | 'audit'
> & {
  revision?: number;
  reviewBlock?: ReviewBlock;
  migratedFromLegacy?: boolean;
  evidence: Array<Omit<EvidenceItem, 'sourceBatch' | 'fingerprint' | 'linkedBatches' | 'revisions'> & {
    sourceBatch?: string;
    fingerprint?: string;
    linkedBatches?: string[];
    revisions?: EvidenceRevision[];
  }>;
  versions: Array<Omit<CaseVersion, 'evidenceRefs' | 'state'> & {
    evidenceRefs?: EvidenceRef[];
    state?: CaseVersionState;
  }>;
  audit: Array<Omit<AuditEntry, 'dataVersion'> & { dataVersion?: number }>;
};

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}

export type MutationErrorCode =
  | 'not_found'
  | 'unmigrated'
  | 'conflict'
  | 'review_locked'
  | 'no_evidence'
  | 'unknown';

export interface EvidenceInput {
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  sourceBatch: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
}

export interface MutationResult {
  ok: boolean;
  errorCode?: MutationErrorCode;
  message?: string;
  /** 重校验后服务端的最新修订号，冲突页面据此更新隐藏版本 */
  currentRevision?: number;
  /** 命中同指纹证据时返回，用于提示“仅追加关联、未重复入库” */
  deduped?: boolean;
}
