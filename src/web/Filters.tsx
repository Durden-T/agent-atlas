import { inputNumber } from './api.ts';
import type { ResourceFilter, Folder } from '../shared/contracts.ts';
import { taxonomy, type LabelId } from '../shared/taxonomy.ts';
import { stateNames } from './api.ts';
export function Filters({
  value,
  onChange,
  folders,
}: {
  value: ResourceFilter;
  folders: Folder[];
  onChange: (value: ResourceFilter) => void;
}) {
  const patch = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <aside className="filters" aria-label="查看条件">
      <h2>查看条件</h2>
      <p className="muted">仅筛选本地记录</p>
      <label>
        判断状态
        <select value={value.state} onChange={(e) => patch('state', e.target.value)}>
          {Object.entries(stateNames)
            .slice(0, 10)
            .map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
        </select>
      </label>
      <label>
        收藏夹
        <select
          value={value.folderId ?? ''}
          onChange={(e) => patch('folderId', e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">全部收藏夹与未收藏项目</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        查看状态
        <select value={value.viewed} onChange={(e) => patch('viewed', e.target.value)}>
          <option value="all">全部</option>
          <option value="unviewed">未查看</option>
          <option value="viewed">已查看</option>
        </select>
      </label>
      <label>
        最小 Star
        <input
          type="number"
          min="0"
          step="1"
          value={inputNumber(value.minStars)}
          onChange={(e) => patch('minStars', e.target.valueAsNumber)}
        />
      </label>
      <label>
        最近更新天数
        <input
          type="number"
          min="1"
          step="1"
          placeholder="不限"
          value={inputNumber(value.updatedWithinDays)}
          onChange={(e) =>
            patch('updatedWithinDays', e.target.value === '' ? null : e.target.valueAsNumber)
          }
        />
      </label>
      <label>
        归档状态
        <select value={value.archived} onChange={(e) => patch('archived', e.target.value)}>
          <option value="all">全部</option>
          <option value="active">未归档</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      {taxonomy.facets.map((f) => (
        <fieldset key={f.id}>
          <legend>{f.displayName}</legend>
          {f.labels.map((l) => {
            const id = `${f.id}.${l.id}` as LabelId;
            return (
              <label className="check" key={id}>
                <input
                  type="checkbox"
                  checked={value.labels.includes(id)}
                  onChange={(e) =>
                    patch(
                      'labels',
                      e.target.checked
                        ? [...value.labels, id]
                        : value.labels.filter((v) => v !== id),
                    )
                  }
                />
                {l.displayName}
              </label>
            );
          })}
        </fieldset>
      ))}
      <p className="muted small">同组任一符合，跨组同时符合。</p>
    </aside>
  );
}
