-- 0005 · 深度调研摘要（模块① V2 收官）
-- 每品一份：人工抄录的评论区/商家资质原文 + LLM 结构化摘要（舆情/风险/素材点）。
-- 摘要是内容工坊的参考输入，不是事实表——人终判（地图 ① 深度调研摘要点）。
-- 幂等键 product_id（一品一份；重做走 --force 覆盖，原文与摘要同换）。
create table if not exists product_research (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id),
  -- 人工抄录原文（截断后存档：上限见 pipeline/research.ts；审计源头）
  source_text text not null,
  -- 结构化摘要 { sentiment, highlights[], risks[], material_points[] }
  summary     jsonb not null,
  -- 关联调用审计（llm_call_logs.run_id；品可以是历史品，无当日 run 时为 null）
  run_id      uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (product_id)
);

create index if not exists idx_product_research_product on product_research(product_id);
