-- 0011 · 品类趋势背景板（模块① V3：巨量算数/行业报告人工导出 → 品类-日搜索指数；零 LLM）
-- 「品类-日」粒度趋势台账：人工抄录巨量算数等外部平台数据 → gwd trend-import 幂等导入。
-- 红线与口径：
--   - source 强制 'manual'——外部指数只能人工导出/抄录，无爬虫、无自动采集（远期池另议）
--   - search_index 为指数类数值（巨量算数口径，参数未验证）：非负整数，千分位容忍，负数/非数字整行作废
--   - 幂等键 (source, category, stat_date)：同品类同日重复导入跳过，不覆盖
--   - 用途：选品时的背景参考（品类在涨还是在跌），不进打分——打分只认自己的表现台账
create table if not exists category_trend (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('manual')),
  category      text not null,
  stat_date     date not null,
  search_index  bigint not null,
  created_at    timestamptz not null default now(),
  unique (source, category, stat_date)
);

create index if not exists idx_category_trend_date on category_trend(source, stat_date);
