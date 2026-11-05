-- 0006 · 模拟表现台账（模块④ B3 第一批：数据打通层，零 LLM）
-- 用开源数据集（KuaiRec 2.0）模拟「账号-内容-日」粒度的表现数据，
-- 提前开发数据监控/复盘能力（真实账号数据积累前的练手沙盘）。
-- 语义：
--   - 红线：source 强制标记 'kuairec'——模拟数据永不与真实数据混读，
--     所有读取/看板输出必须带「模拟数据」声明；将来真实数据走独立表，不与本表合并
--   - 口径对齐抖音创作者后台：show_cnt≈曝光、play_cnt≈播放、complete_play_cnt≈完播、
--     like/comment/share/follow≈互动与涨粉（KuaiRec 为快手数据，量纲可比、平台不同）
--   - 幂等键 (source, video_id, stat_date)：重跑导入跳过已存在行（do nothing，不覆盖）
--   - 计数列 null 一律落 0（KuaiRec 的 collect_cnt 有 20% 缺失，缺失≠未知，按无收藏计）
create table if not exists sim_content_stats (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null check (source in ('kuairec')),
  video_id           text not null,
  author_id          text not null,
  stat_date          date not null,
  video_type         text,
  upload_dt          date,
  video_duration     numeric,
  video_tag_name     text,
  show_cnt           bigint not null default 0,
  play_cnt           bigint not null default 0,
  complete_play_cnt  bigint not null default 0,
  like_cnt           bigint not null default 0,
  comment_cnt        bigint not null default 0,
  share_cnt          bigint not null default 0,
  follow_cnt         bigint not null default 0,
  collect_cnt        bigint not null default 0,
  report_cnt         bigint not null default 0,
  -- 内容 enrich（来自 kuairec_caption_category.csv，按 video_id 关联）
  caption            text,
  topic_tag          text,
  category           text,
  created_at         timestamptz not null default now(),
  unique (source, video_id, stat_date)
);

create index if not exists idx_sim_stats_author_date on sim_content_stats(source, author_id, stat_date);
