-- 0001_init.sql — AI 带货工作台 MVP 初始 schema
-- 对应《AI带货工作台-上下文与工具设计》§4.2 审计要求：
--   rule_versions / decisions / llm_call_logs 为 append-only（应用层保证：只 INSERT，禁 UPDATE/DELETE）。
--   真正防篡改可后续加触发器或回收 UPDATE/DELETE 权限，MVP 以约定执行。

create table if not exists schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

-- 规则版本链（append-only）：AI 只能建议，人批准后由 CLI 生效
create table if not exists rule_versions (
  id            uuid primary key default gen_random_uuid(),
  version       integer not null unique,
  config        jsonb   not null,
  status        text    not null check (status in ('active','superseded','rolled_back')),
  change_reason text,
  approved_by   text    not null default 'human-cli',
  created_at    timestamptz not null default now()
);
-- 同一时刻只允许一个 active
create unique index if not exists rule_versions_one_active
  on rule_versions ((status)) where status = 'active';

-- 商品身份表（外部 ID 唯一键 + 黑名单）
create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  external_id      text not null unique,
  title            text,
  category         text,
  blacklisted      boolean not null default false,
  blacklist_reason text,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 导入批次（数据血缘：来源/时间/行数）
create table if not exists import_batches (
  id             uuid primary key default gen_random_uuid(),
  batch_date     date not null,
  source_file    text not null,
  row_count      integer not null,
  valid_count    integer not null,
  skipped_count  integer not null,
  notes          jsonb,
  created_at     timestamptz not null default now()
);

-- 每日商品快照（当天字段全量留档，决策可回溯）
create table if not exists product_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references products(id),
  batch_date            date not null,
  title                 text,
  category              text,
  price                 numeric(10,2),
  commission_rate       numeric(5,2),
  sales_30d             integer,
  mom_trend             text check (mom_trend in ('up','flat','down')),
  review_rate           numeric(5,2),
  return_rate           numeric(5,2),
  merchant_score        numeric(5,1),
  fulfillment           text,
  content_friendliness  smallint check (content_friendliness between 1 and 5),
  competition           smallint check (competition between 1 and 5),
  repurchase            smallint check (repurchase between 1 and 5),
  image_url             text,
  raw                   jsonb,
  unique (product_id, batch_date)
);

-- 每日 run（run 状态机：scoring → reasoned → submitted → selected / expired / failed）
create table if not exists daily_runs (
  id           uuid primary key default gen_random_uuid(),
  batch_date   date not null,
  rule_version integer not null,
  phase        text not null check (phase in ('scoring','reasoned','submitted','selected','expired','failed')),
  status       text not null check (status in ('running','done','degraded','failed')),
  stats        jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- 打分记录（含门槛结果与得分明细；幂等键 run+product）
create table if not exists score_records (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references daily_runs(id),
  product_id      uuid not null references products(id),
  rule_version    integer not null,
  gate_passed     boolean not null,
  gate_results    jsonb not null,
  dimension_scores jsonb not null,
  total           integer not null,
  complete        boolean not null,
  grade           text check (grade in ('strong','test','drop')),
  flags           jsonb not null default '[]'::jsonb,
  unique (run_id, product_id)
);

-- 推荐理由（LLM / 模板 降级 / 人工）
create table if not exists reasons (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references daily_runs(id),
  product_id   uuid not null references products(id),
  text         text not null,
  cited_fields jsonb not null default '[]'::jsonb,
  source       text not null check (source in ('llm','template','manual')),
  created_at   timestamptz not null default now(),
  unique (run_id, product_id)
);

-- 决策流水（append-only，审计核心表：勾选/放弃/暂缓）
create table if not exists decisions (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null references daily_runs(id),
  batch_date              date not null,
  product_id              uuid not null references products(id),
  action                  text not null check (action in ('selected','rejected','deferred')),
  decided_by              text not null default 'human',
  note                    text,
  rule_version_at_decision integer,
  total_score             integer,
  decided_at              timestamptz not null default now(),
  unique (run_id, product_id, action)
);

-- LLM 调用审计（输入快照 + 输出；Langfuse 接入前的本地留痕）
create table if not exists llm_call_logs (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid,
  purpose    text not null,
  model      text,
  skill      text,
  input      jsonb not null,
  output     jsonb,
  ok         boolean not null,
  error      text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_snapshots_date on product_snapshots(batch_date);
create index if not exists idx_runs_date on daily_runs(batch_date, started_at desc);
create index if not exists idx_decisions_date on decisions(batch_date);
create index if not exists idx_llm_logs_created on llm_call_logs(created_at);
