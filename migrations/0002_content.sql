-- 0002_content.sql — 模块② 内容工坊（B1 首项：双平台草稿生成）
-- 对应《AI带货工作台-场景拆解》1.4 生成-确认链与 2.1 #12 内容确认门（门③ 未建，status 预留）。
-- 语义：
--   - 操作表（非 append-only 审计表）：status 随门③ 推进可更新；决策审计在 decisions 表，不在此重复
--   - 幂等键 (product_id, platform)：同一品同平台只留最新草稿（重跑覆盖语义，与快照 upsert 一致）
--   - banned_hits：词表硬检查命中记录；「带命中词不得进 confirmed」的硬拦截在门③（下一项）生效

create table if not exists content_drafts (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references daily_runs(id),
  batch_date  date not null,
  product_id  uuid not null references products(id),
  platform    text not null check (platform in ('xiaohongshu','douyin')),
  status      text not null check (status in ('draft','needs_manual','confirmed','discarded')),
  content     jsonb,
  banned_hits jsonb not null default '[]'::jsonb,
  note        text,
  source      text not null check (source in ('llm','manual')),
  created_at  timestamptz not null default now(),
  unique (product_id, platform)
);

create index if not exists idx_content_drafts_date on content_drafts(batch_date);
