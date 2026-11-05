-- 0009_rule_proposals.sql — 模块⑤ 结论回写闭环：建议 → 人批准 → 版本化生效 → 可回滚
-- 提案是「带依据的规则变更草案」：append-only 创建，status 单向一次转换（pending → approved/rejected），
-- 批准即走 rule_versions 版本链（同事务），系统永不自行生效提案——门⑤ 红线。

create table if not exists rule_proposals (
  id                uuid primary key default gen_random_uuid(),
  basis             text not null,          -- 提案依据（如：sim-weekly 2026-11-05 曝光跌 30% 触发）
  expected_effect   text,                   -- 预期效果（人判断的验收锚点）
  config            jsonb not null,         -- 提议的完整规则配置（批准时重新校验）
  status            text not null check (status in ('pending','approved','rejected')),
  decided_by        text,
  decided_at        timestamptz,
  resulting_version integer,               -- 批准后生成的规则版本号（回滚入口）
  created_at        timestamptz not null default now()
);

create index if not exists idx_rule_proposals_status on rule_proposals(status, created_at desc);
