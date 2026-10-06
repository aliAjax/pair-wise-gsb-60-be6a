// 本地存储桩：必须在导入 store 前安装。
const data = new Map<string, string>();
let failNextWrites = 0;

export function failNextWrite(count = 1) {
  failNextWrites = count;
}

export function rawGet(key: string) {
  return data.get(key) ?? null;
}

export function installLocalStorage() {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failNextWrites > 0) {
        failNextWrites -= 1;
        throw new Error('QuotaExceededError: 模拟写入失败');
      }
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear()
  };
  // store 在 browser 环境下会注册 storage 监听；Node 中提供最小桩。
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => undefined
  };
}

let passed = 0;
let failed = 0;

export function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

export function summary() {
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) {
    // 避免依赖 @types/node：通过全局函数退出。
    const exit = (globalThis as Record<string, unknown>).process as
      | { exit: (code: number) => never }
      | undefined;
    exit?.exit(1);
  }
}
