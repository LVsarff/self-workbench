-- 0004_publish_ledger.sql — 模块③ B2：待发布队列 + 发布台账
-- 对应《场景拆解》门④（发布动作永远人工，平台风控红线）：本表只记录
-- 「什么内容、何时建议发布、是否已发布、链接是什么」，不做任何代发。
-- 语义：
--   - 操作表（非 append-only 审计表）：status pending → published 随人工回填更新；
--     合规审计在 content_decisions（门③ 5 项清单已留痕），不在此重复
--   - 幂等键 draft_id：一条草稿（品+平台唯一行）只一条发布记录；
--     草稿被 discard 重做后 id 不变，pending 行自动指向最新确认版
--   - ai_labeled：回填时如实记录是否勾了平台「AI 生成」标注（与门③ 第 5 项呼应）
--   - planned_at：入队时按平台流量时段表算的建议时间（上海时区，展示用，非硬约束）

create table if not exists publish_records (
  id           uuid primary key default gen_random_uuid(),
  draft_id     uuid not null references content_drafts(id),
  run_id       uuid not null references daily_runs(id),
  batch_date   date not null,
  product_id   uuid not null references products(id),
  platform     text not null check (platform in ('xiaohongshu','douyin')),
  status       text not null check (status in ('pending','published')) default 'pending',
  planned_at   timestamptz,
  published_at timestamptz,
  url          text,
  ai_labeled   boolean,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (draft_id)
);

create index if not exists idx_publish_records_date on publish_records(batch_date, status);
