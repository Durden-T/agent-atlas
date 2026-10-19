import { taxonomy, labels, type FacetState } from '../shared/taxonomy.ts';
import type { CatalogResource, Page } from '../shared/contracts.ts';
import { stateNames, dateText, numberText } from './api.ts';
import { Component, useEffect, useRef, type ReactNode, type RefObject } from 'react';

type ReadingPosition = { element: HTMLElement; top: number } | null;
export class ResourceViewport extends Component<{
  data: Page<CatalogResource> | null;
  loading: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}> {
  // React's snapshot lifecycle reads the old layout before list rows are changed or removed.
  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>): ReadingPosition {
    const { data, listRef } = this.props;
    if (data?.items === previous.data?.items || data?.page !== previous.data?.page) return null;
    const remaining = new Set(data?.items.map((item) => item.id));
    for (const element of listRef.current?.querySelectorAll<HTMLElement>('[data-repository-id]') ??
      []) {
      const rect = element.getBoundingClientRect();
      if (
        remaining.has(Number(element.dataset.repositoryId)) &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight
      )
        return { element, top: rect.top };
    }
    return null;
  }
  componentDidUpdate(
    _previous: Readonly<typeof this.props>,
    _state: Readonly<unknown>,
    position: ReadingPosition,
  ) {
    if (position?.element.isConnected)
      window.scrollBy(0, position.element.getBoundingClientRect().top - position.top);
  }
  render() {
    return (
      <div aria-busy={this.props.loading} ref={this.props.listRef}>
        {this.props.children}
      </div>
    );
  }
}
const facetText: Record<FacetState, string> = {
  unjudged: '暂无确认标签',
  none: '无匹配标签',
  pending: '待确认',
  partial: '部分待确认',
  confirmed: '',
  withheld: '标签暂未应用',
  historical: '历史规则结果',
};
export function LabelBands({ resource }: { resource: CatalogResource }) {
  return (
    <div className="bands">
      {taxonomy.facets.map((f) => {
        const selected = labels.filter((l) => l.facet === f.id && resource.labels.includes(l.id));
        const text = facetText[resource.facetStates[f.id]];
        return (
          <div key={f.id} className={'band ' + f.id}>
            <span className="facet-title">{f.displayName}</span>
            <span>
              {selected.map((l) => (
                <span className="tag" key={l.id}>
                  {l.displayName}
                </span>
              ))}
              {text && <span className="muted small">{text}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
export function ResourceList({
  data,
  selected,
  loading,
  onSelect,
  onPage,
  onViewed,
}: {
  data: Page<CatalogResource> | null;
  selected: number | null;
  loading: boolean;
  onSelect: (id: number) => void;
  onPage: (page: number) => void;
  onViewed: (id: number) => Promise<boolean>;
}) {
  const list = useRef<HTMLDivElement>(null),
    viewed = useRef(onViewed),
    seen = useRef(new Map<number, { at: number | null; pending: boolean }>());
  viewed.current = onViewed;
  useEffect(() => {
    const ids = new Set(data?.items.filter((item) => !item.viewed).map((item) => item.id));
    for (const id of seen.current.keys()) if (!ids.has(id)) seen.current.delete(id);
    if (!list.current) return;
    let mounted = true;
    const observer = new IntersectionObserver((entries) => {
      if (!mounted) return;
      for (const entry of entries) {
        const element = entry.target as HTMLElement,
          id = Number(element.dataset.repositoryId),
          state = seen.current.get(id);
        if (!state || !element.isConnected) continue;
        if (entry.boundingClientRect.height === 0) {
          state.at = null;
          continue;
        }
        if (entry.isIntersecting && entry.intersectionRect.height > 0) state.at = window.scrollY;
        if (
          entry.isIntersecting ||
          state.pending ||
          state.at === null ||
          window.scrollY <= state.at ||
          entry.boundingClientRect.bottom > (entry.rootBounds?.top ?? 0)
        )
          continue;
        state.pending = true;
        state.at = window.scrollY;
        void viewed.current(id).then((saved) => {
          state.pending = saved;
        });
      }
    });
    for (const element of list.current.querySelectorAll<HTMLElement>('[data-unviewed="true"]')) {
      const id = Number(element.dataset.repositoryId);
      if (!seen.current.has(id)) seen.current.set(id, { at: null, pending: false });
      observer.observe(element);
    }
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, [data?.items]);
  return (
    <ResourceViewport data={data} loading={loading} listRef={list}>
      <div className="list-heading">
        <span>{loading ? '正在读取…' : `${data?.total ?? 0} 个仓库`}</span>
        <span>Star / 最近推送</span>
      </div>
      {!loading && !data?.items.length && (
        <div className="empty">
          <h2>这里还没有符合条件的仓库</h2>
          <p>点击“开始收集”发现资源，或调整左侧查看条件。</p>
        </div>
      )}
      {data?.items.map((r) => (
        <article
          key={r.id}
          data-repository-id={r.id}
          data-unviewed={!r.viewed}
          className={'resource ' + (selected === r.id ? 'selected' : '')}
        >
          <div className="resource-heading">
            <a
              className="repo"
              href={'https://github.com/' + r.metadata.full_name}
              target="_blank"
              rel="noreferrer"
            >
              {r.metadata.full_name}
            </a>
            <div className="numbers">
              <strong>★ {numberText(r.metadata.stars)}</strong>
              <time dateTime={r.metadata.pushed_at ?? undefined}>
                {dateText(r.metadata.pushed_at)}
              </time>
            </div>
          </div>
          <p className="description">{r.metadata.description ?? '未提供描述'}</p>
          <LabelBands resource={r} />
          <div className="personal-bands">
            <span className={'viewed-state ' + (r.viewed ? 'is-viewed' : '')}>
              {r.viewed ? '已查看' : '未查看'}
            </span>
            <span className="folder-memberships" aria-label="所属收藏夹">
              {r.folders.length ? (
                r.folders.map((folder) => (
                  <span className="folder-tag" key={folder.id}>
                    {folder.name}
                  </span>
                ))
              ) : (
                <span className="muted">未加入收藏夹</span>
              )}
            </span>
          </div>
          <div className="row-footer">
            <span>
              {stateNames[r.effectiveState] ?? r.effectiveState}
              {r.metadata.archived ? ' / 已归档' : ''}
              {r.override ? ' / 人工整理' : ''}
            </span>
            <span>采集 {dateText(r.contentAt)}</span>
            <button
              className="resource-details"
              aria-pressed={selected === r.id}
              onClick={() => onSelect(r.id)}
            >
              查看详情
            </button>
          </div>
          {(r.filterReason || r.error) && (
            <p className="small error-text">{r.filterReason ?? r.error}</p>
          )}
        </article>
      ))}
      {data && (data.total > data.pageSize || data.page > 1) && (
        <nav className="pagination" aria-label="仓库分页">
          <button disabled={data.page <= 1 || loading} onClick={() => onPage(data.page - 1)}>
            上一页
          </button>
          <span>
            第 {data.page} / {Math.ceil(data.total / data.pageSize)} 页
          </span>
          <button
            disabled={data.page * data.pageSize >= data.total || loading}
            onClick={() => onPage(data.page + 1)}
          >
            下一页
          </button>
        </nav>
      )}
    </ResourceViewport>
  );
}
