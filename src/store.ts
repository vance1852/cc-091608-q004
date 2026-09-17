import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersistedState } from "./contracts.ts";

export function emptyState(): PersistedState {
  return { version: 1, alarms: {}, timeline: [], grants: [], accessLog: [], timerSeq: 0 };
}

/**
 * 持久化端口。编排器只依赖该接口：
 * - 测试使用内存实现；
 * - 生产使用 JsonFileStore（同目录临时文件 + rename 原子替换），
 *   进程在任意一步之后重启都能用 load() 读回最近一次成功提交的状态。
 */
export interface StateStore {
  load(): Promise<PersistedState>;
  commit(state: PersistedState): Promise<void>;
}

export class InMemoryStore implements StateStore {
  private state: PersistedState = emptyState();

  async load(): Promise<PersistedState> {
    return cloneState(this.state);
  }

  async commit(state: PersistedState): Promise<void> {
    this.state = cloneState(state);
  }
}

export class JsonFileStore implements StateStore {
  private readonly path: string;
  private readonly tmp: string;

  constructor(path: string) {
    this.path = path;
    this.tmp = join(dirname(path), `.${basename(path)}.tmp`);
  }

  async load(): Promise<PersistedState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (isNoEntity(err)) return emptyState();
      throw err;
    }
    const parsed = JSON.parse(text) as PersistedState;
    if (parsed.version !== 1) throw new Error(`unsupported state version: ${parsed.version}`);
    return parsed;
  }

  async commit(state: PersistedState): Promise<void> {
    const text = JSON.stringify(state, null, 2);
    // 先写临时文件再原子改名，避免崩溃留下半截 JSON。
    await writeFile(this.tmp, text, "utf8");
    await rename(this.tmp, this.path);
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  const j = p.lastIndexOf("\\");
  return p.slice(Math.max(i, j) + 1);
}

function isNoEntity(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

/** 深拷贝，防止调用方持有的状态副本被后续修改污染。 */
export function cloneState(state: PersistedState): PersistedState {
  return structuredClone(state);
}
