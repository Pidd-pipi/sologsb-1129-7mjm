import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import DefectBadge from '../components/common/DefectBadge';
import EmptyState from '../components/common/EmptyState';
import RepairBatchCard from '../components/common/RepairBatchCard';
import { DRAFT_KEYS, useLocalDraft } from '../hooks/useLocalDraft';
import { useMatrixStore } from '../stores/matrixStore';
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
import type { RepairBatch } from '../types/repairBatch';
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

interface BatchFormState {
  owner: string;
  plannedDate: string;
  note: string;
}

const INITIAL_BATCH_FORM: BatchFormState = {
  owner: '',
  plannedDate: todayStr(),
  note: '',
};

/** `/defects` 缺损登记：提交后自动停用字模并进入待补刻清单；可勾选多枚建立补刻批次整批收尾 */
export default function DefectBoard() {
  const matrices = useMatrixStore((s) => s.matrices);
  const defects = useMatrixStore((s) => s.defects);
  const repairBatches = useMatrixStore((s) => s.repairBatches);
  const addDefect = useMatrixStore((s) => s.addDefect);
  const repairMatrix = useMatrixStore((s) => s.repairMatrix);
  const createRepairBatch = useMatrixStore((s) => s.createRepairBatch);
  const pushToast = useUiStore((s) => s.pushToast);

  const { draft, patch, reset, savedAt, existed } = useLocalDraft<DefectFormState>(
    DRAFT_KEYS.defectBoard,
    INITIAL_FORM,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchForm, setBatchForm] = useState<BatchFormState>(INITIAL_BATCH_FORM);
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const [creatingBatch, setCreatingBatch] = useState(false);

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

  const openBatches = useMemo(
    () => repairBatches.filter((b) => b.status === '进行中'),
    [repairBatches],
  );
  const finishedBatches = useMemo(
    () => repairBatches.filter((b) => b.status === '已完成'),
    [repairBatches],
  );

  /** 字模 id → 所在进行中批次编号（已在未完成批次里的字模不能再次选中） */
  const lockedBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of openBatches) {
      for (const mid of b.matrixIds) if (!map.has(mid)) map.set(mid, b.code);
    }
    return map;
  }, [openBatches]);

  const selectablePending = useMemo(
    () => pendingRepair.filter((m) => !lockedBy.has(m.id)),
    [pendingRepair, lockedBy],
  );

  /** 进行中批次内当前已被单独恢复的字模 id（整批收尾冲突项） */
  const conflictsOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const b of openBatches) {
      const set = new Set<string>();
      for (const mid of b.matrixIds) {
        const m = matrices.find((x) => x.id === mid);
        if (!m || m.availability === '可用') set.add(mid);
      }
      map.set(b.id, set);
    }
    return map;
  }, [openBatches, matrices]);

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

  const toggleSelect = (id: string) => {
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const allSelectableChecked =
    selectablePending.length > 0 && selectablePending.every((m) => selectedIds.includes(m.id));

  const toggleSelectAll = () => {
    setSelectedIds((cur) =>
      allSelectableChecked ? cur.filter((id) => !selectablePending.some((m) => m.id === id)) : selectablePending.map((m) => m.id),
    );
  };

  const selectedMatrices = useMemo(
    () => selectedIds.map((id) => matrices.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)),
    [selectedIds, matrices],
  );

  const handleCreateBatch = async (e: FormEvent) => {
    e.preventDefault();
    const items = selectedMatrices.map((m) => ({
      matrixId: m.id,
      character: m.character,
      matrixCode: m.code,
    }));
    const next: Record<string, string> = {};
    if (items.length === 0) next.items = '请至少勾选一枚需要补刻的字模';
    if (!batchForm.owner.trim()) next.owner = '请填写负责人';
    if (!batchForm.plannedDate.trim()) next.plannedDate = '请填写计划日期';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(batchForm.plannedDate)) next.plannedDate = '日期格式需为 YYYY-MM-DD';
    setBatchErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('补刻批次信息不完整，请按提示修正', 'warn');
      return;
    }
    setCreatingBatch(true);
    try {
      const batch = await createRepairBatch({
        items,
        owner: batchForm.owner,
        plannedDate: batchForm.plannedDate,
        note: batchForm.note,
      });
      pushToast(`已建立批次 ${batch.code}，共 ${batch.items.length} 枚字模`);
      setSelectedIds([]);
      setBatchForm(INITIAL_BATCH_FORM);
      setBatchErrors({});
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '建立补刻批次失败', 'error');
    } finally {
      setCreatingBatch(false);
    }
  };

  const renderBatchList = (list: RepairBatch[], testId: string, emptyText: string) =>
    list.length === 0 ? (
      <p className="px-4 py-4 text-xs text-ink-mute" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    ) : (
      <ul className="space-y-2 px-4 py-3" data-testid={testId}>
        {list.map((b) => (
          <RepairBatchCard key={b.id} batch={b} conflictIds={conflictsOf.get(b.id) ?? new Set()} testId={`batch-${b.id}`} />
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="defect-board-title">
            缺损登记
          </h2>
          <p className="mt-sub">
            选字模与缺损类型、程度，提交后字模自动停用并进入待补刻清单；可勾选多枚建立补刻批次，整批完成后统一恢复可用。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="defect-total">
            缺损记录 {defects.length} 条
          </span>
          <span className="mt-chip border-seal/40 text-seal" data-testid="defect-pending">
            待处理 {pendingRepair.length} 枚
          </span>
          <span className="mt-chip border-brass/40 text-brass" data-testid="batch-open-count">
            进行中批次 {openBatches.length} 个
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

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">待补刻清单</h3>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-soft" data-testid="select-all-pending">
              <input
                type="checkbox"
                className="mt-check"
                checked={allSelectableChecked}
                disabled={selectablePending.length === 0}
                onChange={toggleSelectAll}
                data-testid="select-all-pending-input"
              />
              全选可选（{selectablePending.length} 枚可勾选）
            </label>
          </div>
          {pendingRepair.length === 0 ? (
            <div className="px-4 py-4">
              <EmptyState title="没有停用或待补刻的字模" description="所有字模均处于可用状态。" testId="pending-empty" />
            </div>
          ) : (
            <ul className="divide-y divide-paper-line" data-testid="pending-list">
              {pendingRepair.map((m) => {
                const d = latestDefectOf(m.id);
                const lockedCode = lockedBy.get(m.id);
                const checked = selectedIds.includes(m.id);
                return (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-check mt-1"
                        checked={checked}
                        disabled={Boolean(lockedCode)}
                        onChange={() => toggleSelect(m.id)}
                        aria-label={`勾选字模 ${m.character}`}
                        data-testid={`pending-check-${m.id}`}
                      />
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-song text-lg text-ink">{m.character}</span>
                          <span className="text-[11px] text-ink-mute">{m.code}</span>
                          <span className="mt-chip">{m.availability}</span>
                          {lockedCode ? (
                            <span
                              className="mt-chip border-brass/40 text-brass"
                              data-testid={`pending-locked-${m.id}`}
                            >
                              批次 {lockedCode} 进行中
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
                      <button
                        type="button"
                        className="mt-btn mt-btn-primary"
                        data-testid={`repair-${m.id}`}
                        onClick={async () => {
                          await repairMatrix(m.id, draft.operator || '补刻工 陈之安');
                          pushToast(`「${m.character}」补刻完成，恢复可用`);
                        }}
                      >
                        单枚补刻完成
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <form
            className="space-y-2 border-t border-paper-line bg-paper/40 px-4 py-3"
            onSubmit={handleCreateBatch}
            data-testid="batch-create-form"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-song text-sm font-semibold text-ink">
                建立补刻批次{selectedMatrices.length > 0 ? `（已选 ${selectedMatrices.length} 枚）` : ''}
              </h4>
              {selectedMatrices.length > 0 ? (
                <div className="flex flex-wrap gap-1" data-testid="selected-preview">
                  {selectedMatrices.map((m) => (
                    <span key={m.id} className="mt-chip border-brass/40 text-brass">
                      {m.character}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="mt-label" htmlFor="batch-owner-input">
                  负责人
                </label>
                <input
                  id="batch-owner-input"
                  className="mt-input"
                  placeholder="例：陈之安"
                  value={batchForm.owner}
                  onChange={(e) => setBatchForm((p) => ({ ...p, owner: e.target.value }))}
                  data-testid="batch-owner-input"
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
                  type="date"
                  className="mt-input"
                  value={batchForm.plannedDate}
                  onChange={(e) => setBatchForm((p) => ({ ...p, plannedDate: e.target.value }))}
                  data-testid="batch-planned-input"
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
                  className="mt-input"
                  placeholder="例：本周统一补刻"
                  value={batchForm.note}
                  onChange={(e) => setBatchForm((p) => ({ ...p, note: e.target.value }))}
                  data-testid="batch-note-input"
                />
              </div>
            </div>
            {batchErrors.items ? (
              <p className="mt-error" data-testid="error-batch-items">
                {batchErrors.items}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className="mt-btn mt-btn-primary"
                disabled={creatingBatch}
                data-testid="batch-create-submit"
              >
                {creatingBatch ? '建批中…' : '建立补刻批次'}
              </button>
              {selectedIds.length > 0 ? (
                <button
                  type="button"
                  className="mt-btn"
                  onClick={() => setSelectedIds([])}
                  data-testid="batch-clear-selection"
                >
                  清除勾选
                </button>
              ) : null}
              <span className="mt-hint">已在进行中批次里的字模会锁定，不能再次选中</span>
            </div>
          </form>
        </div>

        <div className="mt-panel">
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
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">进行中的补刻批次</h3>
            <span className="mt-sub">整批完成后字模一起恢复可用</span>
          </div>
          {renderBatchList(openBatches, 'batch-open-list', '暂无进行中的补刻批次，可在上方待补刻清单勾选字模建批。')}
        </div>
        <div className="mt-panel">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">已完成的补刻批次</h3>
            <span className="mt-sub">每枚字模各留一条补刻收尾记录</span>
          </div>
          {renderBatchList(finishedBatches, 'batch-finished-list', '暂无已完成的补刻批次。')}
        </div>
      </section>
    </div>
  );
}
