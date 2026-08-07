# 首批清理与 Team Slice 拆分设计

- **日期**：2026-07-25
- **状态**：待用户复核
- **范围决策**：采用方案 A——移除未接入 Pixel Office、清理已证实的未使用代码，并首先拆分 `teamSlice.ts`。

## 目标

在不改变已发布的运行时行为或 Zustand store 公共接口的前提下，删除已确认的孤立功能和死代码，并降低 `src/renderer/store/slices/teamSlice.ts` 的职责密度与维护成本。

## 非目标

- 不删除 `src/main/services/ccConnect/` 兼容层；其可能被已发布包的外部深度导入使用。
- 不在本批次拆分 `src/main/server.ts` 或 `LaunchTeamDialog.tsx`。
- 不启用全仓 `noUnusedLocals` 或 `noUnusedParameters` 作为本批次的阻断规则；先处理已审计且逐一确认的项目内死代码，再另行决定治理策略。
- 不改变团队刷新、缓存、消息、图布局或启动流程的用户可见行为。

## 当前证据

1. `src/features/pixel-office/core/domain/projectOffice.ts` 仅被自身测试引用；仓库搜索未发现 renderer、main 或 feature public entrypoint 的引用。
2. 常规基线命令 `pnpm typecheck` 已通过。
3. 增加 `--noUnusedLocals --noUnusedParameters` 的只读 TypeScript 审计发现一批未使用 import、类型、参数和局部变量。正式配置目前不启用这些检查，因此每一项删除前仍需检查相邻使用和运行时语义。
4. `teamSlice.ts` 约 5,124 行，模块级请求协调状态、数据加载、缓存/epoch 失效、图布局、消息流、团队命令和 provisioning 状态机混在同一文件中。

## 实施策略

采用三个彼此独立、可回滚的变更。每步完成后运行对应测试；任何行为保护测试失败时停止并修复或回滚该步骤。

### 1. 移除未接入 Pixel Office

删除 `src/features/pixel-office/` 与只服务于该 feature 的测试。

变更前重新运行仓库引用搜索，确认没有新增生产入口或动态加载路径。删除后运行相关测试发现、`pnpm typecheck` 与全量测试，以确认不存在静态或测试依赖。

**可感知行为**：如果存在未被仓库记录的外部消费者或实验性本地入口，它将不再可用；当前仓库证据未发现这种入口。发布说明应明确列出该移除。

### 2. 删除已证实未使用的代码

按最小 diff 清理 TypeScript 审计中可逐项证明无引用的内容：未使用 import、类型别名、局部常量和形参。不会仅凭名称搜索删除导出的符号、文件或兼容 API。

每个批次按模块分组，避免将格式化、重命名或逻辑改写混入死代码清理。保留 Fastify handler 形式所需的参数；如果参数仅为满足回调签名而存在，优先使用项目当前的约定而不是改变 handler 签名。

**可感知行为**：无预期行为变化。

### 3. 提取 Team 数据刷新协调器

第一轮只处理 `teamSlice.ts` 的数据刷新职责，不同时搬移消息流、图布局或 provisioning。

新增一个内部协调器模块（建议：`src/renderer/store/slices/teamDataCoordinator.ts`），拥有：

- 同团队请求去重和 fresh 请求路径；
- 本地 state epoch 的创建、比较与失效；
- in-flight 和临时刷新状态；
- 结构共享和快照一致性 helper；
- 与以上模块状态对应的测试重置入口。

`teamSlice.ts` 保留 `TeamSlice` 状态结构、对外 action 名称和 Zustand 装配。协调器通过显式依赖接收 API、`get`、`set` 与必要回调，禁止读取 store 的隐藏全局状态。这使异步依赖与刷新顺序显式化，同时避免复制状态或创建第二个 Zustand slice。

## 行为保护与测试

在移动逻辑前，为数据刷新边界补充/确认特性化测试，至少覆盖：

| 场景 | 预期不变量 |
| --- | --- |
| 同团队并发普通刷新 | 共享同一 in-flight 请求，避免重复网络调用 |
| fresh 与普通刷新 | fresh 请求保持其绕过缓存/强制更新语义 |
| 团队删除后的旧请求完成 | 旧响应不能将已删除团队重新写回 store |
| 缓存同步 | 当前选中团队和缓存快照保持既有同步规则 |
| 请求失败 | 既有错误状态和已保留数据的行为不变 |

测试优先放在 `src/renderer/store/slices/__tests__/teamSlice.data.test.ts` 或项目现有同域测试文件中。测试使用可控 Promise 和明确的 `afterEach` 重置协调器模块状态，覆盖竞态而非只覆盖最终状态。

## 验证

每个独立变更至少执行：

```bash
pnpm typecheck
pnpm test
pnpm lint
python C:/Users/Administrator/.pi/agent/skills/clean-code-standards/scripts/clean_code_scan.py <changed-file>
```

此外：

- 删除 Pixel Office 前后执行针对性 `rg` 引用检查；
- 死代码清理后重新运行 `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters`，将剩余项作为后续 backlog，而非宣称全仓清零；
- `teamSlice` 拆分后，运行新旧测试并比较公开 action 名称、参数和 store 可观察结果。

## 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| Pixel Office 是未接入但仍计划发布的功能 | 删除前再次确认入口；此次已获范围确认；提交中单独列出移除内容 |
| 死代码检测误判导出或运行时反射 | 不删除 export/file/兼容层；逐项检查调用和框架签名 |
| 刷新协调器涉及竞态 | 先补可控 Promise 的特性化测试；模块状态和 reset hook 一起迁移 |
| 拆分后出现依赖隐藏 | 通过 factory 显式传入 API、`get`、`set` 和回调；不从新模块 deep-import store internals |

## 完成标准

- Pixel Office 与其测试已删除，且引用搜索没有剩余生产依赖。
- 仅删除经审计和复查证实未使用的内部代码；兼容 API 未被误删。
- `teamDataCoordinator` 只承载刷新协调职责，`teamSlice` 公共接口不变。
- 上表中的刷新竞态具有自动化测试覆盖。
- 所有实际运行的验证命令通过；若有既有失败，报告准确区分为未由本次变更造成的已知问题。
- 交付报告按 Clean Code `F4/G9`、`G30/G34`、`G5`、`G25` 记录处理与剩余豁免。
