-- seed-discard-regen.sql — 弃用重做链种子（draft_id 不变语义 + publish-sync 幂等 + 防误发布过滤）
-- 前置：已执行 gwd migrate；可重复执行（专属 run 用固定 started_at 标记复用）
-- 链路（品 38574129 免打孔浴室置物架，批次 2026-10-28）：
--   草稿 status='discarded'（人弃用：角度与人设不符），并留有一条旧版同步的 pending 发布记录。
-- 验收步骤（runbook 详述）：
--   1) gwd publish-list --date 2026-10-28 → 该 pending 不展示（草稿非 confirmed，防误发布）
--   2) gwd content-gen --force --date 2026-10-28 → 重新生成（draft_id 不变，覆盖 discarded；
--      注意：38574129 无 douyin 草稿，本次会同时补出 douyin 草稿，属预期行为）
--   3) gwd confirm 38574129 xiaohongshu --date 2026-10-28 --yes → 新版确认
--   4) gwd publish-sync --date 2026-10-28 → draft_id 已有记录 → skipped=1（幂等，不产生第二行）
--   5) gwd published 38574129 xiaohongshu --date 2026-10-28 --url <链接> → 回填指向最新确认版
-- 结构要点（getDailyList 是 inner join score_records + left join decisions(run_id 限定)）：
--   品要进清单且 selected=true，必须「最新 run 上同时有 score_records 和 selected 决策」——
--   因此本种子建一个专属 run（started_at 09:30+08，晚于本日其他种子 run 的 09:00+08，
--   保证 getLatestRun 确定性命中），并把三项全挂在它上面。
begin;

do $$
declare
  v_product uuid;
  v_run uuid;
  v_draft uuid;
  v_cnt integer;
begin
  insert into products (external_id, title, category, blacklisted)
  values ('38574129', '免打孔浴室置物架（太空铝加厚）', '浴室收纳', false)
  on conflict (external_id) do update set title = excluded.title
  returning id into v_product;

  insert into product_snapshots (product_id, batch_date, title, category, price, commission_rate, sales_30d, mom_trend, review_rate, return_rate, merchant_score, fulfillment, content_friendliness, competition, repurchase)
  values (v_product, '2026-10-28', '免打孔浴室置物架（太空铝加厚）', '浴室收纳', 49.00, 16.00, 800, 'flat', 88.00, 4.00, 84.0, '现货', 3, 3, 3)
  on conflict (product_id, batch_date) do nothing;

  -- 专属 run（固定时间戳既当「最新」保证，也当重复执行时的幂等标记）
  select count(*) into v_cnt from daily_runs where batch_date = '2026-10-28' and phase = 'selected' and started_at = '2026-10-28 09:30:00+08';
  if v_cnt = 0 then
    insert into daily_runs (id, batch_date, rule_version, phase, status, started_at, finished_at)
    values (gen_random_uuid(), '2026-10-28', 1, 'selected', 'done', '2026-10-28 09:30:00+08', '2026-10-28 09:32:00+08');
  end if;
  select id into v_run from daily_runs where batch_date = '2026-10-28' and phase = 'selected' and started_at = '2026-10-28 09:30:00+08' limit 1;

  -- 打分记录（getDailyList 的 inner join 要求：无 score_records 的品不进清单）
  -- 七维合计 75 → test 档：佣金16%→20 + 销量800→15 + 价格49→10 + 体验分84→6 + 内容3→8 + 竞争3→10 + 复购3→6
  insert into score_records (run_id, product_id, rule_version, gate_passed, gate_results, dimension_scores, total, complete, grade, flags)
  values (
    v_run, v_product, 1, true,
    '[{"code":"category","status":"pass"},{"code":"review_rate","status":"pass","detail":"88% >= 85%"},{"code":"return_rate","status":"pass","detail":"4% <= 10%"},{"code":"commission","status":"pass","detail":"16% > 15%"},{"code":"merchant_score","status":"pass","detail":"84 >= 70"},{"code":"fulfillment","status":"pass"}]'::jsonb,
    '{"commission":20,"demand":15,"price":10,"supplyChain":6,"contentFriendliness":8,"competition":10,"repurchase":6}'::jsonb,
    75, true, 'test', '[]'::jsonb
  )
  on conflict (run_id, product_id) do nothing;

  -- 勾选决策（content-gen 只处理当日已勾选的品；缺此行则 38574129 不进生成范围，--force 重做链不可达）
  insert into decisions (run_id, batch_date, product_id, action, decided_by, note, rule_version_at_decision, total_score, decided_at)
  values (v_run, '2026-10-28', v_product, 'selected', 'human', '弃用重做链路：保持勾选', 1, 75, '2026-10-28 09:33:00+08')
  on conflict (run_id, product_id, action) do nothing;

  -- 弃用草稿（revision_count=1：曾修订一轮仍未通过人审）
  insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, revision_count, note, source, created_at)
  values (
    v_run, '2026-10-28', v_product, 'xiaohongshu', 'discarded',
    '{"title":"浴室置物架别乱买了","body":"这款太空铝置物架用了半个月才敢来分享，免打孔上墙很牢固，承重比想象好，大瓶洗发水放上去也不晃。沥水层的设计让瓶底不积水，浴室清爽了很多。加厚太空铝不生锈，湿区用着放心。安装五分钟搞定，租房党也能用，搬家还能拆走。分层大小刚刚好，常用的洗护用品一字排开，取用顺手。浴室收纳一直是个头疼事，这款真的解决了我的痛点，预算五十以内的可以闭眼入，比塑料的质感好太多。","tags":["浴室收纳","免打孔","置物架"],"coverIdea":null}'::jsonb,
    '[]'::jsonb, 1, '角度与账号人设不符，弃用后 content-gen --force 重做', 'llm', '2026-10-28 09:35:00+08'
  )
  on conflict (product_id, platform) do update
    set status = 'discarded', note = excluded.note, revision_count = 1
  returning id into v_draft;

  select id into v_draft from content_drafts where product_id = v_product and platform = 'xiaohongshu';

  -- 弃用决策留痕（append-only）
  if not exists (select 1 from content_decisions where draft_id = v_draft and action = 'discarded') then
    insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by, decided_at)
    values (v_draft, v_run, '2026-10-28', v_product, 'xiaohongshu', 'discarded', null, '角度与账号人设不符', 'human', '2026-10-28 10:30:00+08');
  end if;

  -- 旧版同步出的存量 pending 记录（draft_id 与弃用草稿同一行 —— 验证幂等与过滤）
  insert into publish_records (draft_id, run_id, batch_date, product_id, platform, status, planned_at, created_at)
  values (
    v_draft, v_run, '2026-10-28', v_product, 'xiaohongshu', 'pending',
    '2026-10-28 18:00:00+08', now() - interval '20 hours'
  )
  on conflict (draft_id) do nothing;
end $$;

commit;
