import { useMemo, useState } from "react";
import {
  BarChart3,
  CalendarClock,
  FileUp,
  LockKeyhole,
  Moon,
  RotateCcw,
  ShieldCheck,
  SunMedium,
  Users,
} from "lucide-react";

import { buildStage3AnalyticsDashboardFromExports } from "../analytics/stage3AnalyticsDashboard.js";

const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_FILES = 20;

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function MetricCards({ metrics }) {
  const cards = [
    ["活跃会话", metrics.active_session_count, Users],
    ["提交需求", metrics.decision_request_count, BarChart3],
    ["完成决策", metrics.completion_count, ShieldCheck],
    ["查看详情", metrics.place_detail_open_count, CalendarClock],
  ];
  return (
    <section className="analytics-metrics" aria-label="公开 Beta 核心指标">
      {cards.map(([label, value, Icon]) => (
        <article key={label}><Icon aria-hidden="true" /><span>{label}</span><strong>{value}</strong></article>
      ))}
    </section>
  );
}

function DailyBars({ rows }) {
  const max = Math.max(1, ...rows.map((row) => row.event_count));
  return (
    <div className="analytics-daily-list">
      {rows.map((row) => (
        <div key={row.date}>
          <time>{row.date}</time>
          <span><i style={{ width: `${Math.max(4, row.event_count / max * 100)}%` }} /></span>
          <strong>{row.event_count}</strong>
          <small>{row.active_session_count} 会话 · {row.completion_count} 完成</small>
        </div>
      ))}
    </div>
  );
}

export function BetaAnalyticsDashboardApp() {
  const [theme, setTheme] = useState("light");
  const [dashboard, setDashboard] = useState(null);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState(null);
  const ignoredCount = useMemo(() => dashboard
    ? dashboard.parse_error_count
      + dashboard.ignored.invalid_record_count
      + dashboard.ignored.outside_retention_count
      + dashboard.ignored.duplicate_record_count
    : 0, [dashboard]);

  async function importExports(event) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length) return;
    if (files.length > MAX_EXPORT_FILES) {
      setError("一次最多导入 20 个文件。");
      return;
    }
    if (files.some((file) => file.size > MAX_EXPORT_BYTES)) {
      setError("单个文件不能超过 5MB。");
      return;
    }
    try {
      const next = buildStage3AnalyticsDashboardFromExports(
        await Promise.all(files.map((file) => file.text())),
      );
      setDashboard(next);
      setFilename(files.length === 1 ? files[0].name : `${files.length} 个日志文件`);
      setError(null);
    } catch {
      setError("无法读取该日志导出。请使用 JSON、JSONL 或 NDJSON。");
    }
  }

  function reset() {
    setDashboard(null);
    setFilename("");
    setError(null);
  }

  return (
    <div className="theme-root" data-theme={theme}>
      <main className="analytics-app-shell">
        <header className="analytics-topbar">
          <a href="/" className="analytics-brand"><span className="brand-mark"><img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" /></span><span><strong>QuietLens</strong><small>Beta Analytics · local</small></span></a>
          <div className="analytics-environment"><LockKeyhole aria-hidden="true" /><span><strong>仅限本机管理员</strong>导入文件不会上传</span></div>
          <nav><a href="/?workbench=evidence-review">Evidence 审核</a><button type="button" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon aria-hidden="true" /> : <SunMedium aria-hidden="true" />}{theme === "light" ? "夜间" : "日间"}</button></nav>
        </header>

        <div className="analytics-scroll">
          <section className="analytics-hero">
            <div><span>Stage 3 · S3-T05</span><h1>公开 Beta 数据看板</h1><p>查看邀请码灰度的聚合趋势。只接受服务端输出的隐私最小化事件，并统计最近 30 天。</p></div>
            <aside><CalendarClock aria-hidden="true" /><strong>30 天统计窗口</strong><span>当前云端自动保留尚未启用。看板不展示邀请码、参与者、原始请求、联系方式或精确位置。</span></aside>
          </section>

          <section className="analytics-import-panel">
            <div><FileUp aria-hidden="true" /><span><strong>{filename || "导入服务端日志"}</strong><small>支持 JSON、JSONL、NDJSON；最多 20 个文件，每个 5MB；仅在当前页面内存中处理。</small></span></div>
            <div>
              {dashboard && <button type="button" className="is-secondary" onClick={reset}><RotateCcw aria-hidden="true" />清空</button>}
              <label><FileUp aria-hidden="true" />选择文件<input type="file" multiple accept=".json,.jsonl,.ndjson,.log,application/json" onChange={importExports} /></label>
            </div>
          </section>

          {error && <p className="analytics-error">{error}</p>}

          {dashboard ? <>
            <MetricCards metrics={dashboard.metrics} />
            <section className="analytics-grid">
              <article className="analytics-funnel">
                <header><span>01</span><h2>核心漏斗</h2><em>{percent(dashboard.funnel.completion_rate)} 完成</em></header>
                <div><span><small>需求提交</small><strong>{dashboard.funnel.submitted_count}</strong></span><i>→</i><span><small>简报查看</small><strong>{dashboard.funnel.brief_view_count}</strong></span><i>→</i><span><small>发布 / 拒绝</small><strong>{dashboard.funnel.completion_count}</strong></span></div>
              </article>
              <article className="analytics-secondary">
                <header><span>02</span><h2>行为与成本</h2></header>
                <dl>
                  <div><dt>修改需求</dt><dd>{dashboard.metrics.correction_count}</dd></div>
                  <div><dt>反馈候选</dt><dd>{dashboard.metrics.feedback_candidate_count}</dd></div>
                  <div><dt>模型调用</dt><dd>{dashboard.metrics.model_call_count}</dd></div>
                  <div><dt>总 token</dt><dd>{dashboard.metrics.total_tokens}</dd></div>
                </dl>
              </article>
              <article className="analytics-daily">
                <header><span>03</span><h2>每日趋势</h2><em>{dashboard.daily.length} 天有事件</em></header>
                {dashboard.daily.length ? <DailyBars rows={dashboard.daily} /> : <p>最近 30 天没有有效事件。</p>}
              </article>
            </section>
            <p className="analytics-footnote"><ShieldCheck aria-hidden="true" />有效事件 {dashboard.metrics.event_count} 条；忽略 {ignoredCount} 条无效、重复或超期记录。看板不会显示任何会话或请求 ID。</p>
          </> : <section className="analytics-empty"><BarChart3 aria-hidden="true" /><strong>等待导入服务端日志</strong><span>当前云端日志投递未启用。本机看板已就绪，但不会伪造 30 天留存或生产数据。</span></section>}
        </div>
      </main>
    </div>
  );
}
