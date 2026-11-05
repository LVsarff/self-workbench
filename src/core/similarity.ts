/**
 * 文本相似度（L1 确定性代码，历史去重用）。
 * 字符二元组（bigram）Jaccard：中文无词边界，bigram 是最小可用的重复检测口径——
 * 逐字相同 = 1，换词复述显著下降，模板化套话部分重叠。
 * 阈值语义：≥ 阈值 = 「换角度重写」级别的重复（触发修订；修不掉仅提示，门③ 终判）。
 */

/** 与近期草稿相似度达到该值 → 记 duplicates 并触发修订 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

/** 字符二元组集合（忽略空白） */
function charBigrams(text: string): Set<string> {
  const cleaned = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i + 1 < cleaned.length; i += 1) {
    grams.add(cleaned.slice(i, i + 2));
  }
  if (grams.size === 0 && cleaned.length > 0) grams.add(cleaned);
  return grams;
}

/** Jaccard 相似度 0-1（任一侧为空文本 → 0） */
export function jaccardSimilarity(a: string, b: string): number {
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const g of A) {
    if (B.has(g)) intersection += 1;
  }
  return intersection / (A.size + B.size - intersection);
}
