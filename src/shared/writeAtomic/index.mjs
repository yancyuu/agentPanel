// 跨平台原子写（shared .mjs + .d.mts，TS 与 bin/lib 同源）。
// tmp 写入 → rename；目标被占用/已存在（Windows 常见 EPERM、其余平台 EEXIST）
// 按 rm+rename 重试一次，避免半截文件；临时文件无论如何都清理。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} targetPath 目标文件
 * @param {string} content 文本内容
 * @param {{ mode?: number }} [options] 可选权限位（rename 后同样收敛到该权限）
 */
export async function writeAtomicFile(targetPath, content, options = {}) {
  const { mode } = options;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, mode !== undefined ? { mode } : undefined);
    try {
      await fs.rename(temporary, targetPath);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      // Windows 上目标被占用时 rename 失败：删除后重试（AgentCliShimProvisioner 同款容错）
      await fs.rm(targetPath, { force: true });
      await fs.rename(temporary, targetPath);
    }
    if (mode !== undefined) {
      // rename 覆盖既有文件时权限沿用旧文件，统一收敛
      await fs.chmod(targetPath, mode).catch(() => undefined);
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
