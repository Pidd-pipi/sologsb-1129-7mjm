import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import DefectBadge from '../components/common/DefectBadge';
import EmptyState from '../components/common/EmptyState';
import RepairBatchCard from '../components/common/RepairBatchCard';
import { DRAFT_KEYS, useLocalDraft } from '../hooks/useLocalDraft';
import { useMatrixStore } from '../stores/matrixStore';
import {
  RepairBatchConflictError,
  selectBusyMatrixIds,
  useRepairStore,
  type BatchConflict,
} from '../stores/repairStore';
import { useUiStore } from '../stores/uiStore';
import {
  DEFECT_SEVERITIES,
  DEFECT_TYPES,
  SEVERITY_WEIGHT,
  validateDefectInput,
  type DefectInput,
  type DefectSeverity,
  type DefectType,
} from '../types/defect';
import { MATRIX_AVAILABILITIES, type MatrixAvailability } from '../types/matrix';
import { countBy, dash, formatDate, todayStr } from '../utils/format';

interface DefectFormState {
  matrixId: string;
  defectType: DefectType;
  severity: DefectSeverity;
  foundDate: string;
  handling: string;
  availability: MatrixAvailability;
  operator: string;
  note: string;
}

const INITIAL_FORM: DefectFormState = {
  matrixId: '',
  defectType: '缺笔',
  severity: '中',
  foundDate: todayStr(),
  handling: '',
  availability: '停用',
  operator: '',
  note: '',
};

interface BatchDraft {
  selectedIds: string[];
  owner: string;
  plannedDate: string;
  note: string;
}

const INITIAL_BATCH_DRAFT: BatchDraft = {
  selectedIds: [],
  owner: '',
  plannedDate: todayStr(),
  note: '',
};

/** `/defects` 缺损登记：登记缺损、勾选多枚字模建立补刻批次、整批完成恢复可用 */
export default function DefectBoard() {
  const matrices = useMatrixStore((s) => s.matrices);
  const defects = useMatrixStore((s) => s.defects);
  const addDefect = useMatrixStore((s) => s.addDefect);
  const repairMatrix = useMatrixStore((s) => s.repairMatrix);
  const batches = useRepairStore((s) => s.batches);
  const createBatch = useRepairStore((s) => s.createBatch);
  const completeBatch = useRepairStore((s) => s.completeBatch);
  const removeBatchItems = useRepairStore((s) => s.removeBatchItems);
  const pushToast = useUiStore((s) => s.pushToast);

  const { draft, patch, reset, savedAt, existed } = useLocalDraft<DefectFormState>(
    DRAFT_KEYS.defectBoard,
    INITIAL_FORM,
  );
  const batchDraft = useLocalDraft<BatchDraft>(DRAFT_KEYS.repairBatch, INITIAL_BATCH_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [completingId, setCompletingId] = useState('');
  const [removingId, setRemovingId] = useState('');
  /** 每个批次当前待处理的冲突列表（整批完成被拦下后展示） */
  const [conflictMap, setConflictMap] = useState<Record<string, BatchConflict[]>>({});

  useEffect(() => {
    if (!draft.matrixId && matrices.length > 0) patch({ matrixId: matrices[0].id });
  }, [draft.matrixId, matrices, patch]);

  const pendingRepair = useMemo(
    () =>
      matrices
        .filter((m) => m.availability !== '可用')
        .sort(
          (a, b) => (a.availability === b.availability ? 0 : a.availability === '停用' ? -1 : 1),
        ),
    [matrices],
  );

  /** 进行中批次占用的字模 id，待补刻清单中这些字模不可勾选 */
  const busyIds = useMemo(() => selectBusyMatrixIds(batches), [batches]);
  const selectedSet = useMemo(() => new Set(batchDraft.draft.selectedIds), [batchDraft.draft.selectedIds]);

  // 清理勾选中的失效项：已被恢复 / 删除 / 已进入其它进行中批次的字模自动移出草稿
  const selectedIds = batchDraft.draft.selectedIds;
  const patchBatchDraft = batchDraft.patch;
  useEffect(() => {
    const pendingIds = new Set(pendingRepair.map((m) => m.id));
    const next = selectedIds.filter((id) => pendingIds.has(id) && !busyIds.has(id));
    if (next.length !== selectedIds.length) {
      patchBatchDraft({ selectedIds: next });
    }
  }, [pendingRepair, busyIds, selectedIds, patchBatchDraft]);

  const toggleSelected = (id: string) => {
    const next = selectedSet.has(id)
      ? batchDraft.draft.selectedIds.filter((x) => x !== id)
      : [...batchDraft.draft.selectedIds, id];
    batchDraft.patch({ selectedIds: next });
    setBatchErrors((e) => {
      if (!e.matrixIds) return e;
      const { matrixIds: _omit, ...rest } = e;
      return rest;
    });
  };

  const activeBatches = useMemo(() => batches.filter((b) => b.status === '进行中'), [batches]);
  const doneBatches = useMemo(() => batches.filter((b) => b.status === '已完成'), [batches]);

  const latestDefectOf = (matrixId: string) =>
    [...defects]
      .filter((d) => d.matrixId === matrixId)
      .sort(
        (a, b) =>
          SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || (a.createdAt < b.createdAt ? 1 : -1),
      )[0];

  const typeStats = useMemo(() => countBy(defects, (d) => d.defectType), [defects]);
  const sortedDefects = useMemo(
    () => [...defects].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [defects],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const input: DefectInput = {
      matrixId: draft.matrixId,
      defectType: draft.defectType,
      severity: draft.severity,
      foundDate: draft.foundDate,
      handling: draft.handling,
      availability: draft.availability,
      operator: draft.operator,
      note: draft.note,
    };
    const next = validateDefectInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('缺损登记未通过校验，请按提示修正', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const row = await addDefect(input);
      pushToast(
        row.availability === '可用'
          ? `已登记「${row.character}」缺损，字模保持可用`
          : `已登记「${row.character}」缺损，字模转为${row.availability}并进入补刻清单`,
      );
      patch({ handling: '', note: '' });
      setErrors({});
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '缺损登记失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateBatch = async (e: FormEvent) => {
    e.preventDefault();
    const input = {
      matrixIds: batchDraft.draft.selectedIds,
      owner: batchDraft.draft.owner,
      plannedDate: batchDraft.draft.plannedDate,
      note: batchDraft.draft.note,
    };
    const next: Record<string, string> = {};
    if (input.matrixIds.length === 0) next.matrixIds = '请至少勾选一枚字模';
    if (!input.owner.trim()) next.owner = '请填写负责人';
    if (!input.plannedDate.trim()) next.plannedDate = '请填写计划完成日期';
    setBatchErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('补刻批次信息未填完整，请按提示修正', 'warn');
      return;
    }
    setCreatingBatch(true);
    try {
      const row = await createBatch(input);
      pushToast(`已建立补刻批次 ${row.code}，共 ${row.items.length} 枚字模`);
      batchDraft.reset();
      setBatchErrors({});
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '建立补刻批次失败', 'error');
    } finally {
      setCreatingBatch(false);
    }
  };

  const handleCompleteBatch = async (batchId: string, operator: string) => {
    setCompletingId(batchId);
    try {
      await completeBatch(batchId, operator);
      setConflictMap((m) => {
        const { [batchId]: _omit, ...rest } = m;
        return rest;
      });
      const batch = batches.find((b) => b.id === batchId);
      pushToast(`批次 ${batch?.code ?? ''} 整批完成，${batch?.items.length ?? 0} 枚字模已恢复可用`);
    } catch (err) {
      if (err instanceof RepairBatchConflictError) {
        setConflictMap((m) => ({ ...m, [batchId]: err.conflicts }));
        pushToast('整批完成已停下：有字模被单独恢复，请先处理冲突', 'warn');
      } else {
        pushToast(err instanceof Error ? err.message : '整批完成失败', 'error');
      }
    } finally {
      setCompletingId('');
    }
  };

  const handleRemoveConflicts = async (batchId: string) => {
    const conflicts = conflictMap[batchId] ?? [];
    setRemovingId(batchId);
    try {
      await removeBatchItems(
        batchId,
        conflicts.map((c) => c.matrixId),
      );
      const batch = batches.find((b) => b.id === batchId);
      const stillBusy = batch ? batch.items.length - conflicts.length : 0;
      setConflictMap((m) => {
        const { [batchId]: _omit, ...rest } = m;
        return rest;
      });
      pushToast(
        stillBusy > 0
          ? `已移出 ${conflicts.length} 枚冲突字模，剩余 ${stillBusy} 枚可再次整批完成`
          : `已移出全部 ${conflicts.length} 枚冲突字模，批次已清空并关闭`,
        'warn',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '移出冲突字模失败', 'error');
    } finally {
      setRemovingId('');
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="defect-board-title">
            缺损登记
          </h2>
          <p className="mt-sub">
            选字模与缺损类型、程度，提交后字模自动停用并进入待补刻清单；可勾选多枚字模建立补刻批次，整批完成后一起恢复可用。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="defect-total">
            缺损记录 {defects.length} 条
          </span>
          <span className="mt-chip border-seal/40 text-seal" data-testid="defect-pending">
            待处理 {pendingRepair.length} 枚
          </span>
          <span className="mt-chip border-brass/40 text-brass" data-testid="active-batch-count">
            进行中批次 {activeBatches.length} 个
          </span>
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">登记一条缺损</h3>
          <span className="mt-sub" data-testid="defect-draft-status">
            {existed ? `草稿已恢复 · ${savedAt || '—'}` : `草稿自动保存 ${savedAt || '—'}`}
          </span>
        </div>
        <form className="space-y-3 px-4 py-4" onSubmit={handleSubmit} data-testid="defect-form">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="mt-label" htmlFor="defect-matrix-select">
                字模
              </label>
              <select
                id="defect-matrix-select"
                data-testid="defect-matrix-select"
                className="mt-input"
                value={draft.matrixId}
                onChange={(e) => patch({ matrixId: e.target.value })}
              >
                <option value="">请选择字模</option>
                {matrices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.character} · {m.code} · {m.font}/{m.sizeName} · {m.material} · {m.availability}
                  </option>
                ))}
              </select>
              {errors.matrixId ? (
                <p className="mt-error" data-testid="error-matrixId">
                  {errors.matrixId}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="defect-type-select">
                缺损类型
              </label>
              <select
                id="defect-type-select"
                data-testid="defect-type-select"
                className="mt-input"
                value={draft.defectType}
                onChange={(e) => patch({ defectType: e.target.value as DefectType })}
              >
                {DEFECT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mt-label" htmlFor="defect-severity-select">
                程度
              </label>
              <select
                id="defect-severity-select"
                data-testid="defect-severity-select"
                className="mt-input"
                value={draft.severity}
                onChange={(e) => patch({ severity: e.target.value as DefectSeverity })}
              >
                {DEFECT_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mt-label" htmlFor="defect-date-input">
                发现日期
              </label>
              <input
                id="defect-date-input"
                data-testid="defect-date-input"
                type="date"
                className="mt-input"
                value={draft.foundDate}
                onChange={(e) => patch({ foundDate: e.target.value })}
              />
              {errors.foundDate ? (
                <p className="mt-error" data-testid="error-foundDate">
                  {errors.foundDate}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="defect-availability-select">
                可用性结论
              </label>
              <select
                id="defect-availability-select"
                data-testid="defect-availability-select"
                className="mt-input"
                value={draft.availability}
                onChange={(e) => patch({ availability: e.target.value as MatrixAvailability })}
              >
                {MATRIX_AVAILABILITIES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <p className="mt-hint">选择「停用」或「待补刻」时提交后会自动停用该字模</p>
            </div>
            <div>
              <label className="mt-label" htmlFor="defect-operator-input">
                登记人
              </label>
              <input
                id="defect-operator-input"
                data-testid="defect-operator-input"
                className="mt-input"
                placeholder="例：陈之安"
                value={draft.operator}
                onChange={(e) => patch({ operator: e.target.value })}
              />
              {errors.operator ? (
                <p className="mt-error" data-testid="error-operator">
                  {errors.operator}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-2">
              <label className="mt-label" htmlFor="defect-handling-input">
                处理方式
              </label>
              <input
                id="defect-handling-input"
                data-testid="defect-handling-input"
                className="mt-input"
                placeholder="例：字面中部磨损，停用并列入补刻"
                value={draft.handling}
                onChange={(e) => patch({ handling: e.target.value })}
              />
              {errors.handling ? (
                <p className="mt-error" data-testid="error-handling">
                  {errors.handling}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-3">
              <label className="mt-label" htmlFor="defect-note-input">
                备注
              </label>
              <input
                id="defect-note-input"
                data-testid="defect-note-input"
                className="mt-input"
                placeholder="例：磨损深度约 0.15mm"
                value={draft.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="mt-btn mt-btn-primary" data-testid="submit-defect" disabled={submitting}>
              {submitting ? '登记中…' : '登记缺损'}
            </button>
            <button
              type="button"
              className="mt-btn"
              data-testid="reset-defect-draft"
              onClick={() => {
                reset();
                setErrors({});
                pushToast('已清空缺损登记草稿', 'warn');
              }}
            >
              清空草稿
            </button>
            <span className="mt-hint">类型分布：{DEFECT_TYPES.map((t) => `${t} ${typeStats[t] ?? 0}`).join(' · ')}</span>
          </div>
        </form>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">待补刻清单</h3>
            <span className="mt-sub">勾选多枚字模建立批次；已在未完成批次中的字模不可重复选择</span>
          </div>
          {pendingRepair.length === 0 ? (
            <div className="px-4 py-4">
              <EmptyState title="没有停用或待补刻的字模" description="所有字模均处于可用状态。" testId="pending-empty" />
            </div>
          ) : (
            <ul className="divide-y divide-paper-line" data-testid="pending-list">
              {pendingRepair.map((m) => {
                const d = latestDefectOf(m.id);
                const inBatch = busyIds.has(m.id);
                const checked = selectedSet.has(m.id);
                return (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-[#a8352a]"
                        data-testid={`pending-check-${m.id}`}
                        checked={checked}
                        disabled={inBatch}
                        onChange={() => toggleSelected(m.id)}
                        aria-label={`勾选字模 ${m.character}`}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-song text-lg text-ink">{m.character}</span>
                          <span className="text-[11px] text-ink-mute">{m.code}</span>
                          <span className="mt-chip">{m.availability}</span>
                          {inBatch ? (
                            <span className="mt-chip border-brass/50 bg-brass-pale text-brass" data-testid={`pending-inbatch-${m.id}`}>
                              已在批次中
                            </span>
                          ) : null}
                        </div>
                        {d ? (
                          <DefectBadge
                            type={d.defectType}
                            severity={d.severity}
                            testId={`pending-defect-${m.id}`}
                          />
                        ) : (
                          <span className="text-[11px] text-ink-mute">暂无缺损记录</span>
                        )}
                        {d ? <p className="text-[11px] text-ink-soft">{d.handling}</p> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link className="mt-btn" to={`/matrices/${m.id}`} data-testid={`pending-detail-${m.id}`}>
                        查看详情
                      </Link>
                      {!inBatch ? (
                        <button
                          type="button"
                          className="mt-btn mt-btn-primary"
                          data-testid={`repair-${m.id}`}
                          onClick={async () => {
                            await repairMatrix(m.id, draft.operator || '补刻工 陈之安');
                            pushToast(`「${m.character}」补刻完成，恢复可用`);
                          }}
                        >
                          单独补刻完成
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">建立补刻批次</h3>
            <span className="mt-sub" data-testid="batch-draft-status">
              已勾选 {batchDraft.draft.selectedIds.length} 枚
            </span>
          </div>
          <form className="space-y-3 px-4 py-4" onSubmit={handleCreateBatch} data-testid="batch-form">
            {batchDraft.draft.selectedIds.length > 0 ? (
              <div className="flex flex-wrap gap-1.5" data-testid="batch-selected-preview">
                {batchDraft.draft.selectedIds.map((id) => {
                  const m = matrices.find((x) => x.id === id);
                  if (!m) return null;
                  return (
                    <span key={id} className="mt-chip border-brass/40">
                      <span className="font-song text-sm">{m.character}</span>
                      <button
                        type="button"
                        className="text-ink-mute hover:text-seal"
                        data-testid={`batch-unselect-${id}`}
                        onClick={() => toggleSelected(id)}
                        aria-label={`取消勾选 ${m.character}`}
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-ink-mute" data-testid="batch-selected-empty">
                请在左侧待补刻清单中勾选字模（已在未完成批次中的字模不可勾选）。
              </p>
            )}
            {batchErrors.matrixIds ? (
              <p className="mt-error" data-testid="error-batch-matrixIds">
                {batchErrors.matrixIds}
              </p>
            ) : null}
            <div>
              <label className="mt-label" htmlFor="batch-owner-input">
                负责人
              </label>
              <input
                id="batch-owner-input"
                data-testid="batch-owner-input"
                className="mt-input"
                placeholder="例：补刻师傅 周介庵"
                value={batchDraft.draft.owner}
                onChange={(e) => batchDraft.patch({ owner: e.target.value })}
              />
              {batchErrors.owner ? (
                <p className="mt-error" data-testid="error-batch-owner">
                  {batchErrors.owner}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="batch-planned-input">
                计划完成日期
              </label>
              <input
                id="batch-planned-input"
                data-testid="batch-planned-input"
                type="date"
                className="mt-input"
                value={batchDraft.draft.plannedDate}
                onChange={(e) => batchDraft.patch({ plannedDate: e.target.value })}
              />
              {batchErrors.plannedDate ? (
                <p className="mt-error" data-testid="error-batch-planned">
                  {batchErrors.plannedDate}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="batch-note-input">
                批次备注
              </label>
              <input
                id="batch-note-input"
                data-testid="batch-note-input"
                className="mt-input"
                placeholder="例：受潮变形字模集中补刻，完成后整盘复测"
                value={batchDraft.draft.note}
                onChange={(e) => batchDraft.patch({ note: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className="mt-btn mt-btn-primary"
                data-testid="submit-batch"
                disabled={creatingBatch}
              >
                {creatingBatch ? '建立中…' : '建立补刻批次'}
              </button>
              <button
                type="button"
                className="mt-btn"
                data-testid="reset-batch-draft"
                onClick={() => {
                  batchDraft.reset();
                  setBatchErrors({});
                }}
              >
                清空勾选
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">进行中的补刻批次</h3>
            <span className="mt-sub">整批完成时字模一起恢复可用</span>
          </div>
          {activeBatches.length === 0 ? (
            <div className="px-4 py-4">
              <EmptyState
                title="没有进行中的补刻批次"
                description="在待补刻清单勾选多枚字模，填写负责人与计划日期即可建批。"
                testId="active-batch-empty"
              />
            </div>
          ) : (
            <ul className="divide-y divide-paper-line" data-testid="active-batch-list">
              {activeBatches.map((b) => (
                <RepairBatchCard
                  key={b.id}
                  batch={b}
                  conflicts={conflictMap[b.id] ?? []}
                  completing={completingId === b.id}
                  removing={removingId === b.id}
                  onComplete={(operator) => handleCompleteBatch(b.id, operator)}
                  onDismissConflict={() =>
                    setConflictMap((m) => {
                      const { [b.id]: _omit, ...rest } = m;
                      return rest;
                    })
                  }
                  onRemoveConflicts={() => handleRemoveConflicts(b.id)}
                  testId={`active-batch-${b.id}`}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">已完成的补刻批次</h3>
            <span className="mt-sub">收尾记录可在各字模缺损历史中查看</span>
          </div>
          {doneBatches.length === 0 ? (
            <div className="px-4 py-4">
              <EmptyState title="暂无已完成批次" description="整批完成的补刻批次会归档到这里。" testId="done-batch-empty" />
            </div>
          ) : (
            <ul className="divide-y divide-paper-line" data-testid="done-batch-list">
              {doneBatches.map((b) => (
                <RepairBatchCard
                  key={b.id}
                  batch={b}
                  conflicts={[]}
                  completing={false}
                  removing={false}
                  onComplete={() => undefined}
                  onDismissConflict={() => undefined}
                  onRemoveConflicts={() => undefined}
                  testId={`done-batch-${b.id}`}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">缺损记录</h3>
          <span className="mt-sub">按登记时间倒序</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full" data-testid="defect-table">
            <thead className="border-b border-paper-line bg-paper/60">
              <tr>
                <th className="mt-th">字模</th>
                <th className="mt-th">类型 / 程度</th>
                <th className="mt-th">发现日期</th>
                <th className="mt-th">处理方式</th>
                <th className="mt-th">登记人</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {sortedDefects.length === 0 ? (
                <tr>
                  <td className="mt-td text-ink-mute" colSpan={5}>
                    暂无缺损记录。
                  </td>
                </tr>
              ) : (
                sortedDefects.map((d) => (
                  <tr key={d.id} data-testid={`defect-row-${d.id}`}>
                    <td className="mt-td">
                      <Link className="font-song text-base text-ink hover:text-seal" to={`/matrices/${d.matrixId}`}>
                        {d.character}
                      </Link>
                      <div className="text-[11px] text-ink-mute">{dash(d.matrixCode)}</div>
                    </td>
                    <td className="mt-td">
                      <DefectBadge
                        type={d.defectType}
                        severity={d.severity}
                        availability={d.availability}
                        testId={`defect-row-badge-${d.id}`}
                      />
                    </td>
                    <td className="mt-td">{formatDate(d.foundDate)}</td>
                    <td className="mt-td">{d.handling}</td>
                    <td className="mt-td">{dash(d.operator)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
