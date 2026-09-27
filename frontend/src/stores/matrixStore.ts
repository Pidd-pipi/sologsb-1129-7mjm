import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { DefectInput, DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { MatrixInput, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofInput, ProofRecord } from '../types/proof';
import {
  BatchConflictError,
  validateRepairBatchInput,
  type RepairBatch,
  type RepairBatchInput,
  type RepairConflict,
} from '../types/repairBatch';
import { makeId, suggestRepairBatchCode, toPlain, todayStr } from '../utils/format';

interface MatrixState {
  matrices: TypeMatrix[];
  defects: DefectLog[];
  proofs: ProofRecord[];
  repairBatches: RepairBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createMatrix: (input: MatrixInput) => Promise<TypeMatrix>;
  updateMatrix: (id: string, patch: Partial<TypeMatrix>) => Promise<void>;
  removeMatrix: (id: string) => Promise<void>;
  addDefect: (input: DefectInput) => Promise<DefectLog>;
  repairMatrix: (matrixId: string, operator: string) => Promise<void>;
  addProof: (input: ProofInput) => Promise<ProofRecord>;
  createRepairBatch: (input: RepairBatchInput) => Promise<RepairBatch>;
  completeRepairBatch: (batchId: string, operator: string) => Promise<RepairBatch>;
  /** 移出已被单独处理的冲突字模；全部移出时批次自动收尾 */
  resolveRepairConflicts: (batchId: string, operator: string) => Promise<{ batch: RepairBatch; removedCount: number }>;
}

const byUpdatedDesc = (a: TypeMatrix, b: TypeMatrix) => (a.updatedAt < b.updatedAt ? 1 : -1);
/** 进行中在前，再按创建时间倒序；已完成按完成时间倒序 */
const byBatchOrder = (a: RepairBatch, b: RepairBatch) => {
  if (a.status !== b.status) return a.status === '进行中' ? -1 : 1;
  const at = a.status === '进行中' ? a.createdAt : a.completedAt || a.createdAt;
  const bt = b.status === '进行中' ? b.createdAt : b.completedAt || b.createdAt;
  return at < bt ? 1 : -1;
};

export const useMatrixStore = create<MatrixState>((set, get) => ({
  matrices: [],
  defects: [],
  proofs: [],
  repairBatches: [],
  loaded: false,
  loading: false,
  error: '',

  /** 首次进入时写入示例档案并读回全部数据 */
  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [matrices, defects, proofs, repairBatches] = await Promise.all([
        db.matrices.toArray(),
        db.defects.toArray(),
        db.proofs.toArray(),
        db.repairBatches.toArray(),
      ]);
      set({
        matrices: matrices.sort(byUpdatedDesc),
        defects,
        proofs,
        repairBatches: repairBatches.sort(byBatchOrder),
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '本地档案读取失败' });
    }
  },

  createMatrix: async (input) => {
    const now = new Date().toISOString();
    const row: TypeMatrix = toPlain({
      id: makeId('mtx'),
      code: input.code.trim(),
      character: input.character.trim(),
      font: input.font,
      sizeName: input.sizeName,
      sizePt: ptOfSize(input.sizeName),
      material: input.material,
      faceWidthMm: Number(input.faceWidthMm),
      bodyHeightMm: Number(input.bodyHeightMm),
      madeYear: Number(input.madeYear),
      engraver: input.engraver.trim(),
      availability: '可用' as const,
      note: (input.note ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    });
    await db.matrices.add(row);
    set((s) => ({ matrices: [row, ...s.matrices] }));
    return row;
  },

  updateMatrix: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeMatrix> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.sizeName) next.sizePt = ptOfSize(plain.sizeName);
    await db.matrices.update(id, next);
    set((s) => ({
      matrices: s.matrices
        .map((m) => (m.id === id ? { ...m, ...next } : m))
        .sort(byUpdatedDesc),
    }));
  },

  removeMatrix: async (id) => {
    let nextBatches: RepairBatch[] = [];
    await db.transaction(
      'rw',
      db.matrices,
      db.defects,
      db.proofs,
      db.repairBatches,
      async () => {
        await db.matrices.delete(id);
        const defectIds = (await db.defects.where('matrixId').equals(id).toArray()).map((d) => d.id);
        const proofIds = (await db.proofs.where('matrixId').equals(id).toArray()).map((p) => p.id);
        await db.defects.bulkDelete(defectIds);
        await db.proofs.bulkDelete(proofIds);
        // 进行中批次剔除该字模；剔除后为空的批次自动收尾，避免批次里挂着已删除的字模
        const batches = await db.repairBatches.where('status').equals('进行中').toArray();
        for (const batch of batches) {
          if (!batch.matrixIds.includes(id)) continue;
          const items = batch.items.filter((i) => i.matrixId !== id);
          if (items.length === 0) {
            const stamp = new Date().toISOString();
            await db.repairBatches.update(batch.id, {
              items,
              matrixIds: [],
              status: '已完成',
              completedBy: '档案删除',
              completedAt: stamp,
              completedDate: todayStr(),
            });
          } else {
            await db.repairBatches.update(batch.id, {
              items,
              matrixIds: items.map((i) => i.matrixId),
            });
          }
        }
        nextBatches = await db.repairBatches.toArray();
      },
    );
    set((s) => ({
      matrices: s.matrices.filter((m) => m.id !== id),
      defects: s.defects.filter((d) => d.matrixId !== id),
      proofs: s.proofs.filter((p) => p.matrixId !== id),
      repairBatches: nextBatches.sort(byBatchOrder),
    }));
  },

  /** 登记缺损：写入缺损记录，并按结论自动停用字模 */
  addDefect: async (input) => {
    const matrix = get().matrices.find((m) => m.id === input.matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法登记缺损');
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId: input.matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: input.defectType,
      severity: input.severity,
      foundDate: input.foundDate || todayStr(),
      handling: input.handling.trim(),
      availability: input.availability,
      operator: input.operator.trim(),
      note: (input.note ?? '').trim(),
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    if (shouldDisableMatrix(input.availability)) {
      await get().updateMatrix(input.matrixId, { availability: input.availability });
    }
    return row;
  },

  /** 补刻完成：恢复可用，并留下一条收尾记录 */
  repairMatrix: async (matrixId, operator) => {
    const matrix = get().matrices.find((m) => m.id === matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法补刻');
    const history = get()
      .defects.filter((d) => d.matrixId === matrixId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const last = history[0];
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: last?.defectType ?? '磨损',
      severity: last?.severity ?? '轻',
      foundDate: todayStr(),
      handling: `补刻完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
      availability: '可用' as const,
      operator: operator.trim() || '补刻工',
      note: '补刻收尾记录',
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    await get().updateMatrix(matrixId, { availability: '可用' });
  },

  addProof: async (input) => {
    const matrix = input.matrixId ? get().matrices.find((m) => m.id === input.matrixId) : undefined;
    const row: ProofRecord = toPlain({
      id: makeId('pfr'),
      targetKind: input.targetKind,
      targetRef: input.targetRef.trim(),
      matrixId: input.matrixId,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: input.clarity,
      proofDate: input.proofDate || todayStr(),
      note: (input.note ?? '').trim(),
      createdAt: new Date().toISOString(),
    });
    if (matrix && input.targetKind === '字符' && !row.targetRef) row.targetRef = matrix.character;
    await db.proofs.add(row);
    set((s) => ({ proofs: [row, ...s.proofs] }));
    return row;
  },

  /** 建立补刻批次：勾选的字模必须处于停用 / 待补刻，且不在其它进行中批次里 */
  createRepairBatch: async (input) => {
    const errors = validateRepairBatchInput({
      items: input.items,
      owner: input.owner,
      plannedDate: input.plannedDate,
    });
    if (Object.keys(errors).length > 0) {
      throw new Error(Object.values(errors)[0]);
    }

    const ids = Array.from(new Set(input.items.map((i) => i.matrixId)));
    const now = new Date();
    const today = todayStr();

    let row: RepairBatch;
    await db.transaction('rw', db.repairBatches, db.matrices, async () => {
      // 事务内重读，拦截「已在未完成批次」或已恢复可用的选中字模
      const [rows, openBatches] = await Promise.all([
        Promise.all(ids.map((mid) => db.matrices.get(mid))),
        db.repairBatches.where('status').equals('进行中').toArray(),
      ]);

      const busy = new Set<string>();
      for (const b of openBatches) for (const mid of b.matrixIds) busy.add(mid);

      const notFound: string[] = [];
      const alreadyOpen: string[] = [];
      const notPending: string[] = [];
      rows.forEach((m, idx) => {
        if (!m) notFound.push(ids[idx]);
        else if (busy.has(m.id)) alreadyOpen.push(m.character || m.code);
        else if (m.availability === '可用') notPending.push(m.character || m.code);
      });
      if (notFound.length > 0) throw new Error(`部分字模档案已不存在：${notFound.join('、')}`);
      if (alreadyOpen.length > 0) {
        throw new Error(`「${alreadyOpen.join('、')}」已在未完成批次中，不能重复选入`);
      }
      if (notPending.length > 0) {
        throw new Error(`「${notPending.join('、')}」当前可用，无需补刻`);
      }

      const seqToday = await db.repairBatches
        .filter((b) => b.code.startsWith(`BK-${today.replace(/-/g, '')}`))
        .count();
      row = toPlain({
        id: makeId('rpb'),
        code: suggestRepairBatchCode(today, seqToday + 1),
        items: input.items
          .filter((i, iIdx) => ids.indexOf(i.matrixId) === iIdx)
          .map((i) => ({ matrixId: i.matrixId, character: i.character, matrixCode: i.matrixCode })),
        matrixIds: ids,
        owner: input.owner.trim(),
        plannedDate: input.plannedDate,
        note: (input.note ?? '').trim(),
        status: '进行中' as const,
        createdAt: now.toISOString(),
        completedBy: '',
        completedAt: '',
        completedDate: '',
      });
      await db.repairBatches.add(row);
    });

    const created = row!;
    set((s) => ({ repairBatches: [created, ...s.repairBatches].sort(byBatchOrder) }));
    return created;
  },

  /** 整批完成：全部字模恢复可用、各留一条收尾记录；有字模已被单独处理则整体中止 */
  completeRepairBatch: async (batchId, operator) => {
    let updatedBatch: RepairBatch | undefined;
    let updatedMatrices: TypeMatrix[] = [];
    let addedDefects: DefectLog[] = [];

    await db.transaction('rw', db.repairBatches, db.matrices, db.defects, async () => {
      const batch = await db.repairBatches.get(batchId);
      if (!batch) throw new Error('未找到该补刻批次');
      if (batch.status !== '进行中') throw new Error('该批次已完成，不能重复收尾');

      const rows = await Promise.all(batch.matrixIds.map((mid) => db.matrices.get(mid)));

      // 冲突：提交前某枚字模已被单独恢复（或删除）→ 整批停下来
      const conflicts: RepairConflict[] = [];
      batch.matrixIds.forEach((mid, idx) => {
        const m = rows[idx];
        const item = batch.items.find((i) => i.matrixId === mid);
        if (!m) {
          conflicts.push({
            matrixId: mid,
            character: item?.character ?? '已删除',
            matrixCode: item?.matrixCode ?? '—',
            availability: '档案不存在',
          });
        } else if (m.availability === '可用') {
          conflicts.push({
            matrixId: m.id,
            character: m.character,
            matrixCode: m.code,
            availability: m.availability,
          });
        }
      });
      if (conflicts.length > 0) throw new BatchConflictError(conflicts);

      const stamp = new Date();
      const finishDate = todayStr();
      const op = operator.trim() || batch.owner;

      const logs: DefectLog[] = [];
      const nextMatrices: TypeMatrix[] = [];
      for (const m of rows) {
        if (!m) continue;
        const last = (await db.defects.where('matrixId').equals(m.id).toArray()).sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : -1,
        )[0];
        logs.push({
          id: makeId('dft'),
          matrixId: m.id,
          character: m.character,
          matrixCode: m.code,
          defectType: last?.defectType ?? '磨损',
          severity: last?.severity ?? '轻',
          foundDate: finishDate,
          handling: `补刻批次 ${batch.code}：补刻完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
          availability: '可用',
          operator: op,
          note: '补刻收尾记录',
          createdAt: stamp.toISOString(),
        });
        const updatedAt = stamp.toISOString();
        await db.matrices.update(m.id, { availability: '可用', updatedAt });
        nextMatrices.push({ ...m, availability: '可用', updatedAt });
      }
      await db.defects.bulkAdd(logs);

      const finished: RepairBatch = {
        ...batch,
        status: '已完成',
        completedBy: op,
        completedAt: stamp.toISOString(),
        completedDate: finishDate,
      };
      await db.repairBatches.put(finished);

      updatedBatch = finished;
      updatedMatrices = nextMatrices;
      addedDefects = logs;
    });

    const finished = updatedBatch!;
    set((s) => {
      const nextMatrices = [...s.matrices];
      for (const um of updatedMatrices) {
        const idx = nextMatrices.findIndex((m) => m.id === um.id);
        if (idx >= 0) nextMatrices[idx] = um;
      }
      return {
        matrices: nextMatrices.sort(byUpdatedDesc),
        defects: [...addedDefects, ...s.defects],
        repairBatches: s.repairBatches.map((b) => (b.id === batchId ? finished : b)).sort(byBatchOrder),
      };
    });
    return finished;
  },

  /** 移出批次中的冲突字模（已被单独恢复 / 删除的条目）；全部移出则批次自动收尾 */
  resolveRepairConflicts: async (batchId, operator) => {
    let updatedBatch: RepairBatch | undefined;
    let removedIds: string[] = [];

    await db.transaction('rw', db.repairBatches, db.matrices, async () => {
      const batch = await db.repairBatches.get(batchId);
      if (!batch) throw new Error('未找到该补刻批次');
      if (batch.status !== '进行中') throw new Error('该批次已完成，无需处理冲突');

      const rows = await Promise.all(batch.matrixIds.map((mid) => db.matrices.get(mid)));
      const statusOf = new Map(rows.filter((m): m is TypeMatrix => Boolean(m)).map((m) => [m.id, m.availability]));
      // 仍处于停用 / 待补刻的字模保留在批次内，其余视为冲突移出
      const kept = batch.items.filter((item) => (statusOf.get(item.matrixId) ?? '可用') !== '可用');
      removedIds = batch.matrixIds.filter((id) => !kept.some((i) => i.matrixId === id));

      const stamp = new Date().toISOString();
      if (kept.length === 0) {
        updatedBatch = {
          ...batch,
          items: [],
          matrixIds: [],
          status: '已完成',
          completedBy: operator.trim() || '冲突处理',
          completedAt: stamp,
          completedDate: todayStr(),
        };
      } else {
        updatedBatch = {
          ...batch,
          items: kept,
          matrixIds: kept.map((i) => i.matrixId),
        };
      }
      await db.repairBatches.put(updatedBatch);
    });

    const next = updatedBatch!;
    set((s) => ({
      repairBatches: s.repairBatches.map((b) => (b.id === batchId ? next : b)).sort(byBatchOrder),
    }));
    return { batch: next, removedCount: removedIds.length };
  },
}));

/** 单条字模（组件内使用，避免整表订阅） */
export function selectMatrix(id: string) {
  return (s: MatrixState) => s.matrices.find((m) => m.id === id);
}
