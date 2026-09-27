import type { MatrixAvailability } from './matrix';

/** 补刻批次（RepairBatch）：师傅一次勾选多枚字模集中补刻 */

/** 批次状态：进行中 / 已完成 */
export const REPAIR_BATCH_STATUSES = ['进行中', '已完成'] as const;
export type RepairBatchStatus = (typeof REPAIR_BATCH_STATUSES)[number];

/** 批次内单枚字模的快照条目 */
export interface RepairBatchItem {
  matrixId: string;
  /** 冗余保存字符与编号，字模被删除后批次仍可展示 */
  character: string;
  matrixCode: string;
  /** 建批时的可用性（停用 / 待补刻） */
  availability: MatrixAvailability;
  /** 进入批次时间 */
  addedAt: string;
}

export interface RepairBatch {
  id: string;
  /** 批次编号，例：BK-20260927-01 */
  code: string;
  /** 负责人（补刻师傅） */
  owner: string;
  /** 计划完成日期 YYYY-MM-DD */
  plannedDate: string;
  note: string;
  status: RepairBatchStatus;
  items: RepairBatchItem[];
  /** 冗余保存条目字模 id（多值索引），便于按字模反查批次 */
  matrixIds: string[];
  /** 实际整批完成日期 YYYY-MM-DD；进行中为空串 */
  completedDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepairBatchInput {
  matrixIds: string[];
  owner: string;
  plannedDate: string;
  note?: string;
}

/** 生成批次编号建议，例：BK-20260927-01 */
export function suggestRepairBatchCode(dateStr: string, seq: number): string {
  const compact = (dateStr || '').replace(/-/g, '');
  return `BK-${compact}-${`${seq}`.padStart(2, '0')}`;
}

/** 建批表单校验 */
export function validateRepairBatchInput(input: Partial<RepairBatchInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.matrixIds || input.matrixIds.length === 0) errors.matrixIds = '请至少勾选一枚字模';
  if (!(input.owner || '').trim()) errors.owner = '请填写负责人';
  const plannedDate = (input.plannedDate || '').trim();
  if (!plannedDate) errors.plannedDate = '请填写计划完成日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) errors.plannedDate = '日期格式需为 YYYY-MM-DD';
  return errors;
}
