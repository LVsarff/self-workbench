/**
 * 模板理由（有价值的降级）：LLM 不可用/失败/超预算时，用真实数据拼装理由。
 * 引用字段与 LLM 理由同构，进入同一张 reasons 表（source='template'）。
 */
import { GRADE_LABEL, type ScoredProduct } from './types.js';

export interface AgentReason {
  productId: string;
  text: string;
  citedFields: string[];
}

export function templateReason(p: ScoredProduct): AgentReason {
  const s = p.snapshot;
  const gradeZh = p.grade ? GRADE_LABEL[p.grade] : '待评';
  const parts: string[] = [
    `总分 ${p.total}（${gradeZh}）`,
    `佣金 ${s.commissionRate ?? '数据缺失'}%`,
    `近30天销量 ${s.sales30d ?? '数据缺失'}`,
    `好评率 ${s.reviewRate ?? '数据缺失'}%`,
  ];
  if (p.flags.length > 0) parts.push(`注意：${p.flags.join('；')}`);
  parts.push('建议人工复核');
  return {
    productId: p.productId,
    text: parts.join('，') + '。',
    citedFields: ['total', 'commission_rate', 'sales_30d', 'review_rate'],
  };
}

export function templateReasons(products: ScoredProduct[]): AgentReason[] {
  return products.map(templateReason);
}
