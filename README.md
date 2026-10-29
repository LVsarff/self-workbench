# gwd-workbench —— 个人 AI 带货工作台（MVP）

> **红线（先读这个）**
> 1. **不碰小红书登录态**：任何采集/自动化只针对抖音练手号；小红书相关一律人工操作。
> 2. **不自动发布**：系统只做"生成 + 记录 + 提醒"，发布动作永远人工（平台风控 + 账号安全）。
> 3. **AI 生成内容必须人工确认后才使用**；选品不做夸大宣传。
> 4. **写操作全部 append-only 落审计**，规则改动必须人批准后生效。

MVP 范围 = PRD 模块①「选品中心」：人工维护候选表格（每天 ≤5 分钟）→ 确定性打分 → 单 Agent 生成推荐理由 → **人勾选**（门①）→ 决策沉淀为后续内容生成的输入。

## 架构（单 Agent 最小方案）

```
人工 CSV（选品广场抄数）                每日 09:00（BullMQ 定时）
        │                                      │
        ▼                                      ▼
  gwd import-candidates                runDailyScan 流水线
        │                               ├─ [代码] 快照→黑名单→门槛(L1)→七维打分→排序→落库
        ▼                               ├─ [Agent] TopN 理由生成（LLM 失败→模板降级）
   PostgreSQL（快照/打分/理由）           └─ submit（确定性收尾，带审计）
        │                                      │
        ▼                                      ▼
   规则版本链（人批准生效）          今日候选清单（CLI / Web 勾选门）
                                               │
                                               ▼ 【人工】勾选（门①）
                                    decisions（append-only 决策流水）
                                               │
                                               ▼
                                    下一步：内容工坊（V2，未实现）
```

- **三层判断**：L1 确定性规则（门槛/打分，纯代码无 LLM）· L2 概率推断（推荐理由，有 grounding 校验）· L3 人的判断（勾选门）
- **五层停止**：submit 工具即完成 · stepCountIs 步数硬限 · 未提交/校验失败降级 · 勾选门 24h 超时顺延 · LLM 日预算熔断
- **有价值的降级**：没配 OPENAI_API_KEY、LLM 挂掉、超预算 → 模板理由补位，流水线**永远能完成**

## 快速开始

```bash
# 0) 依赖（Node ≥ 20）
npm install

# 1) 一键体验全流程（内存模式，不需要 DB 和 API key）
npm run gwd -- demo

# 2) 真实使用
docker compose up -d                  # postgres + redis
cp .env.example .env                  # 按需改（LLM 可不配）
npm run gwd -- migrate                # 建表
npm run gwd -- rule init              # 初始化规则 v1（PRD A.1/A.2）

# 3) 每天两步
npm run gwd -- import-candidates templates/candidates-example.csv   # 换成你自己的表
npm run gwd -- daily-scan

# 4) 勾选（两种方式任选）
npm run gwd -- select P1001 P1004 --note "今天做这两个"
# 或 Web 勾选门：
npm run api                           # Fastify :8787
cd web && npm install && npm run dev  # Next.js :3000 → 浏览器勾选
```

## 候选 CSV 格式

中文表头（与选品广场口径一致），示例见 `templates/candidates-example.csv`：

| 列 | 必填 | 说明 |
|---|---|---|
| 商品ID / 标题 | ✅ | 平台商品唯一标识 |
| 价格 / 佣金率 / 近30天销量 / 好评率 / 商家体验分 | ✅ | 核心商业字段，缺任一整行跳过（不编数据） |
| 类目 / 履约方式 | 可空 | 缺失 → 门槛记 unknown + 提示复核 |
| 品退率 / 环比 | 可空 | 品退缺失不惩罚；环比缺失按持平打分并标记 |
| 内容友好度 / 竞争度 / 复购扩展性 | 可空 | 主观三维，人工打档 1-5；**未填的品不参与排序**（待评） |
| 主图 | 可空 | 展示用 |

同一商品当天重复行 → 后行覆盖（数据修正语义）。

## 命令一览

```
gwd migrate                          应用数据库迁移
gwd rule init|show|list|apply|rollback  规则版本管理（AI 只建议，人批准生效）
gwd import-candidates <csv> [--date]   导入候选表（MVP 数据入口）
gwd daily-scan [--date] [--no-agent]   跑流水线：打分→排序→Agent 理由→提交
gwd list [--date]                      查看今日候选清单
gwd select <id...> [--note]            勾选门：勾选要做的品
gwd demo                               无 DB/无 key 一键体验
```

规则调整示例：改 `templates/rule-example-modified.json` → `npm run gwd -- rule apply templates/rule-example-modified.json --reason "跑两周数据后提佣金门槛"` → 不满意 `gwd rule rollback`。

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm run test        # vitest：门槛/打分边界、CSV 解析、流水线降级、勾选幂等、
                     # Agent 工具循环（MockLanguageModelV4：正常提交/步数耗尽/幻觉丢弃）、
                     # 对抗性测试 + API 鉴权回归
```

## 安全边界（对抗测试后固化）

已完成一轮红队测试（`src/security/adversarial.test.ts`，恶意输入 / Prompt 注入 / 越权指令 / 危险命令四类）。守住的核心防线与已修复的缺口：

- **结构性隔离**：L1 打分零 LLM 参与，注入改变不了分数和排序；Agent 工具面只有 `save_reason`/`submit_list`，无任何 DB 写权限（落库由流水线代码执行）
- **P1 API 鉴权（已修）**：默认只监听 `127.0.0.1`；配置 `GWD_API_TOKEN` 后所有 `/api/*` 要求 `x-api-token` 头，此时才可 `HOST=0.0.0.0` 暴露内网（web 端配 `NEXT_PUBLIC_API_TOKEN` 同值）
- **P2 输入截断（已修）**：商家可控文本（标题 120 字 / 类目 40 字）进 Agent prompt 前截断并标记，防超长载荷炸上下文
- **P3 引用白名单（已修）**：`cited_fields` 必须属于注入上下文的真实字段集，伪造字段名被剥离、全伪造整条丢弃
- **SQL 全参数化**：`'); DROP TABLE ...` 类载荷原样存取；注入文本夹带的禁售词照样被门槛拦截
- 降级兜底：伪造 `run_id`、步数耗尽、LLM 失败 → 模板理由补位，流水线永远能完成

## 设计文档（本仓库的"为什么"）

| 文档（上级目录） | 内容 |
|---|---|
| `AI带货工作台-场景拆解.md` | 信息/动作/判断/风险四轴拆解 |
| `AI带货工作台-上下文与工具设计.md` | 上下文分层 / RAG / 工具权限 / MVP 最小集 |
| `AI带货工作台-单Agent最小方案.md` | **本实现的直接规格**：Prompt 分层、五层停止、三层状态 |
| `选品判据与AI带货助手PRD.md` | A.1 门槛 + A.2 七维打分（已代码化为 `RULE_V1`） |

## 目录结构

```
src/
  core/        领域规则：门槛、七维打分、规则配置（版本化）、模板理由
  db/          PgRepo（生产）/ MemoryRepo（测试+demo）/ 迁移
  agent/       单 Agent 运行时：骨架 prompt + daily-scan 任务包 + 工具循环
  pipeline/    daily-scan 主流水线 / CSV 导入 / 勾选门服务
  api/         Fastify（给 Web 用）
  queue/       BullMQ 每日定时 + 勾选门超时
migrations/    SQL 迁移（append-only 审计表在 0001）
templates/     候选 CSV 示例 / 空模板 / 规则修改示例
web/           Next.js 勾选门页面（最小实现）
```

## 下一步（按 PRD 版本规划）

- V2：模块② 内容工坊（勾选结果 → 文案/脚本生成 → 人工确认门）
- V2：模块③ 发布管理（台账 + 提醒，不代发）
- V3：数据监控 + 复盘 + 规则自进化（用真实成交数据校准 `RULE_V1` 权重）
