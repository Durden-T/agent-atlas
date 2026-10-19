import type { RunRecord, Page } from '../shared/contracts.ts';
import { stateNames, dateText, numberText } from './api.ts';
const commandNames: Record<RunRecord['command']['kind'], string> = {
  collect: '收集',
  continue: '继续处理',
  rejudge: '重新判断',
};
export function RunPanel({
  data,
  onCancel,
  onPage,
}: {
  data: Page<RunRecord> | null;
  onCancel: (id: string) => void;
  onPage: (page: number) => void;
}) {
  return (
    <section className="runs" aria-label="任务记录">
      <h2>任务记录</h2>
      {!data?.items.length && (
        <p className="muted">尚未运行收集。启动与浏览页面不会自动调用外部服务。</p>
      )}
      {data?.items.map((r, i) => (
        <details key={r.id} open={i === 0}>
          <summary>
            {stateNames[r.status]} / {commandNames[r.command.kind]} / {dateText(r.startedAt)}
          </summary>
          <div className="run-content">
            <p>
              {r.stage}
              {!r.endedAt && <button onClick={() => onCancel(r.id)}>取消任务</button>}
            </p>
            <dl className="run-stats">
              {Object.entries({
                发现: r.stats.discovered,
                更新: r.stats.updated,
                门槛过滤: r.stats.thresholdFiltered,
                无README: r.stats.noReadme,
                无有效分类证据: r.stats.emptyEvidenceFiltered,
                间隔跳过: r.stats.skipped,
                缓存复用: r.stats.cached,
                完成判断: r.stats.judged,
                待判断: r.stats.pending,
                待复核: r.stats.review,
                模型未收录: r.stats.unrelated,
                失败: r.stats.failed,
                '实际 Jev 请求': r.stats.requests,
                结果未知请求: r.stats.unknownRequests,
                输入用量: r.stats.inputTokens,
                输出用量: r.stats.outputTokens,
              }).map(([name, v]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{numberText(v)}</dd>
                </div>
              ))}
              <div>
                <dt>实际费用（美元）</dt>
                <dd>{r.stats.cost === null ? '未知' : '$' + r.stats.cost.toFixed(8)}</dd>
              </div>
            </dl>
            {r.errors.map((v, i) => (
              <p className="error-text" key={'e' + i}>
                {v}
              </p>
            ))}
            {r.gaps.length > 0 && (
              <>
                <h3>未完成范围</h3>
                <ul>
                  {r.gaps.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
                <p className="small muted">
                  下次点击收集续跑发现分页；点击继续待判断处理已发现候选。
                </p>
              </>
            )}
            <details>
              <summary>本轮配置</summary>
              <pre>{JSON.stringify(r.command, null, 2)}</pre>
            </details>
          </div>
        </details>
      ))}
      {data && data.total > data.pageSize && (
        <nav className="pagination">
          <button disabled={data.page === 1} onClick={() => onPage(data.page - 1)}>
            上一页任务
          </button>
          <span>
            {data.page} / {Math.ceil(data.total / data.pageSize)}
          </span>
          <button
            disabled={data.page * data.pageSize >= data.total}
            onClick={() => onPage(data.page + 1)}
          >
            下一页任务
          </button>
        </nav>
      )}
    </section>
  );
}
