import { inputNumber } from './api.ts';
import type { CollectionSettings, AppStatus } from '../shared/contracts.ts';
export function CollectPanel({
  value,
  onChange,
  onSave,
  onStart,
  busy,
  status,
}: {
  value: CollectionSettings;
  onChange: (value: CollectionSettings) => void;
  onSave: () => void;
  onStart: (kind: 'collect' | 'continue', retryErrors: boolean) => void;
  busy: boolean;
  status: AppStatus | null;
}) {
  const patch = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <section className="collect-panel" aria-label="收集参数">
      <div className="collect-title">
        <h2>收集参数</h2>
        <span className="muted">已发现仓库按 Star 降序判断</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onStart('collect', false);
        }}
      >
        <div className="collect-fields">
          <label>
            最小 Star
            <input
              type="number"
              min="0"
              step="1"
              required
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
            复查间隔（天）
            <input
              type="number"
              min="-1"
              step="1"
              required
              value={inputNumber(value.refreshIntervalDays)}
              onChange={(e) => patch('refreshIntervalDays', e.target.valueAsNumber)}
            />
          </label>
          <label>
            本轮 Jev 上限
            <input
              type="number"
              min="-1"
              max="1000"
              step="1"
              required
              value={inputNumber(value.judgmentLimit)}
              onChange={(e) => patch('judgmentLimit', e.target.valueAsNumber)}
            />
          </label>
          <label>
            发现请求预算
            <input
              type="number"
              min="-1"
              max="1000"
              step="1"
              required
              value={inputNumber(value.discoveryRequestLimit)}
              onChange={(e) => patch('discoveryRequestLimit', e.target.valueAsNumber)}
            />
          </label>
        </div>
        <div className="collect-actions">
          <p className="muted small">
            复查 -1：永不；0：每次；正数：间隔天数。更新以最近推送时间为准。Jev 调用产生实际费用。
            Jev 上限和发现预算 -1：不限次数；0 无效。发现预算只计 GitHub 搜索与作者分页请求，不计
            README 或 Jev。先发现再判断，发现最多使用前 7.5 分钟，为读取和判断预留时间。 Jev
            上限不限制发现数；任务仍受 15 分钟及 5000 个候选读取保护，可随时取消。
          </p>
          <button type="button" disabled={busy} onClick={onSave}>
            保存配置
          </button>
          <button className="primary" disabled={busy} type="submit">
            开始收集
          </button>
          <button type="button" disabled={busy} onClick={() => onStart('continue', false)}>
            继续待判断
          </button>
        </div>
      </form>
      <details>
        <summary>失败重试与连接状态</summary>
        <p>结果未知或失败的付费请求不会自动重放。明确重试会重新占用本轮额度。</p>
        <button disabled={busy} onClick={() => onStart('continue', true)}>
          明确重试失败请求
        </button>
        <p className="small">
          Jev 密钥：{status?.jevConfigured ? '已配置' : '未配置 JEV_OPENROUTER_KEY'}；GitHub：
          {status?.githubAuthentication === 'missing'
            ? '未登录，请运行 gh auth login'
            : status?.githubAuthentication === 'gh'
              ? '使用 gh 登录'
              : '使用服务端环境凭据'}
        </p>
        <p className="small muted">本地数据库：{status?.databasePath ?? '正在读取'}</p>
      </details>
    </section>
  );
}
