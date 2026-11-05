-- 0010 · 商品层表现数据通道（模块④ V3：加购 / 成交 / 佣金，按品；零 LLM）
-- 「商品-日」粒度真实表现台账：联盟/带货后台人工导出 CSV → gwd real-product-import 幂等导入。
-- 红线与口径：
--   - source 强制 'manual'——KuaiRec 无带货归因链路，商品层模拟形态做不了，
--     本表只有真实通道，永远不会有 'kuairec'（与 sim_content_stats 双源设计不同）
--   - product_id = 平台商品 ID，对应候选快照 external_id——将来表现归因闭环的 join 锚点；
--     但不要求先有快照（后台导出的品可能不在选品池里，允许先记账后关联）
--   - 金额 numeric(14,2)（元，两位小数）；计数 bigint
--   - 幂等键 (source, product_id, stat_date)：同一商品同一天重复导入跳过，不覆盖
--   - 缺失值不编数：文本缺失 → null；计数/金额缺失 → 0（缺失≠未知，按无成交计）
create table if not exists product_performance (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null check (source in ('manual')),
  product_id         text not null,
  stat_date          date not null,
  product_title      text,
  category           text,
  click_cnt          bigint not null default 0,
  add_cart_cnt       bigint not null default 0,
  order_cnt          bigint not null default 0,
  gmv_amount         numeric(14,2) not null default 0,
  commission_amount  numeric(14,2) not null default 0,
  created_at         timestamptz not null default now(),
  unique (source, product_id, stat_date)
);

create index if not exists idx_product_perf_date on product_performance(source, stat_date);
