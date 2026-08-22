import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  FileClock,
  FlaskConical,
  History,
  LockKeyhole,
  Moon,
  RotateCcw,
  ShieldAlert,
  SunMedium,
  Tags,
  TriangleAlert,
  UserRoundCheck,
} from "lucide-react";

import {
  buildEvidenceReviewWorkbench,
  createEvidenceReleaseDraft,
  createReviewDecision,
} from "../evidence/reviewWorkbench.js";
import {
  SYNTHETIC_CANDIDATE_STATE,
  SYNTHETIC_PIPELINE_STATE,
  SYNTHETIC_REVIEWER_ID,
  syntheticSubject,
} from "../evidence/reviewWorkbenchFixture.js";
import {
  appendSyntheticReviewDecision,
  clearSyntheticReviewWorkspace,
  loadSyntheticReviewWorkspace,
} from "../evidence/reviewWorkbenchPersistence.js";

const SUBJECT_LABELS = {
  source: "来源时效",
  candidate: "Candidate",
  feedback_candidate: "到店反馈候选",
  deduplication_cluster: "去重簇",
  conflict: "冲突",
};
const REASON_LABELS = {
  source_unassessed: "来源尚未复核",
  source_due: "来源今天到期",
  source_overdue: "来源复核已逾期",
  candidate_pending: "Candidate 等待人工判断",
  candidate_ambiguous: "门店身份存在歧义",
  candidate_unmatched: "未匹配到登记门店",
  feedback_candidate_pending: "用户已确认，等待独立人工核实",
  deduplication_pending: "重复观察等待合并判断",
  conflict_pending: "规范化结果存在冲突",
};
const BLOCK_LABELS = {
  SYNTHETIC_INPUT_FORBIDDEN: "合成输入永远禁止发布",
  NO_APPROVED_CANDIDATES: "没有已批准 Candidate",
  SOURCE_REVIEW_REQUIRED: "Candidate 来源仍需复核",
  PENDING_CANDIDATE_REVIEW: "仍有 Candidate 待审",
  UNRESOLVED_DEDUPLICATION: "仍有去重簇未解决",
  UNRESOLVED_CONFLICT: "仍有冲突未解决",
};
const OUTCOME_OPTIONS = {
  source: [
    ["source_confirmed", "确认当前可用", "source_current"],
    ["source_manual_only", "仅保留人工访问", "source_terms_pending"],
    ["source_blocked", "阻断来源", "source_permission_unclear"],
    ["source_retired", "退休来源", "source_withdrawn"],
  ],
  candidate: [
    ["candidate_approved", "批准候选", "candidate_source_supported"],
    ["candidate_rejected", "拒绝候选", "candidate_source_unsupported"],
    ["candidate_needs_changes", "退回修改", "candidate_attribute_incorrect"],
  ],
  deduplication_cluster: [
    ["duplicates_merge", "合并重复观察", "duplicate_exact_match"],
    ["duplicates_keep_separate", "保留独立观察", "duplicate_distinct_observation"],
    ["duplicates_needs_changes", "退回修改", "candidate_attribute_incorrect"],
  ],
  conflict: [
    ["conflict_keep_candidate", "保留指定 Candidate", "conflict_newer_supported"],
    ["conflict_keep_existing", "保留既有事实", "conflict_existing_still_authoritative"],
    ["conflict_reject_all", "全部拒绝", "conflict_all_candidates_invalid"],
    ["conflict_unresolved", "继续未决", "conflict_insufficient_evidence"],
  ],
};

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function nextReviewDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

function subjectSummary(subjectType, subject) {
  if (!subject) return [];
  if (subjectType === "source") return [
    ["来源类型", subject.source_type],
    ["采集边界", subject.collection_status],
  ];
  if (subjectType === "candidate") return [
    ["门店", subject.place_id ?? "未匹配"],
    ["属性", subject.attribute],
    ["规范值（合成）", String(subject.normalized_value)],
    ["来源", subject.source_id],
  ];
  if (subjectType === "feedback_candidate") return [
    ["门店", subject.place_id],
    ["候选观察", `${subject.observations.length} 条`],
    ["用户确认", subject.user_confirmed ? "是" : "否"],
    ["事实状态", "未经独立核实"],
  ];
  return [
    ["门店", subject.place_id],
    ["属性", subject.attribute],
    ["Candidate", subject.candidate_ids.join(" · ")],
  ];
}

function candidateChoices(subjectType, subject) {
  if (!["deduplication_cluster", "conflict"].includes(subjectType)) return [];
  return subject?.candidate_ids ?? [];
}

function Metrics({ metrics }) {
  const cards = [
    ["待处理", metrics.unresolved_work_item_count, FileClock],
    ["来源复核", metrics.source_review_due_count, Database],
    ["Candidate", metrics.candidate_pending_count + metrics.feedback_candidate_pending_count, Tags],
    ["冲突 / 去重", metrics.conflict_pending_count + metrics.deduplication_pending_count, ShieldAlert],
  ];
  return (
    <section className="review-metrics" aria-label="审核队列概览">
      {cards.map(([label, value, Icon]) => (
        <article key={label}><Icon aria-hidden="true" /><span>{label}</span><strong>{value}</strong></article>
      ))}
    </section>
  );
}

function ReviewForm({ item, subject, onSaved }) {
  const options = OUTCOME_OPTIONS[item.subject_type];
  const [outcome, setOutcome] = useState(options[0][0]);
  const candidates = candidateChoices(item.subject_type, subject);
  const [selectedCandidateId, setSelectedCandidateId] = useState(candidates[0] ?? "");
  const [error, setError] = useState(null);

  useEffect(() => {
    setOutcome(options[0][0]);
    setSelectedCandidateId(candidates[0] ?? "");
    setError(null);
  }, [item.work_item_id]);

  function submit(event) {
    event.preventDefault();
    const option = options.find(([value]) => value === outcome);
    const selectionRequired = ["duplicates_merge", "conflict_keep_candidate"].includes(outcome);
    try {
      const decision = createReviewDecision({
        subjectType: item.subject_type,
        subject,
        reviewContext: "synthetic_fixture",
        outcome,
        selectedCandidateId: selectionRequired ? selectedCandidateId : null,
        reasonCode: option[2],
        reviewerId: SYNTHETIC_REVIEWER_ID,
        reviewedAt: new Date().toISOString(),
        nextReviewDueAt: item.subject_type === "source" && outcome !== "source_retired" ? nextReviewDate() : null,
      });
      onSaved(decision);
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <form className="review-decision-form" onSubmit={submit}>
      <div className="review-form-heading"><UserRoundCheck aria-hidden="true" /><div><strong>人工决策演练</strong><span>{SYNTHETIC_REVIEWER_ID}</span></div></div>
      <label>受控结果<select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {["duplicates_merge", "conflict_keep_candidate"].includes(outcome) && (
        <label>指定 Candidate<select value={selectedCandidateId} onChange={(event) => setSelectedCandidateId(event.target.value)}>{candidates.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      )}
      <p><LockKeyhole aria-hidden="true" />不接受自由文本；保存后只追加新记录，不静默覆盖。</p>
      {error && <p className="review-error"><TriangleAlert aria-hidden="true" />{error}</p>}
      <button type="submit">保存合成决策</button>
    </form>
  );
}

function FeedbackReviewBoundary({ subject }) {
  return (
    <div className="review-decision-form">
      <div className="review-form-heading"><ShieldAlert aria-hidden="true" /><div><strong>独立核实门禁</strong><span>本条仅为用户确认过的候选观察</span></div></div>
      <p><LockKeyhole aria-hidden="true" />合成工作台不提供“批准为事实”按钮。正式环境必须先补充可追溯来源或独立人工核实，再转换为普通 Candidate。</p>
      <p>当前观察数：{subject?.observations.length ?? 0}；原始自由文本未写入候选记录。</p>
    </div>
  );
}

export function EvidenceReviewWorkbenchApp() {
  const [theme, setTheme] = useState("light");
  const [workspace, setWorkspace] = useState(() => loadSyntheticReviewWorkspace(window.localStorage));
  const [filter, setFilter] = useState("all");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(null);
  const [releaseCreatedAt] = useState(() => new Date().toISOString());
  const decisions = workspace.decisions;
  const workbench = useMemo(() => buildEvidenceReviewWorkbench({
    pipelineState: SYNTHETIC_PIPELINE_STATE,
    candidateState: SYNTHETIC_CANDIDATE_STATE,
    reviewDecisions: decisions,
    reviewContext: "synthetic_fixture",
    today: todayString(),
  }), [decisions]);
  const visibleQueue = workbench.queue.filter((item) => filter === "all" || item.subject_type === filter);
  const selectedItem = visibleQueue.find((item) => item.work_item_id === selectedWorkItemId) ?? visibleQueue[0] ?? null;
  const selectedSubject = selectedItem ? syntheticSubject(selectedItem.subject_type, selectedItem.subject_id) : null;
  const releaseDraft = useMemo(() => createEvidenceReleaseDraft({
    evidenceVersion: "v1.0.0-fixture.local",
    pipelineState: SYNTHETIC_PIPELINE_STATE,
    candidateState: SYNTHETIC_CANDIDATE_STATE,
    reviewDecisions: decisions,
    inputMode: "synthetic_fixture",
    createdBy: SYNTHETIC_REVIEWER_ID,
    createdAt: releaseCreatedAt,
  }), [decisions, releaseCreatedAt]);

  function saveDecision(decision) {
    const next = appendSyntheticReviewDecision(window.localStorage, decision);
    setWorkspace(next);
    setSelectedWorkItemId(null);
  }

  function resetFixture() {
    if (!window.confirm("只清除本浏览器中的 synthetic 审核演练记录？正式数据不会受到影响。")) return;
    setWorkspace(clearSyntheticReviewWorkspace(window.localStorage));
    setSelectedWorkItemId(null);
  }

  return (
    <div className="theme-root" data-theme={theme}>
      <div className="mobile-notice"><img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" /><h1>Evidence Review</h1><p>审核工作台当前仅支持桌面视口。</p></div>
      <main className="review-app-shell">
        <header className="review-topbar">
          <a href="/" className="review-brand"><span className="brand-mark"><img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" /></span><span><strong>QuietLens</strong><small>Evidence Review · local</small></span></a>
          <div className="review-environment"><FlaskConical aria-hidden="true" /><span><strong>synthetic_fixture</strong>仅用于本地工程演练</span></div>
          <nav><a href="/"><ArrowLeft aria-hidden="true" />返回决策界面</a><button type="button" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon aria-hidden="true" /> : <SunMedium aria-hidden="true" />}{theme === "light" ? "夜间" : "日间"}</button></nav>
        </header>

        <div className="review-scroll">
          <section className="review-hero">
            <div><span>Stage 2 · S2-T02</span><h1>证据审核工作台</h1><p>验证来源、Candidate、去重和冲突的操作闭环。这里的内容与决策全部是合成夹具，不代表真实来源或人工验收。</p></div>
            <aside><LockKeyhole aria-hidden="true" /><strong>正式环境保持只读</strong><span>32 来源待复核 · 0 Candidate · 0 Review · 0 Release · 0 Rollback</span></aside>
          </section>

          {workspace.status === "corrupt" && <div className="review-storage-warning"><TriangleAlert aria-hidden="true" /><span><strong>本地演练存储无法读取</strong>已停止加载，避免覆盖原记录。错误码：{workspace.error_code}</span><button type="button" onClick={resetFixture}>清除损坏的 synthetic 记录</button></div>}

          <Metrics metrics={workbench.metrics} />

          <section className="review-main-grid">
            <div className="review-queue-panel">
              <div className="review-panel-heading"><div><span>01</span><h2>待处理队列</h2></div><button type="button" onClick={resetFixture}><RotateCcw aria-hidden="true" />重置演练</button></div>
              <div className="review-filters" role="group" aria-label="筛选队列">
                {[["all", "全部"], ...Object.entries(SUBJECT_LABELS)].map(([value, label]) => <button key={value} className={filter === value ? "is-active" : ""} type="button" onClick={() => { setFilter(value); setSelectedWorkItemId(null); }}>{label}</button>)}
              </div>
              <div className="review-queue-list">
                {visibleQueue.length ? visibleQueue.map((item) => (
                  <button type="button" key={item.work_item_id} className={selectedItem?.work_item_id === item.work_item_id ? "is-selected" : ""} onClick={() => setSelectedWorkItemId(item.work_item_id)}>
                    <span className={`review-priority is-${item.priority}`}>{item.priority === "high" ? "高" : "中"}</span>
                    <span><strong>{SUBJECT_LABELS[item.subject_type]}</strong><small>{REASON_LABELS[item.reason] ?? item.reason}</small><code>{item.subject_id}</code></span>
                  </button>
                )) : <div className="review-empty"><CheckCircle2 aria-hidden="true" /><strong>当前筛选项已处理完</strong><span>不可发布门禁仍然有效。</span></div>}
              </div>
            </div>

            <div className="review-inspector-panel">
              <div className="review-panel-heading"><div><span>02</span><h2>检查与决策</h2></div><em>untrusted</em></div>
              {selectedItem && selectedSubject ? <>
                <div className="review-subject-title"><span>{SUBJECT_LABELS[selectedItem.subject_type]}</span><h3>{selectedItem.subject_id}</h3><p>{REASON_LABELS[selectedItem.reason]}</p></div>
                <dl>{subjectSummary(selectedItem.subject_type, selectedSubject).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                <div className="review-untrusted-note"><ShieldAlert aria-hidden="true" /><span><strong>不执行来源内容</strong>工作台只展示受控字段；原文、指令和 URL 不会在这里执行。</span></div>
                {selectedItem.subject_type === "feedback_candidate"
                  ? <FeedbackReviewBoundary subject={selectedSubject} />
                  : <ReviewForm key={selectedItem.work_item_id} item={selectedItem} subject={selectedSubject} onSaved={saveDecision} />}
              </> : <div className="review-empty review-empty-large"><CheckCircle2 aria-hidden="true" /><strong>没有待处理工作项</strong><span>你可以查看右侧发布门禁，或重置 synthetic 演练。</span></div>}
            </div>

            <aside className="review-release-panel">
              <div className="review-panel-heading"><div><span>03</span><h2>发布门禁</h2></div><em>始终阻断</em></div>
              <div className="review-release-status"><ShieldAlert aria-hidden="true" /><span><strong>不可发布</strong><small>{releaseDraft.release_id}</small></span></div>
              <ul>{releaseDraft.blocking_codes.map((code) => <li key={code}><span>×</span><div><strong>{BLOCK_LABELS[code]}</strong><code>{code}</code></div></li>)}</ul>
              <div className="review-release-facts"><p><span>输入模式</span><strong>{releaseDraft.input_mode}</strong></p><p><span>合成候选</span><strong>{releaseDraft.synthetic_input_count}</strong></p><p><span>AI 是事实来源</span><strong>否</strong></p><p><span>需要二次人工确认</span><strong>是</strong></p></div>
              <p className="review-no-publish"><LockKeyhole aria-hidden="true" />本界面没有发布按钮，也不会调用任何真实来源 API。</p>
            </aside>
          </section>

          <section className="review-history">
            <div className="review-panel-heading"><div><History aria-hidden="true" /><h2>追加式决策历史</h2></div><span>{decisions.length} 条 synthetic 记录</span></div>
            {decisions.length ? <ol>{[...decisions].reverse().map((decision) => <li key={decision.decision_id}><span>{SUBJECT_LABELS[decision.subject_type]}</span><strong>{decision.outcome}</strong><code>{decision.decision_id}</code><time>{new Date(decision.reviewed_at).toLocaleString("zh-CN", { hour12: false })}</time></li>)}</ol> : <p>尚未保存演练决策。正式 ReviewDecision 计数仍为 0。</p>}
          </section>
        </div>
      </main>
    </div>
  );
}
