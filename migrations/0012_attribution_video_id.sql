-- 0012_attribution_video_id.sql — 模块⑤ V3 框架先行第四批：内容层表现归因
-- 发布台账 ↔ 真实表现台账（real_import，「账号-内容-日」粒度）的 join 锚点：
--   - video_id：平台侧内容唯一标识（抖音视频 id / 小红书笔记 id），人工发布后回填或补链
--   - 只影响归因查询，不参与任何合规审计链（审计在 content_decisions 门③ 5 项清单）
--   - join 语义：publish_records.video_id = real 表现行 video_id（source='manual'，红线：模拟数据 kuairec 永不参与归因）
--   - 可空：历史已发布记录没有 video_id 的，走 gwd attribution-link 补链（幂等可重跑）
alter table publish_records add column if not exists video_id text;

create index if not exists idx_publish_records_video on publish_records(video_id) where status = 'published';
