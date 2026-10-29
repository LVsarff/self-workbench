/**
 * 勾选门（门①）：人勾选要做的品，append-only 落决策流水。
 * CLI `gwd select` 与 Web/API 走同一服务函数。
 */
import type { Repo } from '../db/repo.js';
import { todayShanghai } from '../util.js';

export interface SelectOptions {
  repo: Repo;
  date?: string;
  externalIds: string[];
  note?: string;
}

export interface SelectResult {
  runId: string;
  date: string;
  selected: string[];
  alreadySelected: string[];
  unknownIds: string[];
}

export async function selectProducts(opts: SelectOptions): Promise<SelectResult> {
  const date = opts.date ?? todayShanghai();
  const repo = opts.repo;

  const list = await repo.getDailyList(date);
  if (!list) throw new Error(`${date} 没有候选清单，先执行 gwd daily-scan`);
  if (list.phase === 'expired') throw new Error(`${date} 的清单已过期（勾选门 24h 超时）`);
  if (!['submitted', 'selected'].includes(list.phase)) {
    throw new Error(`${date} 的清单状态为 ${list.phase}，不可勾选（需 submitted）`);
  }

  const byExternal = new Map(list.items.map((i) => [i.externalId, i]));
  const unknownIds = opts.externalIds.filter((id) => !byExternal.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`以下商品不在 ${date} 的清单中: ${unknownIds.join(', ')}（可用 ID 见 gwd list）`);
  }

  const alreadySelected: string[] = [];
  const toSelect: string[] = [];
  for (const id of opts.externalIds) {
    const item = byExternal.get(id)!;
    if (item.selected) alreadySelected.push(id);
    else toSelect.push(id);
  }

  if (toSelect.length > 0) {
    await repo.saveDecisions(
      toSelect.map((id) => {
        const item = byExternal.get(id)!;
        return {
          runId: list.runId,
          batchDate: date,
          productId: item.productId,
          action: 'selected' as const,
          decidedBy: 'human',
          note: opts.note,
          ruleVersion: list.ruleVersion,
          totalScore: item.total,
        };
      }),
    );
    await repo.updateRun(list.runId, { phase: 'selected' });
  }

  return {
    runId: list.runId,
    date,
    selected: toSelect,
    alreadySelected,
    unknownIds,
  };
}
