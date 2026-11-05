-- 0008 · 真实表现数据通道（P0：真实账号数据导入，零 LLM）
-- 复用 0006 的 sim_content_stats 表（「账号-内容-日」粒度表现台账），扩展 source 约束：
--   - 'kuairec' = 开源数据集模拟（练手沙盘）
--   - 'manual'  = 本人账号真实数据（从抖音创作者后台导出 CSV 后手工导入）
-- 红线不变：source 强制隔离，模拟与真实永不混读——所有读取方法必须显式传 source，
--   看板输出必须带数据源声明（模拟带「方法已验证、参数未验证」，真实带「本人账号手工导入」）。
-- 幂等键 (source, video_id, stat_date)：同一视频同一天在两个 source 下互不冲突、互不覆盖。
-- 局限（README 同步）：真实数据暂无归因链路（无内容↔商品↔成交），复盘结论仅到内容表现层。
alter table sim_content_stats drop constraint sim_content_stats_source_check;
alter table sim_content_stats add constraint sim_content_stats_source_check
  check (source in ('kuairec', 'manual'));
