<script lang="ts">
  import { ledgerRevisionStore } from '$lib/stores/signal-store';

  export let scope: '总览' | '信号台账' | '信号详情' | '批次追踪' | '审计';
</script>

<span
  class="inline-flex items-center gap-2 rounded border border-surface-300-700 bg-surface-100-900 px-3 py-1.5 text-xs text-surface-600-300"
  title="所有页面读取同一版本化台账；任何成功写入都会使版本号加一"
>
  <span class="h-2 w-2 rounded-full bg-teal-600"></span>
  {scope} · 台账版本 V{$ledgerRevisionStore}
</span>
