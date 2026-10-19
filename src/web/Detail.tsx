import { useEffect, useState } from 'react';
import type { ResourceDetail, Override, Folder, PersonalUpdate } from '../shared/contracts.ts';
import { taxonomy, type LabelId } from '../shared/taxonomy.ts';
import { dateText, numberText, stateNames } from './api.ts';
import { LabelBands } from './ResourceList.tsx';
export function Detail({
  value,
  onClose,
  onOverride,
  onRejudge,
  folders,
  onPersonal,
  personalBusy,
  busy,
  onSourcePage,
}: {
  value: ResourceDetail | null;
  folders: Folder[];
  onPersonal: (value: PersonalUpdate) => void;
  personalBusy: boolean;
  onClose: () => void;
  onOverride: (v: Override) => void;
  onRejudge: () => void;
  busy: boolean;
  onSourcePage: (page: number) => void;
}) {
  const [editing, setEditing] = useState(false),
    [chosen, setChosen] = useState<LabelId[]>([]);
  useEffect(() => {
    if (!editing) setChosen(value?.labels ?? []);
  }, [value, editing]);
  if (!value)
    return (
      <aside className="detail">
        <div className="detail-top">
          <h2>仓库详情</h2>
          <button onClick={onClose}>返回列表</button>
        </div>
        <div className="empty">
          <p>详情尚未显示。可选择仓库，或在读取失败后重试。</p>
        </div>
      </aside>
    );
  return (
    <aside className="detail" aria-label="仓库详情">
      <div className="detail-top">
        <h2>{value.metadata.full_name}</h2>
        <button onClick={onClose}>返回列表</button>
      </div>
      <a href={'https://github.com/' + value.metadata.full_name} target="_blank" rel="noreferrer">
        在 GitHub 查看仓库 ↗
      </a>
      <p>{value.metadata.description ?? '未提供描述'}</p>
      <p className="small">
        {stateNames[value.effectiveState]} / {value.metadata.archived ? '已归档' : '未归档'} /{' '}
        {value.metadata.language ?? '语言未知'}
      </p>
      <p className="small">
        ★ {numberText(value.metadata.stars)} / 最近推送 {dateText(value.metadata.pushed_at)}
      </p>
      <LabelBands resource={value} />
      <h3>收藏与查看</h3>
      <p className="small">
        {value.viewed ? '已查看' : '未查看'}{' '}
        <button disabled={personalBusy} onClick={() => onPersonal({ viewed: !value.viewed })}>
          {value.viewed ? '标为未查看' : '标为已查看'}
        </button>
      </p>
      <p className="small folder-memberships" aria-label="所属收藏夹">
        {value.folders.length
          ? value.folders.map((folder) => (
              <span className="folder-tag" key={folder.id}>
                {folder.name}
              </span>
            ))
          : '未加入收藏夹'}
      </p>
      <fieldset>
        <legend>加入收藏夹</legend>
        {!folders.length && <p className="small muted">在查看条件中创建收藏夹。</p>}
        {folders.map((folder) => (
          <label className="check" key={folder.id}>
            <input
              type="checkbox"
              disabled={personalBusy}
              checked={value.folders.some((f) => f.id === folder.id)}
              onChange={(e) =>
                onPersonal({
                  folderIds: e.target.checked
                    ? [...value.folders.map((f) => f.id), folder.id]
                    : value.folders.filter((f) => f.id !== folder.id).map((f) => f.id),
                })
              }
            />
            {folder.name}
          </label>
        ))}
      </fieldset>
      <h3>人工整理</h3>
      <div className="button-row">
        <button
          disabled={busy}
          onClick={() => onOverride({ decision: 'keep', labels: value.override?.labels ?? null })}
        >
          保留
        </button>
        <button
          disabled={busy}
          onClick={() => onOverride({ decision: 'ignore', labels: value.override?.labels ?? null })}
        >
          忽略
        </button>
        <button disabled={busy} onClick={() => onOverride({ decision: null, labels: null })}>
          恢复模型建议
        </button>
        <button onClick={() => setEditing(!editing)}>修正标签</button>
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onOverride({ decision: value.override?.decision ?? null, labels: chosen });
          }}
        >
          {taxonomy.facets.map((f) => (
            <fieldset key={f.id}>
              <legend>{f.displayName}</legend>
              {f.labels.map((l) => {
                const id = `${f.id}.${l.id}` as LabelId;
                return (
                  <label className="check" key={id}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(id)}
                      onChange={(e) =>
                        setChosen(
                          e.target.checked ? [...chosen, id] : chosen.filter((v) => v !== id),
                        )
                      }
                    />
                    {l.displayName}
                  </label>
                );
              })}
            </fieldset>
          ))}
          <button disabled={busy} className="primary">
            保存人工标签
          </button>
        </form>
      )}
      <p className="small muted">
        人工决定独立保存，后续收集保留。{value.override ? '当前有人工整理。' : '当前使用模型建议。'}
      </p>
      <h3>发现来源</h3>
      <ul className="sources">
        {value.sources.items.map((s) => (
          <li key={s.key}>
            {s.label}
            <br />
            <span className="muted small">
              {dateText(s.discoveredAt)}
              {s.parentId ? ' / 来源仓库 ID ' + s.parentId : ''}
            </span>
          </li>
        ))}
      </ul>
      {value.sources.total > value.sources.pageSize && (
        <nav className="button-row" aria-label="发现来源分页">
          <button
            disabled={value.sources.page <= 1}
            onClick={() => onSourcePage(value.sources.page - 1)}
          >
            较新来源
          </button>
          <span>
            {value.sources.page} / {Math.ceil(value.sources.total / value.sources.pageSize)}
          </span>
          <button
            disabled={value.sources.page * value.sources.pageSize >= value.sources.total}
            onClick={() => onSourcePage(value.sources.page + 1)}
          >
            较早来源
          </button>
        </nav>
      )}
      <p className="small">
        成功检查：{dateText(value.checkedAt)}
        <br />
        内容更新：{dateText(value.contentAt)}
      </p>
      {(value.error || value.filterReason) && (
        <p className="error-text">{value.error ?? value.filterReason}</p>
      )}
      <h3>README 原文证据</h3>
      {value.evidence ? (
        <>
          <p className="small mono">
            {value.evidence.evidence.readme.path}
            <br />
            SHA {value.evidence.sha}
            <br />
            读取 {dateText(value.evidence.readAt)}
            {value.evidence.evidence.readme.truncated ? ' / 已截断为原文前段' : ''}
          </p>
          <details>
            <summary>展开原文</summary>
            <pre className="readme">{value.evidence.evidence.readme.text || 'README 内容为空'}</pre>
          </details>
        </>
      ) : (
        <p>未保存 README 证据{value.filterReason ? '：' + value.filterReason : ''}</p>
      )}
      <h3>模型判断记录</h3>
      <button disabled={busy || !value.evidence} onClick={onRejudge}>
        用已保存证据重新判断（付费）
      </button>
      <p className="small muted">不刷新 GitHub；绕过缓存与复查间隔。</p>
      {!value.judgments.length && <p>尚无模型判断</p>}
      {value.judgments.map((j) => (
        <details key={j.id}>
          <summary>
            {dateText(j.at)} / {j.result ? stateNames[j.result.status] : j.state}
          </summary>
          {j.error && <p className="error-text">{j.error}</p>}
          {j.trace && !j.result && (
            <details>
              <summary>失败请求与原始返回</summary>
              <pre>{JSON.stringify(j.trace, null, 2)}</pre>
            </details>
          )}
          {j.result && (
            <>
              <p className="small mono">
                {j.result.model} / {j.result.ruleVersion}
              </p>
              <p className="small">
                采用标签：{j.result.labels.join('、') || '无'}
                <br />
                费用：{j.result.usage.cost === null ? '未知' : '$' + j.result.usage.cost}
              </p>
              <dl className="decisions">
                {Object.entries(j.result.decisions).map(([id, d]) => (
                  <div key={id}>
                    <dt>{id}</dt>
                    <dd>
                      {d.type === 'noul'
                        ? `${id === 'relevance' ? '相关概率' : '支持概率'} ${d.noul}`
                        : `${d.choice} / 最高概率 ${d.probability} / 差值 ${d.margin.toFixed(3)}`}
                      {d.needsReview ? ' / 待确认' : ''}
                    </dd>
                  </div>
                ))}
              </dl>
              <details>
                <summary>原始请求与返回</summary>
                <pre>
                  {JSON.stringify(
                    { request: j.result.request, response: j.result.response },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </details>
      ))}
    </aside>
  );
}
