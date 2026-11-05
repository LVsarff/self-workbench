-- seed-full-chain.sql — 全链路种子：一个品从快照到已发布台账的完整闭环
-- 前置：已执行 gwd migrate（表结构存在）；可重复执行（幂等）
--
-- 覆盖链路（FK 全对上、时间严格递增）：
--   products → product_snapshots(两天) → daily_runs(selected/done)
--   → score_records(98 强推) → reasons(llm) → decisions(selected)
--   → content_drafts(双平台 confirmed) → content_decisions(5 项清单全过)
--   → publish_records(小红书已发布+AI标注 / 抖音 pending 且超 24h 触发超时警示)
--   → product_research(舆情摘要)
--
-- 时间链：09:00 run 开始 → 09:02 完成 → 09:05 勾选 → 09:10 草稿 → 09:15 门③确认
--         → 09:16 入发布队列 → 12:05 实际发布（planned 12:00 时段表口径）
begin;

do $$
declare
  v_product uuid;
  v_run uuid;
  v_draft_xhs uuid;
  v_draft_dy uuid;
  v_cnt integer;
begin
  -- ① 商品身份
  insert into products (external_id, title, category, blacklisted)
  values ('35692147', '一次性洗脸巾（加大加厚抽取式）', '家居日用品', false)
  on conflict (external_id) do update set title = excluded.title
  returning id into v_product;

  -- ② 两天快照（销量/好评演化；unique(product_id, batch_date) 幂等）
  insert into product_snapshots (product_id, batch_date, title, category, price, commission_rate, sales_30d, mom_trend, review_rate, return_rate, merchant_score, fulfillment, content_friendliness, competition, repurchase)
  values
    (v_product, '2026-10-28', '一次性洗脸巾（加大加厚抽取式）', '家居日用品', 29.90, 32.00, 8600, 'up', 97.00, 1.00, 90.0, '现货', 5, 4, 5),
    (v_product, '2026-10-29', '一次性洗脸巾（加大加厚抽取式）', '家居日用品', 29.90, 32.00, 9400, 'up', 98.00, 1.00, 90.0, '现货', 5, 4, 5)
  on conflict (product_id, batch_date) do nothing;

  -- ③ 当日 run（phase=selected：已完成勾选；started_at < finished_at）
  select count(*) into v_cnt from daily_runs where batch_date = '2026-10-28' and phase = 'selected';
  if v_cnt = 0 then
    insert into daily_runs (id, batch_date, rule_version, phase, status, stats, started_at, finished_at)
    values (
      gen_random_uuid(), '2026-10-28', 1, 'selected', 'done',
      '{"snapshots":19,"blacklisted":0,"scored":19,"gateFailed":6,"ranked":11,"pending":2,"topN":5,"reasonSource":"llm","agent":"openai:gpt-4o-mini"}'::jsonb,
      '2026-10-28 09:00:00+08', '2026-10-28 09:02:30+08'
    );
  end if;
  select id into v_run from daily_runs where batch_date = '2026-10-28' and phase = 'selected' order by started_at limit 1;

  -- ④ 打分记录（七维合计 98 → 强推）
  insert into score_records (run_id, product_id, rule_version, gate_passed, gate_results, dimension_scores, total, complete, grade, flags)
  values (
    v_run, v_product, 1, true,
    '[{"code":"category","status":"pass"},{"code":"review_rate","status":"pass","detail":"97% >= 85%"},{"code":"return_rate","status":"pass","detail":"1% <= 10%"},{"code":"commission","status":"pass","detail":"32% > 15%"},{"code":"merchant_score","status":"pass","detail":"90 >= 70"},{"code":"fulfillment","status":"pass"}]'::jsonb,
    '{"commission":20,"demand":20,"contentFriendliness":15,"competition":13,"price":10,"supplyChain":10,"repurchase":10}'::jsonb,
    98, true, 'strong', '[]'::jsonb
  )
  on conflict (run_id, product_id) do nothing;

  -- ⑤ 推荐理由（LLM 来源）
  insert into reasons (run_id, product_id, text, cited_fields, source)
  values (
    v_run, v_product,
    '佣金率32%高居当日候选前列，近30天销量8600且环比上升，需求面旺盛；好评率97%、品退率仅1%，供应链稳；内容友好度5档，拍摄展示空间大；复购扩展5档（高频消耗品），与账号家居日用品人设高度契合。',
    '["commission_rate","sales_30d","mom_trend","review_rate","return_rate","repurchase"]'::jsonb,
    'llm'
  )
  on conflict (run_id, product_id) do nothing;

  -- ⑥ 勾选决策（append-only）
  insert into decisions (run_id, batch_date, product_id, action, decided_by, note, rule_version_at_decision, total_score, decided_at)
  values (v_run, '2026-10-28', v_product, 'selected', 'human', '高佣高好评，优先测洗脸巾', 1, 98, '2026-10-28 09:05:00+08')
  on conflict (run_id, product_id, action) do nothing;

  -- ⑦ 双平台草稿（门③ 已确认；幂等键 product_id+platform）
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, note, source, created_at)
  values (
    v_run, '2026-10-28', v_product, 'xiaohongshu', 'confirmed',
    '{"title":"洗脸巾这样选真的不踩坑","body":"把家里三条反复用的擦脸毛巾全换掉了，改用一次性的洗脸巾，说实话有点后悔没早点换。这款是加厚抽取式，抽一张能擦全脸加脖子，湿水不破不掉絮，擦完直接扔，不用惦记晾晒和异味。敏感肌用也没有刺痛感，植物纤维摸着柔软，卸妆的时候湿敷一下也很好用。单包一百二十抽，算下来一天几毛钱，比反复洗毛巾省事卫生。家里也开始用它擦台面水渍，一巾多用很方便。抽纸式设计比卷筒好取，放浴室一周没受潮。用完这个再看毛巾真的有点下不去手，卫生感受完全不一样。","tags":["洗脸巾","敏感肌友好","居家好物"],"coverIdea":"近景平铺：洗脸巾特写加水珠，突出厚度"}'::jsonb,
    '[]'::jsonb, 0, null, 'llm', '2026-10-28 09:10:00+08'
  )
  on conflict (product_id, platform) do update
    set status = 'confirmed', content = excluded.content, banned_hits = '[]'::jsonb
  returning id into v_draft_xhs;

  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, note, source, created_at)
  values (
    v_run, '2026-10-28', v_product, 'douyin', 'confirmed',
    '{"hook":"毛巾三个月不换有多脏你敢想吗","points":["一条毛巾用半年，细菌比抹布还多","换成一次性洗脸巾，擦完就扔不滋生","加厚款湿水不破，卸妆湿敷都能用"],"cta":"点击下方小车，囤两包试试"}'::jsonb,
    '[]'::jsonb, 0, null, 'llm', '2026-10-28 09:10:00+08'
  )
  on conflict (product_id, platform) do update
    set status = 'confirmed', content = excluded.content, banned_hits = '[]'::jsonb
  returning id into v_draft_dy;

  -- 幂等重跑时 returning 拿不到（do update 也会返回，但上面 on conflict do update 有 returning，ok）；
  -- 保险：按唯一键回查
  select id into v_draft_xhs from content_drafts where product_id = v_product and platform = 'xiaohongshu';
  select id into v_draft_dy from content_drafts where product_id = v_product and platform = 'douyin';

  -- ⑧ 门③ 决策流水（5 项清单逐项全过，append-only）
  if not exists (select 1 from content_decisions where draft_id = v_draft_xhs) then
    insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by, decided_at)
    values (
      v_draft_xhs, v_run, '2026-10-28', v_product, 'xiaohongshu', 'confirmed',
      '[{"item":"卖点属实：文中价格/销量/好评率与商品页一致，无编造","pass":true},{"item":"无极限词、无夸大宣传（词表命中与审查提示均已处理）","pass":true},{"item":"符合账号人设：语气与内容方向不越界","pass":true},{"item":"钩子有效：标题/前 3 秒能留住目标人群","pass":true},{"item":"发布时将勾选平台「AI 生成」标注","pass":true}]'::jsonb,
      '人工逐项核对商品页后确认', 'human', '2026-10-28 09:15:00+08'
    );
  end if;
  if not exists (select 1 from content_decisions where draft_id = v_draft_dy) then
    insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by, decided_at)
    values (
      v_draft_dy, v_run, '2026-10-28', v_product, 'douyin', 'confirmed',
      '[{"item":"卖点属实：文中价格/销量/好评率与商品页一致，无编造","pass":true},{"item":"无极限词、无夸大宣传（词表命中与审查提示均已处理）","pass":true},{"item":"符合账号人设：语气与内容方向不越界","pass":true},{"item":"钩子有效：标题/前 3 秒能留住目标人群","pass":true},{"item":"发布时将勾选平台「AI 生成」标注","pass":true}]'::jsonb,
      null, 'human', '2026-10-28 09:15:00+08'
    );
  end if;

  -- ⑨ 发布台账
  --   小红书：已发布（planned 12:00 是平台时段表口径；published_at 在其后，url 已回填，AI 标注已勾）
  insert into publish_records (draft_id, run_id, batch_date, product_id, platform, status, planned_at, published_at, url, ai_labeled, created_at, updated_at)
  values (
    v_draft_xhs, v_run, '2026-10-28', v_product, 'xiaohongshu', 'published',
    '2026-10-28 12:00:00+08', '2026-10-28 12:05:00+08',
    'https://www.xiaohongshu.com/explore/65f1a2b3000000001234abcd', true,
    '2026-10-28 09:16:00+08', '2026-10-28 12:05:00+08'
  )
  on conflict (draft_id) do nothing;

  --   抖音：pending 且入队超 24h（created_at 用相对时间，publish-list 应出现「超 24h 未发布」警示）
  insert into publish_records (draft_id, run_id, batch_date, product_id, platform, status, planned_at, created_at)
  values (
    v_draft_dy, v_run, '2026-10-28', v_product, 'douyin', 'pending',
    '2026-10-29 22:00:00+08', now() - interval '25 hours'
  )
  on conflict (draft_id) do nothing;

  -- ⑩ 深度调研摘要（内容工坊的参考输入）
  insert into product_research (product_id, source_text, summary, run_id)
  values (
    v_product,
    '买家A：抽一张能擦全脸，厚实不掉絮，用完直接扔，比反复用的毛巾卫生多了。买家B：敏感肌友好，湿水不破，卸妆的时候当洗脸巾也行，已经回购第三次。买家C：宝妈党强推，给宝宝擦口水擦小手都合适，一次一张不怕交叉污染。买家D：比之前用的某牌子大一圈，性价比很高，包装打开也没有异味。买家E：抽纸式设计比卷筒的好取，放浴室一周也没受潮。',
    '{"sentiment":"positive","highlights":["厚实不掉絮，湿水不破","敏感肌可用，回购意愿高","一次一张卫生，宝妈场景友好"],"risks":["个别批次有轻微异味，收货先晾一晾"],"materialPoints":["一次一张的卫生卖点","宝妈给宝宝擦口水场景","办公室和宿舍囤货多场景"]}'::jsonb,
    v_run
  )
  on conflict (product_id) do nothing;
end $$;

commit;
