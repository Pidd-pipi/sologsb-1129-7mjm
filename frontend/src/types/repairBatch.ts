/** 补刻批次（RepairBatch）：一次勾选多枚停用 / 待补刻字模统一补刻 */

/** 批次中的单枚字模条目（冗余字符与编号，便于直接展示） */
export interface RepairBatchItem {
  matrixId: string;
  character: string;
  matrixCode: string;
}

export interface RepairBatch {
  id: string;
  /** 批次编号，例：BK-20260927-01 */
  code: string;
  items: RepairBatchItem[];
  /**
   * 批次内字模 id 集合（多值索引，便于按字模反查批次）。
   * 与 items 中的 matrixId 保持一致。
   */
  matrixIds: string[];
  /** 负责人（补刻师傅） */
  owner: string;
  /** 计划完成日期 YYYY-MM-DD */
  plannedDate: string;
  note: string;
  /** 进行中 / 已完成 */
  status: '进行中' | '已完成';
  createdAt: string;
  /** 整批收尾时的完成人 */
  completedBy: string;
  /** 整批完成时间 ISO；进行中为空串 */
  completedAt: string;
  /** 实际完成日期 YYYY-MM-DD；进行中为空串 */
  completedDate: string;
}

export interface RepairBatchInput {
  items: RepairBatchItem[];
  owner: string;
  plannedDate: string;
  note?: string;
}

/** 补刻批次建批校验：返回逐字段错误信息，空对象表示通过 */
export function validateRepairBatchInput(input: {
  items: RepairBatchItem[];
  owner: string;
  plannedDate: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.items || input.items.length === 0) errors.items = '请至少勾选一枚需要补刻的字模';
  if (!(input.owner || '').trim()) errors.owner = '请填写负责人';
  const planned = (input.plannedDate || '').trim();
  if (!planned) errors.plannedDate = '请填写计划日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(planned)) errors.plannedDate = '日期格式需为 YYYY-MM-DD';
  return errors;
}

/** 整批完成冲突：提交时某枚字模已不在停用 / 待补刻状态（已被单独恢复等） */
export interface RepairConflict {
  matrixId: string;
  character: string;
  matrixCode: string;
  /** 冲突时字模的实际可用性 */
  availability: string;
}

/** 批次操作冲突：整批收尾前先处理冲突字模 */
export class BatchConflictError extends Error {
  conflicts: RepairConflict[];
  constructor(conflicts: RepairConflict[]) {
    const names = conflicts.map((c) => `「${c.character}」(${c.availability})`).join('、');
    super(`批次内有字模已被单独处理：${names}，请先移出冲突项再整批完成`);
    this.name = 'BatchConflictError';
    this.conflicts = conflicts;
  }
}
