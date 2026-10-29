/**
 * BullMQ 定时调度：每日 09:00（Asia/Shanghai）触发 daily-scan。
 * 门超时（第 4 层）：清单提交后 24h 未勾选 → 标记 expired，顺延次日（不阻塞流水线）。
 */
import { Queue, Worker } from 'bullmq';
import { loadEnv } from '../env.js';
import { PgRepo } from '../db/pg-repo.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { createReasonAgentFromEnv } from '../agent/reason-agent.js';
import { todayShanghai } from '../util.js';

loadEnv();

const CONNECTION = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
const QUEUE_NAME = 'gwd-daily';

async function expireStaleLists(repo: PgRepo): Promise<number> {
  // 勾选门 24h 超时：昨日及更早的 submitted 清单 → expired
  return repo.expireStaleSubmittedRuns(todayShanghai());
}

async function main() {
  const queue = new Queue(QUEUE_NAME, { connection: CONNECTION });
  // BullMQ v6：repeatable job 通过 Job Scheduler 注册（v5 的 opts.repeat 已移除）
  await queue.upsertJobScheduler(
    'daily-scan-cron',
    { pattern: '0 9 * * *', tz: 'Asia/Shanghai' },
    { name: 'daily-scan', data: {} },
  );
  console.log('已注册定时任务: daily-scan @ 09:00 Asia/Shanghai');

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const repo = new PgRepo(process.env.DATABASE_URL ?? 'postgres://gwd:gwd@localhost:5432/gwd');
      try {
        const expired = await expireStaleLists(repo);
        if (expired > 0) console.log(`勾选门超时: ${expired} 个清单已标记 expired（顺延不阻塞）`);
        const result = await runDailyScan({ repo, agent: createReasonAgentFromEnv() });
        console.log(`[daily-scan] ${result.date} 打分 ${result.scoredCount}，入榜 ${result.topCount}，理由 ${result.reasonSource}${result.degraded ? '（降级）' : ''}`);
      } finally {
        await repo.close();
      }
    },
    { connection: CONNECTION },
  );

  worker.on('failed', (job, err) => {
    console.error(`[daily-scan] 失败: ${err.message}（明日自动重试；当日可手动 npm run gwd -- daily-scan 补跑）`);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await worker.close();
      await queue.close();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
