import { fail } from '@sveltejs/kit';
import {
  evidenceRevisionSchema,
  evidenceSchema,
  reviewSchema,
  transitionSchema,
  versionSchema
} from '$lib/models/signal';
import { contentFingerprint } from '$lib/services/fingerprint';

export function load({ params }) {
  return { id: params.id };
}

const actorName = (formData: FormData) => String(formData.get('actor') ?? '安全评审专员');

function failure(error: { issues: Array<{ message: string }> }) {
  return fail(400, {
    message: error.issues[0]?.message ?? '表单校验失败'
  });
}

export const actions = {
  transition: async ({ request }) => {
    const formData = await request.formData();
    const parsed = transitionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      transition: parsed.data
    };
  },

  evidence: async ({ request }) => {
    const formData = await request.formData();
    const parsed = evidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    const data = parsed.data;
    return {
      success: true,
      expectedRevision: data.expectedRevision,
      evidence: {
        type: data.evidenceType,
        title: data.title,
        source: data.source,
        sourceBatch: data.sourceBatch,
        strength: data.strength,
        batch: data.batch,
        note: data.note,
        fingerprint: contentFingerprint({
          type: data.evidenceType,
          title: data.title,
          source: data.source,
          note: data.note
        })
      },
      actor: data.actor
    };
  },

  reviseEvidence: async ({ request }) => {
    const formData = await request.formData();
    const parsed = evidenceRevisionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    const data = parsed.data;
    return {
      success: true,
      expectedRevision: data.expectedRevision,
      revision: {
        evidenceId: data.evidenceId,
        source: data.source,
        sourceBatch: data.sourceBatch,
        strength: data.strength,
        batch: data.batch,
        note: data.note
      },
      actor: data.actor
    };
  },

  version: async ({ request }) => {
    const formData = await request.formData();
    const parsed = versionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    // 版本号由 store 依据现有版本重新生成，两个标签页并发时不会各自保存成同一版本
    return {
      success: true,
      expectedRevision: parsed.data.expectedRevision,
      version: {
        author: parsed.data.author,
        summary: parsed.data.summary,
        disposition: parsed.data.disposition,
        rationale: parsed.data.rationale
      },
      actor: parsed.data.author
    };
  },

  review: async ({ request }) => {
    const formData = await request.formData();
    const parsed = reviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      review: parsed.data
    };
  },

  reopen: async ({ request }) => {
    const formData = await request.formData();
    const actor = actorName(formData);
    const reason = String(formData.get('reason') ?? '').trim();
    const id = String(formData.get('id') ?? '');
    const expectedRevision = Number(formData.get('expectedRevision') ?? 0);

    if (reason.length < 6) return fail(400, { message: '重新打开原因至少 6 个字符。' });

    return {
      success: true,
      reopen: { id, expectedRevision, actor, reason, createdAt: new Date().toISOString() }
    };
  }
};
