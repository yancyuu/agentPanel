/**
 * hermit-bridge spawns each agent subprocess with `chdir(<project work_dir>)`. When a
 * project's work_dir is stale — or still the default template placeholder below —
 * every session fails at agent start with `chdir ...: no such file or directory`,
 * which hermit-bridge surfaces as "❌ 错误: 启动 Agent 会话失败". The session record is
 * created fine, so the user sees the success message AND the failure.
 *
 * This hit the 诊断 hardest: its bind project is `my-project`, the same name
 * hermit-bridge ships as an unconfigured template (`work_dir = /path/to/your/project`).
 */

/** hermit-bridge's default template project work_dir — a placeholder that was never filled. */
export const HERMIT_BRIDGE_PLACEHOLDER_WORK_DIR = '/path/to/your/project';

/**
 * Decide whether a hermit-bridge project's work_dir must be reconciled to the
 * team manifest's work_dir.
 *
 * Reconcile only when we have a concrete expected dir AND the project's current
 * work_dir differs. The placeholder is caught by the inequality check, so the
 * common broken case needs no special-casing. We never overwrite with an empty
 * expected value — that would clear a valid path instead of repairing a bad one.
 */
export function needsWorkDirReconcile(
  actualWorkDir: string | undefined | null,
  expectedWorkDir: string | undefined | null
): boolean {
  const expected = expectedWorkDir?.trim();
  if (!expected) return false;
  return (actualWorkDir?.trim() ?? '') !== expected;
}

/** True when a work_dir is hermit-bridge's default template placeholder. */
export function isPlaceholderWorkDir(workDir: string | undefined | null): boolean {
  return workDir?.trim() === HERMIT_BRIDGE_PLACEHOLDER_WORK_DIR;
}
