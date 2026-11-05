-- seed-banned-draft.sql — 违禁词草稿种子（测门③ 硬拦截 + content-gen 修订循环）
-- 前置：已执行 gwd migrate；可重复执行（幂等 upsert）
-- 预期断言（test-data/verify-data.ts 会用 checkBannedWords 复核）：
--   小红书草稿命中 ['最低价','销量第一','第一名','100%']（「销量第一名」一词双中，按词表顺序）
--   抖音草稿命中 ['全网第一']
begin;

do $$
declare
  v_product uuid;
  v_run uuid;
begin
  insert into products (external_id, title, category, blacklisted)
  values ('77030001', '拖把布替换装（加厚吸水）', '清洁工具', false)
  on conflict (external_id) do update set title = excluded.title
  returning id into v_product;

  insert into product_snapshots (product_id, batch_date, title, category, price, commission_rate, sales_30d, mom_trend, review_rate, return_rate, merchant_score, fulfillment, content_friendliness, competition, repurchase)
  values (v_product, '2026-10-30', '拖把布替换装（加厚吸水）', '清洁工具', 25.90, 24, 3200, 'up', 95, 2, 86, '现货', 5, 3, 4)
  on conflict (product_id, batch_date) do nothing;

  select id into v_run from daily_runs where batch_date = '2026-10-30' limit 1;
  if v_run is null then
    insert into daily_runs (id, batch_date, rule_version, phase, status, started_at, finished_at)
    values (gen_random_uuid(), '2026-10-30', 1, 'submitted', 'done', now() - interval '2 hours', now() - interval '1 hour')
    returning id into v_run;
  end if;

  -- 小红书草稿：结构合法但词表命中（门③ 硬拦截，需 content-gen --force 修词重生成）
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, source, created_at)
  values (
    v_run, '2026-10-30', v_product, 'xiaohongshu', 'draft',
    '{"title":"全网最低价！这款拖把布太好用了","body":"用了一个月来说说真实感受，100%好评不是吹的，这款拖把布吸水快不留水痕，拖完地秒干，家里有猫也不怕脚印。厚度比超市随手买的厚一倍，机洗几次没有变形起球。干拖吸头发湿拖去油渍，一面顶两面用。地板是浅色瓷砖，最怕水渍残留，用它拖完对着灯光看也没有水痕。拖杆接口也不晃，换布的时候按一下卡扣就行，不用弯腰。评论区催返场的不少，看后台数据它还是同品类的销量第一名。这个价位能用这个程度，日常拖地轻松了不少，拖地这件事终于不头疼了。","tags":["居家清洁","拖把布","清洁好物"],"coverIdea":null}'::jsonb,
    '["最低价","销量第一","第一名","100%"]'::jsonb,
    0, 'llm', now() - interval '1 hour'
  )
  on conflict (product_id, platform) do update
    set status = 'draft', content = excluded.content, banned_hits = excluded.banned_hits, revision_count = 0;

  -- 抖音草稿：钩子命中违禁词
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, source, created_at)
  values (
    v_run, '2026-10-30', v_product, 'douyin', 'draft',
    '{"hook":"全网第一的拖把布来了别再拖了","points":["吸水速干，拖完不湿地板","加厚纤维，机洗不变形","一巾双面，干湿两用"],"cta":"点击下方小车试试"}'::jsonb,
    '["全网第一"]'::jsonb,
    0, 'llm', now() - interval '1 hour'
  )
  on conflict (product_id, platform) do update
    set status = 'draft', content = excluded.content, banned_hits = excluded.banned_hits, revision_count = 0;
end $$;

commit;
