# Design: 内置 OpenSpec CLI 的产物沉淀

## Context

已确认的产品决策：用户在工作台中**通过 agent 使用真实的 openspec CLI** 迭代、创建自己的工作流等产物。工作区链路现状：agent 经 direct-CLI 会话运行（claude 子进程，cwd 为团队 workDir，具备 bash 能力）；standalone 包已内置 node 运行时并以 vendor 模式携带 cc-connect 二进制；团队 provisioning 已有 CLAUDE.md 托管块注入模式（`injectTeamInstructions`）。动机见 proposal.md「Why」。

## Goals / Non-Goals

**Goals**

- 用户零安装：openspec CLI 随产品分发，agent 可直接调用。
- 员工工作区即标准 OpenSpec 项目，`openspec validate/archive` 原生语义直接可用，服务端零重写。
- 产物（living specs）可被 agent 下次工作直接加载，并可 Git 同步分发。

**Non-Goals**

- 不改 OpenSpec 本体、不 fork CLI（版本锁定 vendor；升级走依赖更新流程）。
- 不做产物的手工编辑 UI（v1 只读）。
- 不做行为回放 eval（后续独立变更，Scenario 是天然用例库）。
- codex/pi 运行时的加载适配暂不要求（其 workDir 同样可有 openspec 项目，注入统一走 AGENTS.md 跨运行时标准；见 Open Questions）。

## Decisions

### D1：vendor 打包，内置 node 执行，不调系统环境

`@fission-ai/openspec`（版本锁定）随 standalone 包分发，调用方式 `<内置 node> <vendor>/openspec/bin/openspec.js <args>`。理由：用户机器不保证有 node/npm；复用 cc-connect 的 vendor 先例。npx 按需下载方案被否：离线不可用、首次延迟不可控、版本漂移。

### D2：建团队时初始化 openspec 项目 + AGENTS.md 沉淀指令

provisioning 时在 workDir 执行一次 init（生成 `openspec/{specs,changes,archive}` + `config.yaml`，schema 用 spec-driven），并注入托管块 `hermit:asset-precipitation:start/end` 到 **AGENTS.md**（跨运行时标准，claudecode/codex/pi 均读取；CLAUDE.md 仅保留指向 AGENTS.md 的指针行，若运行时要求）。内容：何时沉淀（用户要求 / 完成可复用工作法后主动建议）、命令序列（new change → 写工件 → validate → archive）、产物类型约定（workflow/skill/cron/mcp/command/behavior-contract）、复用约束（开工先读 `openspec/specs/`）。理由：AGENTS.md 是跨运行时唯一稳定注入点，避免把用户产物绑死在单一 harness 的配置文件上。

### D3：校验/合并/归档全部委托 CLI，服务端只做编排

服务端不重写任何 openspec 语义：沉淀触发后由 agent 在会话内执行 CLI；服务端仅提供（a）产物库读取（解析 specs/ 目录与 archive/ 记录供 UI 展示）、（b）可选的归档后置钩子（如触发 Git 同步）。原「移植合并规则」方案废弃——真 CLI 在场，移植即重复建设。冲突（MODIFIED/REMOVED 匹配失败）由 `openspec archive` 原生报错，agent 读错误自行修正重试。

### D4：产物本体与 change 记录分离

- skill：本体为 SKILL.md（技能体系既有约定），openspec change 记录「为什么创建、适用场景、怎么用」；
- workflow：本体为 openspec spec（步骤即 Given/When/Then 场景）；
- behavior-contract：living spec 即契约本体，渲染进 AGENTS.md 托管块（与 D2 同一注入点）。
理由：各类产物社区/产品已有本体格式，openspec 管的是**创建与演化过程**（delta、archive、可追溯），不替代本体格式。

### D5：复用 = 开工读 specs，分发 = Git 同步

AGENTS.md 指令要求 agent 接到任务先看 `openspec/specs/` 有无相关产物；产物目录位于 workDir，随团队模板的 Git 仓库源同步机制分发（对齐 AGENTS.md 的仓库同步方向）。不建独立的产物检索服务（v1 文件即索引）。

### D6：工作流原语模型与沉淀引导追问

workflow 产物的结构遵循四个原语：**Trigger**（何时开始：定时/事件/手动）、**Skill**（处理逻辑；Source=只读特化，Action=纯写特化）、**Flow**（步骤图；节点类型含 skill/action/wait/checkpoint——等待与人工确认是节点而非触发）、**Memory**（跨执行数据）。沉淀工作流时 agent MUST 按原语追问补全（触发？数据源？处理？输出给谁？失败兜底？要人确认吗？），把问答结果整理为 Flow spec，而不是直接存档对话记录。Checkpoint 节点复用产品既有评审闭环语义（通过/打回/拦截）。该模型写进 AGENTS.md 沉淀指令，作为 workflow 类产物的创建 schema。

### D7：归档后沉淀建议（系统主动时机）

「满意并归档」= 用户认可了这次的做法，是最强的沉淀信号。归档收尾消息之后，系统 SHALL 在同一评审线程追加一条 source='precipitation_suggestion' 的建议消息（如「这次的做法要沉淀为工作流吗？回复『沉淀一下』我就整理好」）。**同一任务只建议一次**：写入前检查线程中是否已存在该任务的 precipitation_suggestion 消息，存在则跳过（无状态判重，不需要 dismissed 字段）。用户回复确认即走正常沉淀流程，不回复或拒绝则自然结束。自动沉淀（不经用户确认）明确不做——产物贵在精挑。

## Risks / Trade-offs

- [agent 执行 CLI 出错（参数错、archive 冲突）导致沉淀中断] → CLI 错误信息本身可读，agent 重试；托管块指令内置常见错误处理示例；连续失败由用户感知（会话内可见全过程）。
- [产物膨胀/陈旧，specs/ 越积越多] → archive 历史可追溯；后续 eval 变更负责体检；v1 依赖用户在会话中自然管理。
- [vendor 版本与上游脱节] → 版本锁定 + 随产品升级流程更新；API 面（new/validate/archive/status）稳定。
- [多员工同时改同一 workDir 的 openspec 项目] → 当前模型一团队一 workDir 一会话，无并发写；跨员工共享产物走 Git 同步而非共享目录。

## Migration Plan

纯新增。存量团队回填：首次触发沉淀或团队设置保存时检测 workDir 无 `openspec/` 则补初始化（幂等）。回滚 = 移除托管块与 vendor，已沉淀的 openspec/ 目录是普通文件，无害留存。

## Open Questions

- codex/pi 运行时的产物加载：AGENTS.md 为跨运行时标准，预期可直接读取；若某运行时不支持，在后续变更中定义其注入格式。
- 产物是否纳入团队模板的分发清单（即「模板含初始 openspec specs」）：与团队模板功能对齐时再定。
