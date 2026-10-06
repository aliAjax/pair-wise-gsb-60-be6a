import type { EvidenceItem, EvidenceRef } from '$lib/models/signal';

/**
 * 证据内容指纹工具。
 * 指纹只由证据内容决定，与录入时间、操作人无关，
 * 因此同一来源批次重复导入同一内容时指纹保持一致。
 */

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** cyrb53 散列，生成确定性的内容指纹（本地台账去重用途，非安全散列）。 */
export function hashText(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export interface EvidenceContent {
  type: string;
  title: string;
  source: string;
  batch: string;
  note: string;
  strength: string;
}

/** 去重键：同一来源、同一批号、同一题录的记录视为同一条证据。 */
export function evidenceDedupeKey(input: Pick<EvidenceContent, 'type' | 'title' | 'source' | 'batch'>): string {
  return [input.type, input.title, input.source, input.batch].map(normalizeText).join('|');
}

/** 内容指纹：题录 + 核查说明 + 证据强度。内容任何修订都会改变指纹。 */
export function evidenceFingerprint(input: EvidenceContent): string {
  return hashText(
    [input.type, input.title, input.source, input.batch, input.note, input.strength]
      .map(normalizeText)
      .join('|')
  ).slice(0, 16);
}

export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}

/** 结论版本对证据矩阵的引用快照：证据号 + 内容指纹 + 修订号。 */
export function snapshotEvidenceRefs(evidence: EvidenceItem[]): EvidenceRef[] {
  return evidence.map((item) => ({
    evidenceId: item.id,
    fingerprint: item.fingerprint,
    revision: item.revision
  }));
}

/** 判断结论引用的证据版本与当前矩阵是否一致（新增、修订都会使引用失配）。 */
export function evidenceRefsMatch(refs: EvidenceRef[], evidence: EvidenceItem[]): boolean {
  if (refs.length !== evidence.length) return false;
  const current = new Map(evidence.map((item) => [item.id, item.fingerprint]));
  return refs.every((ref) => current.get(ref.evidenceId) === ref.fingerprint);
}
