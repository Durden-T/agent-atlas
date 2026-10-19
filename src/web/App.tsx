// The shared controller exceeds 300 lines to keep selection, polling and personal writes coordinated without a parallel state layer.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Settings,
  AppStatus,
  Page,
  CatalogResource,
  ResourceDetail,
  RunRecord,
  Override,
  StartCommand,
  Folder,
  FolderCommand,
  PersonalUpdate,
} from '../shared/contracts.ts';
import { api } from './api.ts';
import { filterSchema, settingsSchema } from '../shared/contracts.ts';
import { validationMessage } from './api.ts';
import { FolderManager } from './Folders.tsx';
import { Filters } from './Filters.tsx';
import { ResourceList } from './ResourceList.tsx';
import { CollectPanel } from './CollectPanel.tsx';
import { Detail } from './Detail.tsx';
import { RunPanel } from './RunPanel.tsx';
export function App() {
  const opened = useRef<number | null>(null),
    writeRevision = useRef(0),
    statusRead = useRef(0),
    pendingWrites = useRef(0),
    writes = useRef<Promise<unknown>>(Promise.resolve());
  const [folders, setFolders] = useState<Folder[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null),
    [status, setStatus] = useState<AppStatus | null>(null);
  const [resources, setResources] = useState<Page<CatalogResource> | null>(null),
    [runs, setRuns] = useState<Page<RunRecord> | null>(null);
  const [selected, setSelected] = useState<number | null>(null),
    [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [page, setPage] = useState(1),
    [runPage, setRunPage] = useState(1),
    [version, setVersion] = useState(0),
    [pollVersion, setPollVersion] = useState(0),
    [sourcePage, setSourcePage] = useState(1);
  const [loading, setLoading] = useState(true),
    [mutating, setMutating] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [showFilters, setShowFilters] = useState(false),
    [showRuns, setShowRuns] = useState(false);
  const loadStatus = useCallback(async () => {
    const revision = writeRevision.current,
      request = ++statusRead.current;
    const isCurrent = () => request === statusRead.current && revision === writeRevision.current;
    try {
      const [s, r, f] = await Promise.all([
        api<AppStatus>('/api/status'),
        api<Page<RunRecord>>('/api/runs?page=' + runPage),
        api<Folder[]>('/api/folders'),
      ]);
      if (!isCurrent()) return;
      setStatus(s);
      setRuns(r);
      setFolders(f);
    } catch (error) {
      if (isCurrent()) throw error;
    }
  }, [runPage]);
  useEffect(() => {
    if (settings) return;
    let mounted = true;
    api<Settings>('/api/settings')
      .then((v) => {
        if (mounted) setSettings(v);
      })
      .catch((e) => setError(e.message));
    return () => {
      mounted = false;
    };
  }, [settings, version]);
  useEffect(() => {
    void loadStatus().catch((e) => setError(e.message));
  }, [loadStatus, version]);
  const active = Boolean(status?.activeRun || runs?.items.some((r) => !r.endedAt));
  useEffect(() => {
    if (!active) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await loadStatus();
        if (!disposed) setPollVersion((v) => v + 1);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '读取状态失败');
      } finally {
        if (!disposed) timer = setTimeout(poll, 1500);
      }
    }
    timer = setTimeout(poll, 1500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, loadStatus]);
  const filter = settings?.view;
  const validation = settings ? settingsSchema.safeParse(settings) : null;
  useEffect(() => {
    if (!filter) return;
    if (!filterSchema.safeParse(filter).success) {
      setLoading(false);
      return;
    }
    const controller = new AbortController(),
      revision = writeRevision.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api<Page<CatalogResource>>(
        '/api/resources?' +
          new URLSearchParams({ filter: JSON.stringify(filter), page: String(page) }),
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (controller.signal.aborted || revision !== writeRevision.current) return;
          setResources(value);
          setPage(Math.min(page, Math.max(1, Math.ceil(value.total / value.pageSize))));
        })
        .catch((e) => {
          if (!controller.signal.aborted && revision === writeRevision.current) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, page, version, pollVersion]);
  useEffect(() => {
    setDetail((current) => (current?.id === selected ? current : null));
    if (selected === null) {
      opened.current = null;
      return;
    }
    const controller = new AbortController(),
      revision = writeRevision.current;
    void api<ResourceDetail>(
      '/api/resources/' + selected + (sourcePage === 1 ? '' : '?sourcePage=' + sourcePage),
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted || revision !== writeRevision.current) return;
        setDetail(value);
        if (opened.current !== selected) {
          opened.current = selected;
          void personal(selected, { viewed: true });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && revision === writeRevision.current) setError(e.message);
      });
    return () => controller.abort();
  }, [selected, version, pollVersion, sourcePage]);
  async function action<T>(work: () => Promise<T>, apply?: (value: T) => void) {
    if (pendingWrites.current >= 100) {
      setError('待保存修改已达上限，请稍后重试');
      return false;
    }
    pendingWrites.current++;
    setMutating(true);
    const result = writes.current.then(async () => {
      setError('');
      setNotice('');
      writeRevision.current++;
      try {
        const value = await work();
        writeRevision.current++;
        apply?.(value);
        setVersion((v) => v + 1);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败');
        return false;
      } finally {
        pendingWrites.current--;
        setMutating(pendingWrites.current > 0);
      }
    });
    writes.current = result;
    return result;
  }
  async function save() {
    if (settings) {
      const parsed = settingsSchema.safeParse(settings);
      if (!parsed.success) throw new Error(validationMessage(parsed.error));
      await api<Settings>('/api/settings', parsed.data);
      setNotice('收集默认值与查看条件已保存');
    }
  }
  function start(command: StartCommand) {
    void action(async () => {
      await save();
      await api('/api/runs', command);
      setShowRuns(true);
      setRunPage(1);
      setNotice('任务已开始，进度与结果会保存在本机');
    });
  }
  function applyResource(saved: ResourceDetail) {
    setDetail((current) =>
      current?.id === saved.id ? { ...saved, sources: current.sources } : current,
    );
    setResources(
      (current) =>
        current && {
          ...current,
          items: current.items.map((item) => (item.id === saved.id ? saved : item)),
        },
    );
  }
  function override(value: Override) {
    if (selected !== null)
      void action(
        () => api<ResourceDetail>('/api/resources/' + selected + '/override', value),
        (saved) => {
          applyResource(saved);
          setNotice('人工整理已保存');
        },
      );
  }
  function personal(id: number, value: PersonalUpdate) {
    return action(
      () => api<ResourceDetail>('/api/resources/' + id + '/personal', value),
      applyResource,
    );
  }
  function changeFolder(command: FolderCommand) {
    return action(
      () => api<Folder | null>('/api/folders', command),
      (saved) => {
        if (command.kind === 'delete') {
          setFolders((current) => current.filter((folder) => folder.id !== command.id));
          setSettings(
            (current) =>
              current && {
                ...current,
                view: {
                  ...current.view,
                  folderId: current.view.folderId === command.id ? null : current.view.folderId,
                },
              },
          );
        } else {
          if (!saved) throw new Error('收藏夹保存返回缺少记录');
          setFolders((current) =>
            command.kind === 'create'
              ? [...current, saved]
              : current.map((folder) => (folder.id === saved.id ? saved : folder)),
          );
        }
        if (command.kind !== 'create') {
          const folderId = command.id;
          function updateMembership<T extends CatalogResource>(resource: T): T {
            return {
              ...resource,
              folders: resource.folders.flatMap((folder) =>
                folder.id !== folderId ? [folder] : saved ? [saved] : [],
              ),
            };
          }
          setDetail((current) => current && updateMembership(current));
          setResources(
            (current) => current && { ...current, items: current.items.map(updateMembership) },
          );
        }
        setNotice('收藏夹已保存');
      },
    );
  }
  return (
    <>
      <header className="masthead">
        <div>
          <h1>Agent Atlas</h1>
          <p>GitHub agent 工具、工作流与技能资料台</p>
        </div>
        <button aria-expanded={showRuns} onClick={() => setShowRuns(!showRuns)}>
          任务记录{active ? ' / 运行中' : ''}
        </button>
      </header>
      <main>
        {validation && !validation.success && (
          <div role="alert" className="message error">
            {validationMessage(validation.error)}
          </div>
        )}
        {error && (
          <div role="alert" className="message error">
            {error}
            <button
              onClick={() => {
                setError('');
                setVersion((v) => v + 1);
              }}
            >
              重新读取本机数据
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="message">
            {notice}
          </p>
        )}
        {!settings ? (
          <div className="empty">
            {error ? '配置加载失败，请确认本机服务正在运行。' : '正在读取本机配置…'}
          </div>
        ) : (
          <>
            <CollectPanel
              value={settings.collection}
              onChange={(collection) => setSettings({ ...settings, collection })}
              onSave={() => void action(save)}
              onStart={(kind, retryErrors) =>
                start(
                  kind === 'collect'
                    ? { kind, settings: settings.collection }
                    : { kind, settings: settings.collection, retryErrors },
                )
              }
              busy={mutating || active}
              status={status}
            />
            {showRuns && (
              <RunPanel
                data={runs}
                onPage={setRunPage}
                onCancel={(id) =>
                  void action(async () => {
                    await api('/api/runs/' + id + '/cancel', {});
                    setNotice('已请求取消；成功结果会保留');
                  })
                }
              />
            )}
            <div
              className={
                'workbench ' +
                (selected !== null ? 'has-detail' : '') +
                ' ' +
                (showFilters ? 'show-filters' : '')
              }
            >
              <div className="filter-wrap">
                <FolderManager folders={folders} busy={mutating} onChange={changeFolder} />
                <Filters
                  value={settings.view}
                  folders={folders}
                  onChange={(view) => {
                    setSettings({ ...settings, view });
                    setPage(1);
                  }}
                />
                <button className="save-view" disabled={mutating} onClick={() => void action(save)}>
                  保存查看条件
                </button>
              </div>
              <section className="catalog" aria-label="仓库列表">
                <div className="catalog-tools">
                  <button
                    className="filter-toggle"
                    aria-expanded={showFilters}
                    onClick={() => setShowFilters(!showFilters)}
                  >
                    查看条件
                  </button>
                  <label className="search-label">
                    搜索本地资源
                    <input
                      type="search"
                      value={settings.view.query}
                      placeholder="仓库名称或原文描述"
                      onChange={(e) => {
                        setSettings({
                          ...settings,
                          view: { ...settings.view, query: e.target.value },
                        });
                        setPage(1);
                      }}
                    />
                  </label>
                  <label>
                    排序
                    <select
                      value={settings.view.sort}
                      onChange={(e) => {
                        setSettings({
                          ...settings,
                          view: { ...settings.view, sort: e.target.value as 'stars' | 'updated' },
                        });
                        setPage(1);
                      }}
                    >
                      <option value="stars">Star 降序</option>
                      <option value="updated">最近推送</option>
                    </select>
                  </label>
                </div>
                <p className="catalog-note">
                  排名仅覆盖已发现仓库；查看筛选不会请求 GitHub 或 Jev。
                </p>
                <ResourceList
                  data={resources}
                  selected={selected}
                  loading={loading}
                  onSelect={(id) => {
                    setSelected(id);
                    setSourcePage(1);
                  }}
                  onPage={setPage}
                  onViewed={(id) => personal(id, { viewed: true })}
                />
              </section>
              <Detail
                key={selected ?? 'none'}
                value={detail?.id === selected ? detail : null}
                onClose={() => setSelected(null)}
                onSourcePage={setSourcePage}
                onOverride={override}
                folders={folders}
                onPersonal={(value) => {
                  if (selected !== null) void personal(selected, value);
                }}
                personalBusy={mutating}
                onRejudge={() => {
                  if (selected !== null) start({ kind: 'rejudge', repositoryId: selected });
                }}
                busy={mutating || active}
              />
            </div>
          </>
        )}
      </main>
      <footer>手动收集 / 本机保存 / 三组多标签</footer>
    </>
  );
}
