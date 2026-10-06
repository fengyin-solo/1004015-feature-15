/* 测试垫片：在任何数据层模块导入前提供内存版 localStorage（纯前端无浏览器环境） */
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
  key: (index: number) => [...mem.keys()][index] ?? null,
  get length() {
    return mem.size
  },
} as unknown as Storage
