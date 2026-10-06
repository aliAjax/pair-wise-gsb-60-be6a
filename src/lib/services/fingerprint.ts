import type { EvidenceItem, EvidenceStrength } from '$lib/models/signal';

/**
 * 证据内容指纹。
 *
 * 指纹只覆盖证据的“内容字段”（类型、名称、来源、核查说明），
 * 不包含强度（评估变化）与批号（关联追加），因此：
 * - 同一内容在不同来源批次补入 → 同指纹，只追加 linkedBatches 关联；
 * - 证据说明/来源被修订 → 指纹变化，引用它的旧结论失效转待复核。
 *
 * 使用确定性的 64 位 FNV-1a（BigInt 实现，同步、无 Web Crypto 依赖，
 * 表单动作与 SSR 均可调用），前缀标明算法，便于将来升级。
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function contentFingerprint(input: {
  type: EvidenceItem['type'];
  title: string;
  source: string;
  note: string;
}): string {
  const canonical = [
    input.type.trim(),
    input.title.trim().replace(/\s+/g, ' '),
    input.source.trim().replace(/\s+/g, ' '),
    input.note.trim().replace(/\s+/g, ' ')
  ].join('');

  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(canonical);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** 列表展示用短指纹 */
export function shortFingerprint(fingerprint: string): string {
  const value = fingerprint.includes(':') ? fingerprint.split(':')[1] : fingerprint;
  return value.slice(0, 10);
}

export function fingerprintChanged(
  evidence: Pick<EvidenceItem, 'type' | 'title' | 'source' | 'note'>,
  next: {
    type: EvidenceItem['type'];
    title: string;
    source: string;
    strength: EvidenceStrength;
    batch: string;
    note: string;
  }
): boolean {
  return contentFingerprint(evidence) !== contentFingerprint(next);
}
