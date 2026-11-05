-- 0007 · 模拟播放事件表（模块④ B3 第二批：内容明细下钻，零 LLM）
-- 数据源：KuaiRec 2.0 small_matrix.csv（约 467 万行播放级观看事件），
-- 配合 sim_content_stats（0006 日粒度台账）做单内容下钻：
-- 完播边界（watch_ratio 分布）、观看时长分布、完播占比。
-- 语义：
--   - 红线：source 强制 'kuairec'——模拟数据永不与真实数据混读
--   - watch_ratio = play_duration / video_duration（≥1 视为看完，KuaiRec 允许循环播放致 >1）
--   - play_duration / video_duration 原始单位一致（比值口径自洽），不做单位换算
--   - date 列为浮点（如 20200705.0）→ 落 watch_date；timestamp 列为浮点秒 → 落 watch_ts
--   - 幂等键 (source, video_id, user_id, watch_ts)：同一用户同一毫秒级时刻只落一次，
--     重跑导入跳过已存在行（do nothing，不覆盖）；watch_ts 为 NOT NULL 保证幂等键不悬空
create table if not exists sim_play_events (
  id             uuid primary key default gen_random_uuid(),
  source         text not null check (source in ('kuairec')),
  video_id       text not null,
  user_id        text not null,
  watch_date     date,
  watch_ts       double precision not null,
  watched_at     text,
  play_duration  double precision,
  video_duration double precision,
  watch_ratio    double precision,
  created_at     timestamptz not null default now(),
  unique (source, video_id, user_id, watch_ts)
);

-- 单内容下钻的主查询路径：按 video_id 拉全量事件
create index if not exists idx_sim_play_video on sim_play_events(source, video_id);
