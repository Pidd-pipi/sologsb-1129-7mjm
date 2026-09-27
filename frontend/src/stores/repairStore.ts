import { create } from 'zustand';
import { db, ensureSeed, suggestRepairBatchCode } from '../db';
import { useMatrixStore } from './matrixStore';
import type { RepairBatch, RepairBatchInput, RepairBatchItem } from '../types/repair';
import { validateRepairBatchInput } from '../types/repair';
import { makeId, toPlain, todayStr } from '../utils/format';

/** 整批完成时发现的冲突：字模在提交前已被人单独恢复（或被删除） */
export interface BatchConflict {
  matrixId: string;
  character: string;
  matrixCode: string;
  /** 冲突原因：已单独恢复可用 / 档案已删除 */
  reason: string;
}

/** 整批完成冲突：整批停下来，需先处理冲突 */
export class RepairBatchConflictError extends Error {
  conflicts: BatchConflict[];
  constructor(conflicts: BatchConflict[]) {
    super('批次内有字模已被单独恢复，请先处理冲突');
    this.name = 'RepairBatchConflictError';
    this.conflicts = conflicts;
  }
}

interface RepairState {
  batches: RepairBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createBatch: (input: RepairBatchInput) => Promise<RepairBatch>;
  /** 整批完成：字模一起恢复可用、各留一条补刻收尾记录；有冲突则整批停下 */
  completeBatch: (id: string, operator: string) => Promise<void>;
  /** 冲突处理：把已被单独恢复的字模从批次中移出（空批次整单删除） */
  removeBatchItems: (id: string, matrixIds: string[]) => Promise<void>;
}

const sortBatches = (list: RepairBatch[]) =>
  [...list].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === '进行中' ? -1 : 1) ||
      (a.createdAt < b.createdAt ? 1 : -1),
  );

/** 找出进行中批次占用的字模 id（建批勾选时据此禁选） */
export function selectBusyMatrixIds(batches: RepairBatch[]): Set<string> {
  const ids = new Set<string>();
  for (const b of batches) {
    if (b.status !== '进行中') continue;
    for (const item of b.items) ids.add(item.matrixId);
  }
  return ids;
}

export const useRepairStore = create<RepairState>((set, get) => ({
  batches: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const batches = await db.repairBatches.toArray();
      set({ batches: sortBatches(batches), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '补刻批次读取失败' });
    }
  },

  createBatch: async (input) => {
    const errors = validateRepairBatchInput(input);
    if (Object.keys(errors).length > 0) {
      throw new Error(Object.values(errors)[0]);
    }
    const ids = Array.from(new Set(input.matrixIds));

    // 以库内最新状态校验（可能刚被其他页面 / 标签页改动）：
    // 已在未完成批次里的字模不能再次选中；可用字模无需补刻
    const [activeBatches, freshMatrices] = await Promise.all([
      db.repairBatches.where('status').equals('进行中').toArray(),
      db.matrices.toArray(),
    ]);
    const busy = selectBusyMatrixIds(activeBatches);
    const duplicated = ids.filter((id) => busy.has(id));
    if (duplicated.length > 0) {
      const names = duplicated
        .map((id) => freshMatrices.find((m) => m.id === id)?.character ?? id)
        .join('、');
      throw new Error(`字模 ${names} 已在未完成批次中，不能重复选择`);
    }
    const items: RepairBatchItem[] = [];
    for (const matrixId of ids) {
      const m = freshMatrices.find((x) => x.id === matrixId);
      if (!m) throw new Error('所选字模已不存在，无法建立批次');
      if (m.availability === '可用') throw new Error(`字模「${m.character}」当前可用，无需补刻`);
      items.push({
        matrixId: m.id,
        character: m.character,
        matrixCode: m.code,
        availability: m.availability,
        addedAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const seq = (await db.repairBatches.count()) + 1;
    const row: RepairBatch = toPlain({
      id: makeId('rb'),
      code: suggestRepairBatchCode(todayStr(), seq),
      owner: input.owner.trim(),
      plannedDate: input.plannedDate.trim(),
      note: (input.note ?? '').trim(),
      status: '进行中' as const,
      items,
      matrixIds: items.map((i) => i.matrixId),
      completedDate: '',
      createdAt: now,
      updatedAt: now,
    });
    await db.repairBatches.add(row);
    set((s) => ({ batches: sortBatches([row, ...s.batches]) }));
    return row;
  },

  completeBatch: async (id, operator) => {
    const batch = get().batches.find((b) => b.id === id);
    if (!batch) throw new Error('未找到对应补刻批次');
    if (batch.status !== '进行中') throw new Error('该批次已完成');

    // 全部写库操作放进同一个事务；冲突在事务内按库内最新状态判定，保证原子性
    await db.transaction(
      'rw',
      db.repairBatches,
      db.matrices,
      db.defects,
      async () => {
        const conflicts: BatchConflict[] = [];
        const freshMatrices = new Map((await db.matrices.toArray()).map((m) => [m.id, m]));
        for (const item of batch.items) {
          const m = freshMatrices.get(item.matrixId);
          if (!m) {
            conflicts.push({
              matrixId: item.matrixId,
              character: item.character,
              matrixCode: item.matrixCode,
              reason: '档案已删除',
            });
          } else if (m.availability === '可用') {
            conflicts.push({
              matrixId: item.matrixId,
              character: item.character,
              matrixCode: item.matrixCode,
              reason: '已被单独恢复可用',
            });
          }
        }
        if (conflicts.length > 0) throw new RepairBatchConflictError(conflicts);

        const finishDate = todayStr();
        const finishStamp = new Date().toISOString();
        const op = operator.trim() || batch.owner;
        const closingLogs = [];
        for (const item of batch.items) {
          const history = await db.defects.where('matrixId').equals(item.matrixId).toArray();
          const last = history.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
          closingLogs.push({
            id: makeId('dft'),
            matrixId: item.matrixId,
            character: item.character,
            matrixCode: item.matrixCode,
            defectType: last?.defectType ?? '磨损',
            severity: last?.severity ?? '轻',
            foundDate: finishDate,
            handling: `补刻批次 ${batch.code} 整批完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
            availability: '可用' as const,
            operator: op,
            note: `补刻收尾记录 · 批次 ${batch.code}`,
            createdAt: finishStamp,
          });
          await db.matrices.update(item.matrixId, {
            availability: '可用',
            updatedAt: finishStamp,
          });
        }
        await db.defects.bulkAdd(closingLogs);
        await db.repairBatches.update(batch.id, {
          status: '已完成',
          completedDate: finishDate,
          updatedAt: finishStamp,
        });
      },
    );

    // 事务提交后再同步内存状态
    const [freshBatch, freshMatrices, freshDefects] = await Promise.all([
      db.repairBatches.get(id),
      db.matrices.toArray(),
      db.defects.toArray(),
    ]);
    set((s) => ({
      batches: sortBatches(s.batches.map((b) => (b.id === id ? freshBatch ?? b : b))),
    }));
    useMatrixStore.setState({
      matrices: freshMatrices.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      defects: freshDefects,
    });
  },

  removeBatchItems: async (id, matrixIds) => {
    const batch = get().batches.find((b) => b.id === id);
    if (!batch) throw new Error('未找到对应补刻批次');
    const drop = new Set(matrixIds);
    const items = batch.items.filter((i) => !drop.has(i.matrixId));

    if (items.length === 0) {
      // 条目全部移出（含冲突），批次没有继续补刻的对象，整单删除
      await db.repairBatches.delete(id);
      set((s) => ({ batches: sortBatches(s.batches.filter((b) => b.id !== id)) }));
      return;
    }

    const now = new Date().toISOString();
    const next: Partial<RepairBatch> = {
      items: toPlain(items),
      matrixIds: items.map((i) => i.matrixId),
      updatedAt: now,
    };
    await db.repairBatches.update(id, next);
    set((s) => ({ batches: sortBatches(s.batches.map((b) => (b.id === id ? { ...b, ...next } : b))) }));
  },
}));
