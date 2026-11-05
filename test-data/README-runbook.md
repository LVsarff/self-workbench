# 测试数据验收手册（test-data/）

本目录是为 gwd-workbench MVP 验收准备的**四类测试数据 + 自检脚本 + 本手册**：
正常 / 边界 / 异常 / 组合。全部数据先经 `verify-data.ts` 用**项目真实代码**校验过
（打分口径、CSV 校验、schema 边界、违禁词、相似度均与 src/ 一致），再进入下面的验收流程。

---

## 0. 数据总览

| 目录 | 类别 | 文件 | 覆盖点 |
|---|---|---|---|
| `01-normal/` | 正常 | `candidates-normal.csv`（20 行 / 19 品） | 主链路：打分、top5、六门槛各命中、分级临界 80/79/60/59、修正行覆盖、别名（￥/千分位/↑/涨）、待评品 2 个 |
| | | `research-positive / mixed / risky.txt` | 深度调研三种舆情（risky 含「医用级」冲突宣称，验证风险信号提取） |
| | | `api-select-normal.json` | POST /api/select 4 个正常载荷 |
| | | `rule-v2-valid.json` | 合法 v2 规则（佣金门槛 18%、满分合计 100） |
| | | `api-rules-expected.json` | GET /api/rules 的 v1 断言参照 |
| `02-boundary/` | 边界 | `candidates-boundary.csv`（15 行） | 六门槛临界值（15.00/15.01、85/84.99、10/10.01、70/69.9）、价格带端点、销量端点、主观 0/6 与 1/5 |
| | | `candidates-edge-text.csv` | 123 字超长标题、emoji、引号转义、类目含逗号、履约含换行 |
| | | `candidates-header-mixed.csv` | 中英混合表头别名 |
| | | `content-draft-bounds.json` | 草稿结构 12 组边界（title 5/20、body 150/500、tags 3/8/9、hook 5/30、points 2/4、cta 5） |
| | | `note-500.txt` / `note-510.txt` | confirm/discard 备注 500 上限（510 触发截断） |
| | | `research-49/50/8000/8001/nul.txt` | 调研原文下限 50、上限 8000、NUL 字符剥离 |
| `03-abnormal/` | 异常 | `candidates-broken.csv`（16 行） | 缺必填 ×3、非数值 ×4、负价格、1e5、SQL/prompt 注入、空格 ID、乱环比 |
| | | `candidates-header-broken.csv` | 全错表头 3 行全跳 |
| | | `rule-invalid-*.json` ×4 | 满分合计 99、缺档位、testMin≥strongMin、schema 类型错 |
| | | `api-abnormal.json` | 18 个异常用例（400/401/409、URL 校验、幂等拦截、硬拦截） |
| | | `research-injection.txt` / `research-flood.txt` | prompt 注入原文 / 20000 字超长 |
| | | `seed-banned-draft.sql` | 违禁词草稿种子（门③ 硬拦截 + 修词重生成） |
| `04-combined/` | 组合 | `candidates-day1/day2.csv`（各 12 行） | 连续两日：10 延续 / 2 消失 / 2 新增、趋势翻转、修正行、待评补齐入榜 |
| | | `seed-full-chain.sql` | 全链路 13 表闭环（快照→run→打分→理由→决策→草稿→门③→发布→调研），FK 全对上、时间递增 |
| | | `seed-duplicate-drafts.sql` | 跨品同题标题相似 0.7778 ≥ 0.7 命中 + 存量 pending 防误发布 |
| | | `seed-discard-regen.sql` | 弃用重做链（draft_id 不变语义 + publish-sync 幂等） |
| | | `seed-versions.sql` | 规则版本链预置（v1 active + v2 rolled_back） |
| 根目录 | — | `verify-data.ts` | 数据自检（216 项断言） |

数据规模：约 **134 个数据单元**，覆盖全部 13 张表、17 个 CLI 命令、4 个 API 端点。

---

## 1. 环境准备

### 1.1 数据库（pg 模式 —— 完整验收必须）

```powershell
docker compose up -d          # 或自备 PostgreSQL
# 钉死 127.0.0.1，不要用 localhost：部分机器上 localhost 会在 IPv4(docker 代理) 与
# IPv6(WSL 中继) 之间漂移解析，导致「同命令连到不同库」的假象（项目 .env 同理）
$env:DATABASE_URL = 'postgres://gwd:gwd@127.0.0.1:5432/gwd'
npm run gwd -- migrate        # 应用迁移
npm run gwd -- rule init      # 初始化规则 v1
```

> **memory 模式限制**：`--db memory` 每条命令都是独立的全新内存库，**跨命令不共享**，
> 因此 import→scan→select 的链路验收必须走 pg。`gwd demo` 是唯一内置的内存全流程演示。

### 1.2 LLM Key（可选，影响部分预期）

无 `OPENAI_API_KEY` 时系统的设计内降级：

| 命令 | 无 key 行为 |
|---|---|
| `daily-scan` | 模板理由（输出提示「使用模板理由」；`--no-agent` 直接走此路径） |
| `grade-suggest` | 提示「待评品请人工打档」，照常列出待评清单 |
| `research` | **报错退出**：「未配置 OPENAI_API_KEY——调研摘要需要 LLM」 |
| `content-gen` | 草稿标记 `needs_manual`（需人工撰写，流水线照常完成） |

有 key 时还有日预算熔断：`GWD_LLM_BUDGET_CALLS_PER_DAY`（默认 50 次/天）。

### 1.3 第零步：数据自检（每次改动数据后都先跑）

```powershell
npm run gwd -- demo            # 顺带确认项目本身流程未被破坏（内存模式，无需 DB）
npx tsx test-data/verify-data.ts
```

预期末行：`✅ 216 项通过，❌ 0 项失败`。任何 FAIL 按提示修正后重跑。

---

## 2. 场景 A：正常数据主链路（01-normal，日期 2026-10-30）

> 本场景走「今天」的完整活链路。**注意**：内容链路勾选 78412563 + 48219753，
> 因为 35692147 / 63941758 / 38574129 / 77030001 的草稿行由场景 D 的种子占用
> （`content_drafts` 有全局 UNIQUE(product_id, platform)，同品活链路与种子会互相覆盖）。

```powershell
# 1) 导入（20 行 → 19 唯一品，同 ID 后行覆盖）
npm run gwd -- import-candidates test-data/01-normal/candidates-normal.csv --date 2026-10-30
#    预期：共 20 行，有效 20（新增 19 / 更新 1 —— 35692147 有两行：首行 + 修正行，
#    同批内后行覆盖前行），跳过 0
#    修正行已生效：35692147 销量 8600→9200、好评 97→98（后行覆盖前行）
#    再导一次 → 新增 0 / 更新 20（幂等；35692147 两行先后覆盖，终值仍是修正行数值）

# 2) 打分 + 理由 + top5
npm run gwd -- daily-scan --date 2026-10-30
#    预期：打分 19（入榜 11，待评 2，门槛淘汰 6，黑名单 0）
#    理由来源: template（无 key，降级）/ llm（有 key）
#    top5 顺序：35692147(98强推) → 63941758(88) → 78412563(86) → 48219753(83) → 90213547(80)
#    「未入榜」区可见 40875962 每日坚果 90分/强推 但门槛未过（类目含「食品」禁售）

# 3) 待评品打档建议（不落库，人改 CSV）
npm run gwd -- grade-suggest --date 2026-10-30
#    预期：待评 2 —— 58321476（三维全缺）、14785209（缺竞争度+复购）

npm run gwd -- list --date 2026-10-30        # 复查清单

# 4) 勾选门（含幂等）
npm run gwd -- select 78412563 48219753 --date 2026-10-30 --note "洁面仪评价数据好，先测；地垫等调研后再看"
npm run gwd -- select 78412563 --date 2026-10-30
#    预期：第二遍显示「已勾选过（幂等跳过）」

# 5) 深度调研（有 key）
npm run gwd -- research 78412563 --file test-data/01-normal/research-positive.txt
#    预期：舆情 positive + 好评点/风险/素材点；不带 --file 可回看摘要
#    对比：research-risky.txt 含「医用级」——摘要 risks 应含医疗宣称风险
#    幂等：同品再 research（不带 --force）→ 报「已有一份调研摘要」
npm run gwd -- research 78412563 --file test-data/01-normal/research-risky.txt --force

# 6) 内容工坊（双平台草稿）
npm run gwd -- content-gen --date 2026-10-30
#    无 key 预期：生成 0，需人工 4（2 品 × 2 平台 needs_manual）
#    有 key 预期：生成 4，且第 5 步的调研摘要被自动注入该品内容生成

npm run gwd -- contents --date 2026-10-30

# 7) 门③ 确认（--yes 为脚本路径；真实使用逐项交互）
npm run gwd -- confirm 78412563 xiaohongshu --date 2026-10-30 --yes --note "卖点已对商品页核对"
npm run gwd -- confirm 78412563 douyin --date 2026-10-30 --yes
#    再 confirm → 「已确认过（幂等拦截）」
#    无 key 时 confirm needs_manual 草稿 → 「需人工撰写/重新生成」（硬拦截）

# 8) 弃用演示（48219753 抖音版弃用，决策流水留痕）
npm run gwd -- discard 48219753 douyin --date 2026-10-30 --note "抖音节奏不合适，留小红书"

# 9) 发布队列（幂等）
npm run gwd -- publish-sync --date 2026-10-30     # 预期：新入队 2（78412563 双平台）
npm run gwd -- publish-sync --date 2026-10-30     # 预期：已有跳过 2
npm run gwd -- publish-list --date 2026-10-30
#    预期：待发布 2，建议时段 —— 小红书 12:00/18:00/21:00；抖音 12:00/18:00/22:00

# 10) 人工发布后回填（幂等）
npm run gwd -- published 78412563 xiaohongshu --date 2026-10-30 --url https://www.xiaohongshu.com/explore/accept00000000000001 --ai-labeled
#    再回填一次 → 「发布记录已回填过（幂等拒绝）」
npm run gwd -- publish-list --date 2026-10-30     # 已发布 1（AI 标注 已标注）
```

### 2.1 normal 数据打分明细（RULE_V1 手算口径，verify 已断言）

| 商品 ID | 总分 | 分级 | 门槛 | 设计点 |
|---|---|---|---|---|
| 35692147 | 98 | 强推 | ✅ | 榜首（修正行生效后的数值） |
| 63941758 | 88 | 强推 | ✅ | ￥ 前缀 / 千分位 / 「涨」别名 |
| 78412563 | 86 | 强推 | ✅ | |
| 48219753 | 83 | 强推 | ✅ | 环比留空 → flag「环比缺失按持平」，需求按 15 分 |
| 90213547 | 80 | 强推 | ✅ | 分级上临界 |
| 61587429 | 79 | 可测 | ✅ | 上临界之下 1 分 |
| 51748392 | 77 | 可测 | ✅ | 「↑」别名 |
| 36985214 | 70 | 可测 | ✅ | 复购档位 1（最低档 2 分） |
| 38574129 | 60 | 可测 | ✅ | **可测下临界**（内容 2 档 + 竞争 2 档） |
| 50248613 | 59 | 放弃 | ✅ | 放弃上临界 |
| 71548936 | 56 | 放弃 | ✅ | 环比下降（销量 90 → 需求兜底 5 分） |
| 40875962 | 90 | 强推 | ❌ 类目 | 类目禁售但打分独立（非直觉行为，见 §7.3） |
| 67841259 | 68 | 可测 | ❌ 履约 | 履约含「预售」 |
| 34125876 | 83 | 强推 | ❌ 佣金 | 佣金 15% 不大于 15（严格大于） |
| 76543198 | 71 | 可测 | ❌ 好评 | 好评 82 < 85 |
| 95124738 | 71 | 可测 | ❌ 品退 | 品退 13 > 10 + 供应链降档 flag |
| 21983475 | 74 | 可测 | ❌ 体验 | 体验分 68 < 70 |
| 58321476 | 55 | 待评 | ✅ | 三维全缺 → 不入榜，等 grade-suggest |
| 14785209 | 58 | 待评 | ✅ | 缺竞争度+复购 |

---

## 3. 场景 B：边界数据（02-boundary，独立日期 2026-11-01/02/03）

### 3.1 门槛与打分临界（candidates-boundary.csv，15 行）

```powershell
npm run gwd -- import-candidates test-data/02-boundary/candidates-boundary.csv --date 2026-11-01
#    预期：15 行全部有效
npm run gwd -- daily-scan --date 2026-11-01
```

| ID | 边界点 | 门槛 | 总分 | 分级 | 备注 |
|---|---|---|---|---|---|
| 55010001 | 佣金 15.00 | ❌ | 65 | 可测 | 严格大于：15.00 不够格 |
| 55010002 | 佣金 15.01 | ✅ | 65 | 可测 | 打分档仍是 10 分（15~30 档） |
| 55010003 | 好评 85 | ✅ | 65 | 可测 | ≥ 恰好过；供应链 6 分档 |
| 55010004 | 好评 84.99 | ❌ | 62 | 可测 | 供应链同步跌至 3 分 |
| 55010005 | 品退 10 | ✅ | 70 | 可测 | ≤ 恰好过，不降档 |
| 55010006 | 品退 10.01 | ❌ | 67 | 可测 | 供应链降档 3 分 + flag「品退率高供应链降档」 |
| 55010007 | 体验分 70 | ✅ | 65 | 可测 | |
| 55010008 | 体验分 69.9 | ❌ | 65 | 可测 | |
| 55010009 | 价格 19.9 | ✅ | 70 | 可测 | 价格带满分档 10 分 |
| 55010010 | 价格 19.89 | ✅ | 65 | 可测 | 落兜底档 5 分 |
| 55010011 | 价格 0 + 销量 0 | ✅ | 55 | 放弃 | 价格不设门槛；需求兜底 5 分 |
| 55010012 | 价格 999999 + 销量 9,999,999 上升 | ✅ | 70 | 可测 | 价格兜底 5 分；需求满分 20 |
| 55010013 | 主观 0/6（越界） | ✅ | 52 | 待评 | 导入时 round 越界 → null，不参与排序 |
| 55010014 | 主观 1/5（端点） | ✅ | 74 | 可测 | 内容 3 + 竞争 15 + 复购 10 |
| 55010015 | 销量 1000 + 上升 | ✅ | 75 | 可测 | 需求 20 满分档（对比 55010009 的 1000 持平=15 分） |

### 3.2 特殊字符 CSV（candidates-edge-text.csv）

```powershell
npm run gwd -- import-candidates test-data/02-boundary/candidates-edge-text.csv --date 2026-11-02
#    预期：3 行全部有效（超长标题 123 字、🐱 emoji、引号/逗号/换行全部按 RFC 转义正确解析）
#    后续 content-gen 该品时，123 字标题会在进 prompt 前被截断到 120 字并加「…[截断]」标记
```

### 3.3 混合表头（candidates-header-mixed.csv）

```powershell
npm run gwd -- import-candidates test-data/02-boundary/candidates-header-mixed.csv --date 2026-11-03
#    预期：中英文表头别名混排，1 行有效（55020004）
```

### 3.4 文本长度边界（research / note）

| 文件 | 用法 | 预期 |
|---|---|---|
| `research-49.txt` | `research <id> --file` | **报错**「原文太短（49 字符，至少 50）」——该检查先于 LLM，无 key 也能测 |
| `research-50.txt` | 同上 | 恰好过下限；有 key 正常生成，无 key 报「未配置 OPENAI_API_KEY」 |
| `research-8000.txt` | 同上 | 8000 字不截断，正常生成 |
| `research-8001.txt` | 同上 | 截断到 8000，输出带「（原文超长已截断存档）」 |
| `research-nul.txt` | 同上 | 文件含 NUL 字符（\x00），读取时被剥离，剥后 64 字 ≥ 50 照常处理 |
| `note-500.txt` | `confirm/discard --note` | 500 字恰好不截断，落库长度 500 |
| `note-510.txt` | 同上 | 截断为 495 + 「…[截断]」，落库长度 500 |

PowerShell 传文件备注：

```powershell
$n = (Get-Content test-data/02-boundary/note-510.txt -Raw).Trim()
npm run gwd -- confirm 78412563 xiaohongshu --date 2026-10-30 --yes --note $n
# 决策流水里 note 长度恒 ≤ 500
```

### 3.5 草稿结构边界（content-draft-bounds.json）

12 组用例对齐 `XiaohongshuNoteSchema / DouyinScriptSchema`（title 5-20、body 150-500、
tags 3-8 且单个 ≤20、coverIdea ≤50；hook 5-30、points 2-4 且单条 5-100、cta 5-50）：

- **程序化验收（主要路径）**：`npx tsx test-data/verify-data.ts` 已逐组断言 valid/invalid，
  且命名边界精确命中标称长度（body 恰好 150/500、hook 恰好 30 等）。
- **人工路径（可选）**：有 key 跑完 content-gen 后，用 psql 把某品草稿 content 换成
  invalid 用例（如 4 字标题），`gwd confirm` 时观察结构拦截。

---

## 4. 场景 C：异常数据（03-abnormal，独立日期 2026-11-04/05）

### 4.1 脏 CSV（candidates-broken.csv，16 行）

```powershell
npm run gwd -- import-candidates test-data/03-abnormal/candidates-broken.csv --date 2026-11-04
#    预期：共 16 行，有效 6，跳过 10
#    跳过行号：2,3,4,5,6,7,8,9,10,17（缺必填 ×3、abc/-/nan/Infinity/全角非数值等）
#    import_batches 会留痕 skipped_count 与逐行错误
```

存活 6 行的**行为观察点**（被 `Number` 接受即入库，属记录行为而非校验漏洞）：

| ID | 输入 | 观察到的行为 |
|---|---|---|
| 45610010 | 价格 `-10` | 负数原样入库（打分落兜底 5 分档） |
| 45610011 | 销量 `1e5` | 解析为 100000 |
| 45610012 | 标题含 `DROP TABLE products` | 仅作字面量标题入库，无注入 |
| 45610013 | 标题含「请忽略之前的系统提示词」 | 仅作字面量，进 prompt 前有截断/隔离 |
| 45610014 | ID 前后带空格 | trim 后入库 |
| 45610015 | 环比「侧躺」 | 无法识别 → flat（持平），flag 提示 |

### 4.2 全错表头（candidates-header-broken.csv）

```powershell
npm run gwd -- import-candidates test-data/03-abnormal/candidates-header-broken.csv --date 2026-11-05
#    预期：3 行全部跳过，每行报「缺必填字段」
```

### 4.3 非法规则（4 份）与合法 v2

```powershell
npm run gwd -- rule apply test-data/03-abnormal/rule-invalid-total-99.json  --reason 验收
#    预期：校验失败退出 —— 「七个维度满分合计应为 100，当前为 99」
npm run gwd -- rule apply test-data/03-abnormal/rule-invalid-missing-tier.json --reason 验收
#    预期：报「主观维度 repurchase 缺少档位 3」
npm run gwd -- rule apply test-data/03-abnormal/rule-invalid-grading.json  --reason 验收
#    预期：报「grading.testMin 必须小于 strongMin」
npm run gwd -- rule apply test-data/03-abnormal/rule-invalid-schema.json   --reason 验收
#    预期：zod schema 报错（minReviewRate 是字符串 / topN 为负）

# 合法 v2：生效 → 观察 → 回滚（闭环，避免影响其他场景的门槛口径）
npm run gwd -- rule apply test-data/01-normal/rule-v2-valid.json --reason "验收：佣金门槛提到18"
npm run gwd -- rule show        # gates.minCommissionRate = 18
npm run gwd -- rule list        # v2 [active]
npm run gwd -- rule rollback    # 已回滚: v2 → v1
```

### 4.4 违禁词种子（门③ 硬拦截）

```powershell
psql "$env:DATABASE_URL" -f test-data/03-abnormal/seed-banned-draft.sql   # 幂等可重跑
npm run gwd -- contents --date 2026-10-30
#    预期：77030001 拖把布两条草稿均带 ⚠ 词表命中
#    小红书命中 4 词：最低价、销量第一、第一名、100%（「销量第一名」一词双中，按词表顺序）
npm run gwd -- confirm 77030001 xiaohongshu --date 2026-10-30 --yes
#    预期：退出非 0 —— 词表命中（硬拦截），确认前必须改写
#    有 key 时：content-gen --force --date 2026-10-30 → 修订循环重新生成
```

### 4.5 注入与超长调研（有 key）

```powershell
npm run gwd -- research 78412563 --file test-data/03-abnormal/research-injection.txt --force
#    预期：原文含「忽略之前所有指令」与 ``` 代码围栏 —— 摘要照常按买家评论内容归纳，
#    注入指令不改变行为（原文只是数据；摘要经 schema 兜底校验后落库）
npm run gwd -- research 78412563 --file test-data/03-abnormal/research-flood.txt --force
#    预期：20000 字截断到 8000 存档，输出「（原文超长已截断存档）」
```

---

## 5. 场景 D：组合数据（04-combined，10-28 / 10-29 + 5 份种子）

### 5.1 连续两日演化

```powershell
npm run gwd -- import-candidates test-data/04-combined/candidates-day1.csv --date 2026-10-28
npm run gwd -- daily-scan --date 2026-10-28
#    day1 预期：12 品，入榜 10（40875962 类目禁售淘汰、58321476 三维缺待评）
#    top5：35692147(98) → 42968573(88) → 78412563(86) → 56127483(81) → 90213547(80)

npm run gwd -- import-candidates test-data/04-combined/candidates-day2.csv --date 2026-10-29
npm run gwd -- daily-scan --date 2026-10-29
#    day2 预期：12 品，入榜 11（40875962 类目禁售再次淘汰；无待评品）—— 关键演化：
#    · 58321476 补齐三维（4/3/4）→ 85 分强推，从待评直接冲进 top5
#    · 90213547 1500↑→1400↓ → 80→75 分，跌出 top5（需求 20→15）
#    · 消失 2：33051742、88412536；新增 2：95284617(88 强推)、72845936(83 强推，第 6 名)
#    · 修正行：56127483 好评 93→94、价格 45→49
#    top5：35692147(98) → 42968573(88) → 95284617(88) → 78412563(86) → 58321476(85)
```

### 5.2 种子（psql 执行，全部幂等可重跑；与场景 A 的活链路品不相交）

> **执行顺序有硬约束：先跑完 §5.1 的 CSV 链路（两日 import + daily-scan），再执行种子。**
> 种子会在 10-28 落 phase='selected' 的 run，此后 `daily-scan --date 2026-10-28` 会被
> 「该日已有勾选清单」守卫正确拒绝（设计行为，防止覆盖已勾选的决策）。
> 种子与 day1/day2 CSV 的同日同品快照值完全一致（如 35692147@10-28=8600/97%、
> @10-29=9400/98%；38574129@10-28=800），快照幂等键都成立——不成立的只是扫描顺序。

| 种子 | 验收点 |
|---|---|
| `seed-full-chain.sql` | `publish-list --date 2026-10-28`：小红书 1 条**已发布**（12:05 回填、AI 已标注、带链接）+ 抖音 1 条 **pending 且超 24h**（⚠ 超时警示）；`research 35692147` 可回看预置摘要；13 张表 FK 全对上、时间链 09:00→12:05 严格递增 |
| `seed-duplicate-drafts.sql` | `contents --date 2026-10-29`：66330099 草稿带 ⚠「与近期草稿相似 0.78」（跨品同题：66018877@10-28 标题 X vs 66330099@10-29 标题 Y，Jaccard 0.7778 手算与代码一致）；`publish-list --date 2026-10-29` 该存量 pending **不展示**（草稿非 confirmed，防误发布） |
| `seed-discard-regen.sql` | 按文件头 5 步走：`publish-list --date 2026-10-28`（pending 不展示）→ `content-gen --force --date 2026-10-28`（draft_id 不变重做；同品会补出 douyin 草稿）→ `confirm 38574129 xiaohongshu --date 2026-10-28 --yes` → `publish-sync --date 2026-10-28`（skipped 幂等，不产生第二行）→ `published 38574129 xiaohongshu --date 2026-10-28 --url ...`（回填指向最新确认版） |
| `seed-versions.sql` | `rule list`：v1 [active] + v2 [rolled_back]（版本链含「曾回滚」终态） |
| `seed-banned-draft.sql` | 见 §4.4（批次 2026-10-30） |

### 5.3 黑名单（无 CLI，SQL 置位）

> **前置约束：须在场景 A 的 `select`（10-30 转 phase='selected'）之前执行**——
> daily-scan 对已勾选日期拒绝重扫（设计守卫）。若 10-30 已 selected，
> 先把 run 置回再扫（或直接换一个场景 B 的空闲日期验证）：

```powershell
psql "$env:DATABASE_URL" -c "update products set blacklisted = true where external_id = '50248613';"
# 已 selected 时先复位（只影响本验收库；select 之后 phase 不会被业务改回）：
psql "$env:DATABASE_URL" -c "update daily_runs set phase = 'submitted' where batch_date = '2026-10-30' and phase = 'selected';"
npm run gwd -- daily-scan --date 2026-10-30
#    预期：黑名单 1（50248613 被剔除，入榜 10）；置回 false 可复原
```

---

## 6. API 验收（4 端点）

```powershell
npm run api        # 默认 http://127.0.0.1:8787；未配 GWD_API_TOKEN 时本机免鉴权
```

| 端点 | 用法 | 预期 |
|---|---|---|
| `GET /api/health` | `Invoke-RestMethod http://127.0.0.1:8787/api/health` | `{ok:true}`（免鉴权） |
| `GET /api/daily-list?date=2026-10-30` | 同上带 query | 19 品清单（ranked 11）；无清单日期 → 404「先跑 daily-scan」 |
| `GET /api/rules` | 同上 | v1 全量配置（对照 `01-normal/api-rules-expected.json`）；无 active → 404 |
| `POST /api/select` | 见下 | 正常用例对照 `01-normal/api-select-normal.json`（4 组） |

```powershell
# 正常勾选（等价 CLI select）
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/select -Method Post -ContentType 'application/json' `
  -Body '{"externalIds":["35692147","63941758"],"note":"高佣高好评，优先测洗脸巾"}'
#   预期 200，selected 含两品
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/select -Method Post -ContentType 'application/json' `
  -Body '{"externalIds":["35692147"]}'
#   预期 200，alreadySelected（幂等）
```

异常用例对照 `03-abnormal/api-abnormal.json`（18 组），关键预期：

| 用例 | 预期 |
|---|---|
| `externalIds: []` / body 缺失 | 400「externalIds 不能为空」 |
| 不存在的 ID / 1000 个假 ID 洪水 | 409「不在候选清单」 |
| 从未 scan 的日期 / 非法日期 `2026-13-45` | 409「没有候选清单」 |
| 配置 `GWD_API_TOKEN` 后不带/错 token | 401「无效 API token」；带对 → 200 |
| `published --url ""` | 报「笔记链接不能为空」 |
| `published --url "javascript:alert(1)"` | 报「须以 http:// 或 https:// 开头」（XSS 防线） |
| `published --at 2026-13-45T...` | 报「发布时间格式无效」 |
| 同一条 pending 重复回填 | 第二次「发布记录已回填过（幂等拒绝）」 |
| `confirm` 已确认过的草稿 | 「已确认过（幂等拦截）」 |
| `discard` 已弃用的草稿 | 「已废弃（幂等拦截）」 |
| `research GHOST-404` | 「没有找到商品」 |
| 对 `phase='expired'` 历史清单 select | 「已过期」（可用 SQL 置位 daily_runs.phase 后测） |

---

## 7. 已知行为与设计说明（验收前必读）

1. **CSV 缺必填字段 → 整行跳过是设计行为**。7 个必填字段
   （external_id/title/price/commission_rate/sales_30d/review_rate/merchant_score）
   缺任一行即弃，import 统计与 `import_batches` 留痕。
   因此**「好评率缺失 → 门槛 unknown」在 CSV 路径不可达**，只能 DB 直插验证：

   ```powershell
   psql "$env:DATABASE_URL" -c "update product_snapshots set review_rate = null where batch_date = '2026-10-30' and product_id = (select id from products where external_id = '51748392');"
   npm run gwd -- daily-scan --date 2026-10-30
   #   预期：51748392 门槛 review_rate = unknown（不算 fail，gatePassed 仍 true），
   #   flags 含「数据缺失:好评率」，供应链 0 分 → 总分 77→71，仍在榜（这是门槛语义：缺失≠淘汰）
   ```

2. **佣金门槛严格大于**：15.00 fail / 15.01 pass；而打分档是另一张表（≥15 得 10 分、≥20 得 15 分），门槛与打分互不影响。
3. **grade 与 gatePassed 独立**：40875962 类目禁售 → 门槛 fail 不入榜，但打分/分级照常 90 分强推。排序资格 = gatePassed && complete。
4. **topN=5 截断**：只给 top5 生成 LLM 理由，但**打分记录全量落库**（score_records）。
5. **黑名单没有 CLI**，只能 SQL 置位 `products.blacklisted`（见 §5.3）。
6. **published 回填仅一次**：链接/时间填错属人工修正场景，系统不做覆盖。
7. **需求档位**：1000+上升=20；1000（无上升）=15；500-999=15；100-499=10；0-99=5。`requireUp` 只作用在 1000 档。
8. **供应链档位**：好评 ≥95→10、85-94.6、<85→3；品退率 >10 时降档至 3 并加 flag（原分 ≤3 不变）。
9. **草稿相似度**：字符二元组 Jaccard ≥ 0.7 记 duplicates 并触发修订（阈值 `DUPLICATE_SIMILARITY_THRESHOLD`）。
10. **发布时段表**：小红书 12:00 / 18:00 / 21:00，抖音 12:00 / 18:00 / 22:00（`suggestSlots` 展示、`nextPublishSlot` 定 planned_at）。
11. **`--db memory` 的跨命令失忆**：只有 pg 能跑跨命令链路；`gwd demo` 是内置内存全流程演示。
12. **daily-scan 汇总口径互斥**：入榜（门槛过 + 三维齐）、待评（门槛过 + 三维缺）、门槛淘汰三者不重叠，相加 = 打分数；`rankScored` 的"pending"语义是「不进排序」（含门槛淘汰），仅内部使用，展示层已区分。
13. **API 对 date 做格式硬校验**：非 `YYYY-MM-DD`（含非真实日历日如 `2026-02-31`）→ 400「date 格式无效」；合法格式无清单 → 404「先跑 daily-scan」。

---

## 8. 验收结果速查（全部通过 = 验收完成）

- [ ] `npx tsx test-data/verify-data.ts` → 216 项通过 0 失败
- [ ] `npm run gwd -- demo` 全流程跑通（内存模式）
- [ ] 场景 A：19 品入榜 11 / top5 顺序 / 六门槛各命中一次 / 幂等点 4 处（import、select、confirm、published）
- [ ] 场景 B：15 行边界逐行符合 §3.1 表；49/50、8000/8001、note 500/510 全部按预期
- [ ] 场景 C：broken 6 有效 10 跳行号 2,3,4,5,6,7,8,9,10,17；4 份非法规则全部被拒；违禁词硬拦截
- [ ] 场景 D：day1→day2 延续 10 / 消失 2 / 新增 2 / 待评补齐入榜；5 份种子验收点全过
- [ ] API：4 端点正常 + 18 个异常用例全部按预期状态码/文案拒绝
