-- 0003_content_gate.sql — B1 剩余：自检留痕 + 门③ 决策流水
-- 对应《场景拆解》2.1 #11（双层自检）与 2.2 门③（内容确认门，5 项清单）。

-- 草稿表补三列：
--   review         L2 LLM 审查结论（仅提示层：pass=null 表示未得出结论，不阻塞）
--   duplicates     历史去重命中（相似度超阈值的近期草稿）
--   revision_count 修订循环实际使用的轮数（预算 ≤2，见《单Agent最小方案》§3）
alter table content_drafts
  add column if not exists review jsonb,
  add column if not exists duplicates jsonb not null default '[]'::jsonb,
  add column if not exists revision_count integer not null default 0;

-- 门③ 决策流水（append-only，审计核心表，与选品 decisions 分表）：
--   5 项确认清单逐项留痕（checklist），发布合规责任在人，系统只记录"人确认过什么"。
create table if not exists content_decisions (
  id          uuid primary key default gen_random_uuid(),
  draft_id    uuid not null references content_drafts(id),
  run_id      uuid not null references daily_runs(id),
  batch_date  date not null,
  product_id  uuid not null references products(id),
  platform    text not null check (platform in ('xiaohongshu','douyin')),
  action      text not null check (action in ('confirmed','discarded')),
  checklist   jsonb,
  note        text,
  decided_by  text not null default 'human',
  decided_at  timestamptz not null default now()
);

create index if not exists idx_content_decisions_date on content_decisions(batch_date);
