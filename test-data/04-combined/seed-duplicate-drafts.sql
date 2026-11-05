-- seed-duplicate-drafts.sql — 跨品草稿去重种子（内容工坊 duplicates 命中展示 + 防误发布）
-- 前置：已执行 gwd migrate；可重复执行
-- 设计修正（验收发现）：content_drafts 有全局 UNIQUE(product_id, platform)，
--   「同品同平台跨日两条草稿」在真实约束下不可能共存（重做 = 同一行覆盖）。
--   原版种子的 day1 已确认草稿会被 day2 upsert 静默覆盖成一行，比对基准自毁。
--   真实系统中去重命中的实际形态是「跨品同题」：去重池横跨 14 天、全品。
-- 链路：day1(10-28) 品 66018877 保鲜袋 小红书已确认草稿（标题 X）
--       day2(10-29) 品 66330099 保鲜盒 小红书新草稿（标题 Y 与 X 仅差 1 字）→ duplicates 命中
--       + day2 已存在一条关联 Y 的 pending 发布记录（验证「草稿非 confirmed 时 pending 不展示」）
-- 相似度（字符二元组 Jaccard，阈值 0.7）：
--   X = "厨房保鲜就用它！7件套硅胶盖真方便"
--   Y = "厨房保鲜就用它！7件套硅胶盖真好用"
--   交集 bigram 14 / 并集 18 = 0.7779 ≥ 0.7 → 命中
--   （test-data/verify-data.ts 用 jaccardSimilarity 复核此值）
begin;

do $$
declare
  v_p1 uuid;
  v_p2 uuid;
  v_run1 uuid;
  v_run2 uuid;
  v_draft1 uuid;
  v_draft2 uuid;
  v_cnt integer;
begin
  -- day1 品：另一家店的硅胶保鲜盖（标题 X 的作者；跨品同题 = 不同卖家推同类品撞标题）
  insert into products (external_id, title, category, blacklisted)
  values ('66018877', '硅胶保鲜盖（7件套弹力款·加厚）', '厨房用品', false)
  on conflict (external_id) do update set title = excluded.title
  returning id into v_p1;

  -- day2 品：保鲜盒（标题 Y 的作者，与 day1 品不同 → 不撞 UNIQUE(product_id, platform)）
  insert into products (external_id, title, category, blacklisted)
  values ('66330099', '玻璃保鲜盒三件套（带密封盖）', '厨房用品', false)
  on conflict (external_id) do update set title = excluded.title
  returning id into v_p2;

  insert into product_snapshots (product_id, batch_date, title, category, price, commission_rate, sales_30d, mom_trend, review_rate, return_rate, merchant_score, fulfillment, content_friendliness, competition, repurchase)
  values
    (v_p1, '2026-10-28', '硅胶保鲜盖（7件套弹力款·加厚）', '厨房用品', 19.90, 22.00, 2100, 'up', 94.00, 2.00, 88.0, '现货', 4, 3, 4),
    (v_p2, '2026-10-29', '玻璃保鲜盒三件套（带密封盖）', '厨房用品', 39.90, 25.00, 1500, 'up', 93.00, 3.00, 86.0, '现货', 4, 3, 4)
  on conflict (product_id, batch_date) do nothing;

  -- day1 run
  select count(*) into v_cnt from daily_runs where batch_date = '2026-10-28' and status = 'done' and phase = 'submitted';
  if v_cnt = 0 then
    insert into daily_runs (id, batch_date, rule_version, phase, status, started_at, finished_at)
    values (gen_random_uuid(), '2026-10-28', 1, 'submitted', 'done', '2026-10-28 09:00:00+08', '2026-10-28 09:02:00+08');
  end if;
  select id into v_run1 from daily_runs where batch_date = '2026-10-28' and phase = 'submitted' order by started_at limit 1;

  -- day2 run
  select count(*) into v_cnt from daily_runs where batch_date = '2026-10-29' and status = 'done' and phase = 'submitted';
  if v_cnt = 0 then
    insert into daily_runs (id, batch_date, rule_version, phase, status, started_at, finished_at)
    values (gen_random_uuid(), '2026-10-29', 1, 'submitted', 'done', '2026-10-29 09:00:00+08', '2026-10-29 09:02:00+08');
  end if;
  select id into v_run2 from daily_runs where batch_date = '2026-10-29' and phase = 'submitted' order by started_at limit 1;

  -- day1 已确认草稿（去重比对的基准；标题 X）
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, source, created_at)
  values (
    v_run1, '2026-10-28', v_p1, 'xiaohongshu', 'confirmed',
    '{"title":"厨房保鲜就用它！7件套硅胶盖真方便","body":"剩菜剩饭直接扣一个盖，冰箱里再也不会串味。这套是七种尺寸的弹力硅胶盖，大小碗盘都能找到合适的那个，密封性很好，倒过来放也不渗水。耐高温可以进微波炉加热，用完水冲一下就干净，收纳起来就一小叠不占地方。买之前也对比过保鲜膜和保鲜袋，算下来这个可以反复用，长期更划算。家里冰箱现在整整齐齐，再也不会出现一层保鲜膜缠来缠去还缠歪的情况，需要保鲜的东西多的话很值得入一套。","tags":["厨房好物","保鲜盖","冰箱整理"],"coverIdea":null}'::jsonb,
    '[]'::jsonb, 0, 'llm', '2026-10-28 09:10:00+08'
  )
  on conflict (product_id, platform) do nothing
  returning id into v_draft1;

  select id into v_draft1 from content_drafts where product_id = v_p1 and platform = 'xiaohongshu';

  -- day1 门③ 留痕
  if not exists (select 1 from content_decisions where draft_id = v_draft1) then
    insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by, decided_at)
    values (
      v_draft1, v_run1, '2026-10-28', v_p1, 'xiaohongshu', 'confirmed',
      '[{"item":"卖点属实：文中价格/销量/好评率与商品页一致，无编造","pass":true},{"item":"无极限词、无夸大宣传（词表命中与审查提示均已处理）","pass":true},{"item":"符合账号人设：语气与内容方向不越界","pass":true},{"item":"钩子有效：标题/前 3 秒能留住目标人群","pass":true},{"item":"发布时将勾选平台「AI 生成」标注","pass":true}]'::jsonb,
      null, 'human', '2026-10-28 09:15:00+08'
    );
  end if;

  -- day2 新草稿（另一品、标题 Y 与 X 高度相似 → duplicates 命中；状态 draft 等门③ 终判）
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, duplicates, revision_count, review, source, created_at)
  values (
    v_run2, '2026-10-29', v_p2, 'xiaohongshu', 'draft',
    '{"title":"厨房保鲜就用它！7件套硅胶盖真好用","body":"七天尺寸的硅胶保鲜盖到货了，迫不及待跟大家分享。最大那个能扣住家里的大汤碗，最小的是调料碟尺寸，几乎覆盖了日常所有碗盘。弹性边缘抓得紧，倒扣不漏，冰箱里摞起来也稳。微波炉加热直接进，不用撕膜，比保鲜膜省事。用完清水一冲就干净，一叠收纳几乎不占空间。有了这套之后家里的保鲜膜消耗明显少了，算成本反而更省，冰箱也不再一层缠一层。需要频繁保鲜收纳的家庭，真心建议直接入一套。","tags":["厨房收纳","保鲜盖","冰箱整理"],"coverIdea":null}'::jsonb,
    '[]'::jsonb,
    '[{"externalId":"66018877","batchDate":"2026-10-28","title":"厨房保鲜就用它！7件套硅胶盖真方便","similarity":0.7778}]'::jsonb,
    1,
    '{"pass":null,"risks":[],"model":"scripted","skippedReason":"审查器未配置（演示种子）"}'::jsonb,
    'llm', '2026-10-29 09:10:00+08'
  )
  on conflict (product_id, platform) do nothing
  returning id into v_draft2;

  select id into v_draft2 from content_drafts where product_id = v_p2 and platform = 'xiaohongshu';

  -- day2 该草稿已有一条 pending 发布记录（旧版确认后同步的存量行）：
  -- 验证 publish-sync 幂等（draft_id 已存在 → skipped）与 publish-list 的草稿状态过滤
  insert into publish_records (draft_id, run_id, batch_date, product_id, platform, status, planned_at, created_at)
  values (
    v_draft2, v_run2, '2026-10-29', v_p2, 'xiaohongshu', 'pending',
    '2026-10-29 12:00:00+08', '2026-10-29 09:16:00+08'
  )
  on conflict (draft_id) do nothing;
end $$;

commit;
