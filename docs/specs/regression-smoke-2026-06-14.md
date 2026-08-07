# 回归冒烟基线 — 2026-06-14

> 分支 `spec/11-team-isolation-containers` · 基线提交 `4f590ae5` · 回归 cron `db149a79`(每 10 分钟)
> 角色:测试负责人。下方所有冒烟必须保持常绿;回归问题以「发现」形式落在这里。

## 1. 基线状态 — 全绿 ✅

| 面 | 检查 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | ✅ 0 error |
| 单测 | `pnpm test` | ✅ 268/268 文件,2747/2747 用例 |
| 后端健康 | `GET :5680/` | ✅ 200 |
| 团队列表 | `GET /api/teams` | ✅ 200,真实数据(5 团队) |
| 跨团队 | `GET /api/cross-team/discover` | ✅ 200 |
| 团队详情 | `GET /api/teams/:name` | ✅ 200 |
| 消息管道 | `GET /api/teams/:name/messages` | ✅ 200,feed 结构正确 |
| 看板 | `GET /api/teams/:name/board` | ✅ 200 |
| Web UI | `GET :5174/` | ✅ 200,title `Hermit` |

## 2. 本周期发现并修复 — SPEC 飘移

**`test/renderer/components/team/loop-console/LoopCommandComposer.test.tsx:55`** 仍断言旧文案 `Loop Console`,但组件早已重构为紧凑徽标 `cmd·发送给 Lead`(测试用例名 "compact … without dense explanatory badges" 本身就说明紧凑设计才是规范)。

- 4 条断言里**只有 1 条**飘移,其余 3 条对照当前组件仍成立。
- 修复:`toContain('Loop Console')` → `toContain('cmd')`。重跑 2747/2747 全绿。
- **根因类别:测试滞后于有意的 UI 改动 —— 不是代码回归。**

## 3. 修改意见

1. **行为覆盖缺口(P2)。** `LoopCommandComposer.test.tsx` 只断言静态头部文案,**没覆盖**:输入+提交、`parseLoopSendIntent`/`validateLoopSendIntent`、capability 命令解析、workflow 命令注入、`!runtime`/`!session`/`/loop` 解析。建议补行为测试,既保护提交路径,也避免下次文案改动漏检。
2. **`docs/specs/` 过薄。** 目前只有 `extension-store-backend.md`。loop-console、worker-society、capability-packs 这些功能有代码+测试却无 spec。建议每个已上线功能一页 spec 作为「权威目标」,消除「到底是测试飘移还是代码回归」的歧义(见 §2)。
3. **待决策项(等 owner):「spec 是否全部要改?」** 证据表明**否** —— 仅 1/4 断言飘移,一行修复后全量 2747/2747 全绿。整体重写不必要。建议:保留外科手术式修复 + 补 §1 行为测试。

## 4. 本周期卫生处置
- 多余产物已归档出树 → `~/.hermit-archive/hermit-2026-06-14/`(`_site/` Pages 产物、4 个无引用根 XML、5 个 debug 抓取脚本),均为无引用/可再生。
- 冒烟前按规则提交基线(`4f590ae5`)。
- 10 分钟回归 cron `db149a79`(typecheck + 全量 test,失败时区分飘移 vs 真回归)。

## 5. 下一步
- owner 决策 §3.3。
- 如需更深 UI/生命周期冒烟(gstack):针对当前基线重跑派单全生命周期。注意会写状态(建团队/任务),既有证据见 `docs/测试用例/gstack-qa-report.md`。
