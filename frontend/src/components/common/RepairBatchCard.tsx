import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMatrixStore } from '../../stores/matrixStore';
import { useUiStore } from '../../stores/uiStore';
import type { RepairBatch } from '../../types/repairBatch';
import { BatchConflictError } from '../../types/repairBatch';
import { compareDate, formatDate, todayStr } from '../../utils/format';

interface RepairBatchCardProps {
  batch: RepairBatch;
  /** 批次内当前已不在停用 / 待补刻状态的字模 id（冲突项） */
  conflictIds: Set<string>;
  testId?: string;
}

/** 补刻批次卡片：进行中可整批收尾 / 处理冲突；已完成展示收尾信息 */
export default function RepairBatchCard({ batch, conflictIds, testId = 'repair-batch' }: RepairBatchCardProps) {
  const matrices = useMatrixStore((s) => s.matrices);
  const completeRepairBatch = useMatrixStore((s) => s.completeRepairBatch);
  const resolveRepairConflicts = useMatrixStore((s) => s.resolveRepairConflicts);
  const reload = useMatrixStore((s) => s.load);
  const pushToast = useUiStore((s) => s.pushToast);

  const [finishOperator, setFinishOperator] = useState(batch.owner);
  const [busy, setBusy] = useState(false);

  const isOpen = batch.status === '进行中';
  const overdue = isOpen && compareDate(batch.plannedDate, todayStr()) < 0;
  const availabilityOf = (matrixId: string) => matrices.find((m) => m.id === matrixId)?.availability;

  const handleComplete = async () => {
    if (!(finishOperator || '').trim()) {
      pushToast('请填写收尾负责人', 'warn');
      return;
    }
    setBusy(true);
    try {
      await completeRepairBatch(batch.id, finishOperator);
      pushToast(`批次 ${batch.code} 已整批完成，${batch.items.length} 枚字模恢复可用`);
    } catch (err) {
      if (err instanceof BatchConflictError) {
        pushToast(err.message, 'error');
        // 冲突可能来自其它标签页的单独恢复操作，重新读库以刷新冲突标记
        await reload();
      } else {
        pushToast(err instanceof Error ? err.message : '整批完成失败', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    setBusy(true);
    try {
      const { batch: next, removedCount } = await resolveRepairConflicts(batch.id, finishOperator);
      if (next.status === '已完成') {
        pushToast(`批次 ${batch.code} 中 ${removedCount} 枚冲突字模已移出，批次无剩余字模，已自动收尾`, 'warn');
      } else {
        pushToast(`已移出 ${removedCount} 枚冲突字模，剩余 ${next.items.length} 枚可整批完成`, 'warn');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '处理冲突失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded-lg border border-paper-line bg-white/60 px-3 py-3"
      data-testid={testId}
      data-batch-id={batch.id}
      data-batch-status={batch.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`mt-chip ${isOpen ? 'border-brass/40 text-brass' : 'border-jade/40 text-jade'}`}
              data-testid={`${testId}-status`}
            >
              {batch.status}
            </span>
            <span className="font-song text-sm font-semibold text-ink" data-testid={`${testId}-code`}>
              {batch.code}
            </span>
            <span className="text-[11px] text-ink-mute" data-testid={`${testId}-count`}>
              {batch.items.length} 枚
            </span>
            {overdue ? (
              <span className="mt-chip border-seal/40 text-seal" data-testid={`${testId}-overdue`}>
                已过计划日期
              </span>
            ) : null}
          </div>
          <p className="text-[11px] text-ink-soft" data-testid={`${testId}-meta`}>
            负责人 {batch.owner} · 计划 {formatDate(batch.plannedDate)}
            {isOpen
              ? ` · 建批 ${batch.createdAt.slice(0, 10)}`
              : ` · 完成人 ${batch.completedBy} · 完成 ${formatDate(batch.completedDate)}`}
          </p>
          {batch.note ? <p className="text-[11px] text-ink-mute">{batch.note}</p> : null}
        </div>
      </div>

      <ul className="mt-2 flex flex-wrap gap-1.5" data-testid={`${testId}-items`}>
        {batch.items.map((item) => {
          const conflict = conflictIds.has(item.matrixId);
          return (
            <li key={item.matrixId}>
              <Link
                to={`/matrices/${item.matrixId}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                  conflict
                    ? 'border-seal/50 bg-seal-pale text-seal'
                    : 'border-paper-line bg-paper/70 text-ink-soft'
                }`}
                data-testid={`${testId}-item-${item.matrixId}`}
                data-conflict={conflict ? 'true' : 'false'}
              >
                <span className="font-song text-sm">{item.character}</span>
                <span className="text-ink-mute">{item.matrixCode}</span>
                {conflict ? <span>已{availabilityOf(item.matrixId) ?? '处理'}</span> : null}
              </Link>
            </li>
          );
        })}
        {batch.items.length === 0 ? <li className="text-[11px] text-ink-mute">批次内已无字模</li> : null}
      </ul>

      {isOpen ? (
        <div className="mt-3 space-y-2 border-t border-paper-line pt-2">
          {conflictIds.size > 0 ? (
            <p className="rounded border border-seal/40 bg-seal-pale px-2 py-1.5 text-[11px] text-seal" data-testid={`${testId}-conflict-tip`}>
              检测到 {conflictIds.size} 枚字模已被单独恢复可用，整批完成已暂停。请先「移出冲突项」，
              剩余字模再统一收尾；已恢复字模的补刻状态以单独处理为准。
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mt-label" htmlFor={`${batch.id}-finish-operator`}>
                收尾负责人
              </label>
              <input
                id={`${batch.id}-finish-operator`}
                className="mt-input"
                value={finishOperator}
                onChange={(e) => setFinishOperator(e.target.value)}
                data-testid={`${testId}-operator`}
              />
            </div>
            <button
              type="button"
              className="mt-btn mt-btn-primary"
              disabled={busy || conflictIds.size > 0}
              onClick={handleComplete}
              data-testid={`${testId}-complete`}
            >
              {busy ? '处理中…' : '整批完成，恢复可用'}
            </button>
            {conflictIds.size > 0 ? (
              <button
                type="button"
                className="mt-btn border-seal/50 text-seal"
                disabled={busy}
                onClick={handleResolve}
                data-testid={`${testId}-resolve`}
              >
                移出 {conflictIds.size} 枚冲突项
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
