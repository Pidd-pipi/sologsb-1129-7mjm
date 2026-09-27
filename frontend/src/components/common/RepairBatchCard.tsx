import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BatchConflict } from '../../stores/repairStore';
import type { RepairBatch } from '../../types/repair';
import { compareDate, formatDate, todayStr } from '../../utils/format';

export interface RepairBatchCardProps {
  batch: RepairBatch;
  /** 整批完成前检测到的冲突（仅进行中批次可能有） */
  conflicts: BatchConflict[];
  completing: boolean;
  removing: boolean;
  onComplete: (operator: string) => void;
  onDismissConflict: () => void;
  onRemoveConflicts: () => void;
  testId?: string;
}

const STATUS_STYLE: Record<string, string> = {
  进行中: 'border-brass/50 bg-brass-pale text-brass',
  已完成: 'border-jade/50 bg-jade-pale text-jade',
};

/** 补刻批次卡片：负责人、计划日期、字模清单、整批完成与冲突处理 */
export default function RepairBatchCard({
  batch,
  conflicts,
  completing,
  removing,
  onComplete,
  onDismissConflict,
  onRemoveConflicts,
  testId = 'repair-batch-card',
}: RepairBatchCardProps) {
  const [operator, setOperator] = useState(batch.owner);
  const overdue =
    batch.status === '进行中' && batch.plannedDate && compareDate(batch.plannedDate, todayStr()) < 0;

  return (
    <li className="space-y-3 px-4 py-3" data-testid={testId} data-batch-id={batch.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-song text-sm font-semibold text-ink">{batch.code}</span>
          <span
            className={`mt-chip ${STATUS_STYLE[batch.status] ?? ''}`}
            data-testid={`${testId}-status`}
          >
            {batch.status}
          </span>
          <span className="text-[11px] text-ink-mute" data-testid={`${testId}-owner`}>
            负责人：{batch.owner}
          </span>
          <span className="text-[11px] text-ink-mute" data-testid={`${testId}-planned`}>
            计划 {formatDate(batch.plannedDate)}
            {overdue ? <span className="ml-1 text-seal">（已逾期）</span> : null}
          </span>
          {batch.status === '已完成' ? (
            <span className="text-[11px] text-jade" data-testid={`${testId}-completed`}>
              完成于 {formatDate(batch.completedDate)}
            </span>
          ) : null}
        </div>
        <span className="mt-chip" data-testid={`${testId}-count`}>
          {batch.items.length} 枚
        </span>
      </div>

      <ul className="flex flex-wrap gap-1.5" data-testid={`${testId}-items`}>
        {batch.items.map((item) => (
          <li key={item.matrixId}>
            <Link
              to={`/matrices/${item.matrixId}`}
              className="mt-chip hover:border-seal hover:text-seal"
              data-testid={`${testId}-item-${item.matrixId}`}
              title={item.matrixCode}
            >
              <span className="font-song text-sm">{item.character}</span>
              <span className="text-ink-mute">{item.availability}</span>
            </Link>
          </li>
        ))}
      </ul>

      {batch.note ? <p className="text-[11px] text-ink-soft">备注：{batch.note}</p> : null}

      {conflicts.length > 0 ? (
        <div
          className="space-y-2 rounded border border-seal/50 bg-seal-pale/60 px-3 py-2"
          data-testid={`${testId}-conflict`}
          role="alert"
        >
          <p className="text-xs font-semibold text-seal">
            整批完成已停下：以下 {conflicts.length} 枚字模在提交前已被人单独处理，请先处理冲突后再整批完成。
          </p>
          <ul className="space-y-0.5 text-[11px] text-seal">
            {conflicts.map((c) => (
              <li key={c.matrixId} data-testid={`${testId}-conflict-${c.matrixId}`}>
                <span className="font-song">{c.character}</span>（{c.matrixCode}）· {c.reason}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="mt-btn mt-btn-primary"
              data-testid={`${testId}-remove-conflicts`}
              disabled={removing}
              onClick={onRemoveConflicts}
            >
              {removing ? '移出中…' : `移出 ${conflicts.length} 枚冲突字模`}
            </button>
            <button
              type="button"
              className="mt-btn"
              data-testid={`${testId}-dismiss-conflict`}
              onClick={onDismissConflict}
            >
              暂不处理
            </button>
          </div>
        </div>
      ) : null}

      {batch.status === '进行中' ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-paper-line pt-2">
          <div>
            <label className="mt-label" htmlFor={`${batch.id}-operator`}>
              收尾登记人
            </label>
            <input
              id={`${batch.id}-operator`}
              className="mt-input w-40"
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              data-testid={`${testId}-operator`}
            />
          </div>
          <button
            type="button"
            className="mt-btn mt-btn-primary"
            data-testid={`${testId}-complete`}
            disabled={completing}
            onClick={() => onComplete(operator)}
          >
            {completing ? '整批完成中…' : '整批完成，全部恢复可用'}
          </button>
          <span className="mt-hint">完成后每枚字模各留一条补刻收尾记录</span>
        </div>
      ) : null}
    </li>
  );
}
