-- seed-versions.sql — 规则版本链示例（对应「rule apply → 观察后 rollback」的终态）
-- 前置：已执行 gwd migrate；可重复执行
-- 状态语义：同一时刻只允许一个 active（部分唯一索引保证）；
--           v2 曾经 apply 生效，一周后人工 rollback → 状态 rolled_back
-- 验收：gwd rule list 应显示两行：v1 [active] / v2 [rolled_back]；
--       daily-scan 应按 v1 打分（正常 CSV 的 98/86/80 分预期均基于 v1）
begin;

insert into rule_versions (version, config, status, change_reason, approved_by, created_at)
values
  (
    1,
    '{"version":1,"gates":{"bannedCategoryKeywords":["食品","药品","医疗","保健","金融","生鲜","危险","易碎","酒"],"minReviewRate":85,"maxReturnRate":10,"minCommissionRate":15,"minMerchantScore":70,"forbiddenFulfillmentKeywords":["货到付款","预售"]},"scoring":{"commission":[{"min":30,"score":20},{"min":20,"score":15},{"min":15,"score":10},{"min":0,"score":0}],"demand":[{"minSales":1000,"requireUp":true,"score":20},{"minSales":1000,"score":15},{"minSales":500,"score":15},{"minSales":100,"score":10},{"minSales":0,"score":5}],"price":[{"min":19.9,"max":99,"score":10},{"min":99,"max":199,"score":7},{"min":0,"max":999999,"score":5}],"supplyChain":[{"minReviewRate":95,"score":10},{"minReviewRate":85,"score":6},{"minReviewRate":0,"score":3}],"contentFriendliness":{"5":15,"4":12,"3":8,"2":5,"1":3},"competition":{"5":15,"4":13,"3":10,"2":8,"1":5},"repurchase":{"5":10,"4":8,"3":6,"2":5,"1":2},"highReturnRateCap":3},"grading":{"strongMin":80,"testMin":60},"topN":5}'::jsonb,
    'active',
    '初始化：PRD A.1/A.2 判据',
    'human-cli',
    now() - interval '3 days'
  ),
  (
    2,
    '{"version":2,"gates":{"bannedCategoryKeywords":["食品","药品","医疗","保健","金融","生鲜","危险","易碎","酒"],"minReviewRate":85,"maxReturnRate":10,"minCommissionRate":18,"minMerchantScore":70,"forbiddenFulfillmentKeywords":["货到付款","预售"]},"scoring":{"commission":[{"min":30,"score":20},{"min":20,"score":15},{"min":18,"score":10},{"min":0,"score":0}],"demand":[{"minSales":1000,"requireUp":true,"score":15},{"minSales":1000,"score":11},{"minSales":500,"score":11},{"minSales":100,"score":7},{"minSales":0,"score":3}],"price":[{"min":19.9,"max":99,"score":10},{"min":99,"max":199,"score":7},{"min":0,"max":999999,"score":5}],"supplyChain":[{"minReviewRate":95,"score":10},{"minReviewRate":85,"score":6},{"minReviewRate":0,"score":3}],"contentFriendliness":{"5":20,"4":16,"3":10,"2":6,"1":3},"competition":{"5":15,"4":13,"3":10,"2":8,"1":5},"repurchase":{"5":10,"4":8,"3":6,"2":5,"1":2},"highReturnRateCap":3},"grading":{"strongMin":85,"testMin":60},"topN":5}'::jsonb,
    'rolled_back',
    '提高佣金门槛至18%并调整主观权重（观察一周后回滚）',
    'human-cli',
    now() - interval '2 days'
  )
on conflict (version) do nothing;

commit;
