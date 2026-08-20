import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Armchair,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Calculator,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  ExternalLink,
  LoaderCircle,
  MapPin,
  MessageCircleMore,
  MessageSquareText,
  Moon,
  Pencil,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  SunMedium,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";

import { MapStage } from "../../MapStage.jsx";
import { createAnalyticsEmitter, createRequestId, getSessionId } from "../analytics/emitter.js";
import { correctDecision, interpretDecision, recommendDecision } from "../client/decisionApi.js";
import { getCafeSceneMedia, selectScenePrefetchUrls } from "../media/mediaDelivery.js";
import { getDecodedImageStatus, preloadDecodedImage } from "../media/mediaPrefetch.js";
import {
  explorationScoreBucket,
  getSensoryReferenceProfile,
  SENSORY_DIMENSION_LABELS,
  SENSORY_DIMENSIONS,
  SENSORY_REFERENCE_PROFILE_VERSION,
} from "../evidence/explorationScore.js";
import { buildCandidateCitationView } from "../evidence/citationView.js";
import { applyClarificationAnswer } from "../intent/clarification.js";
import { applyManualFieldEdit } from "../intent/manualFieldEdit.js";
import { decisionReducer, initialDecisionState } from "../state/decisionReducer.js";
import { sceneNoticeForPlace } from "./scenePresentation.js";

const ROLE_LABELS = { primary: "首选", conditional: "条件首选", alternative: "备选" };
const CONFIDENCE_LABELS = { high: "高置信", medium: "中置信", low: "低置信" };
const ATTRIBUTE_LABELS = {
  noise: "声环境",
  crowding: "拥挤程度",
  daylight: "自然光",
  seating: "座位",
  outlets: "插座",
  call_environment: "线上会议环境",
  walk_time: "步行时间",
  realtime_seats: "实时座位",
  realtime_noise: "当前声量",
  outdoor_seating: "户外座位",
  interior: "室内环境",
  size: "空间尺度",
  workspace: "工作空间",
  operating_status: "营业状态",
};
const SENSORY_ICONS = {
  quiet: AudioLines,
  uncrowded: Users,
  daylight: SunMedium,
  seating: Armchair,
};
const UNKNOWN_LABELS = {
  task: "任务类型",
  duration: "停留时长",
  arrival_time: "到达时间",
  leave_time: "离开时间",
  location: "地点",
  walk_time: "步行时间",
};
const CLARIFICATION_COPY = {
  task_details: "这次主要想做什么？也请补充预计停留多久。",
  arrival_time_details: "你计划什么时候到店？",
  duration_details: "你预计会停留多久？",
  location_details: "你想在哪个区域找？",
  call_environment_requirement: "线上会议需要在店内进行吗？",
  maximum_walk_time: "你最多愿意步行多久？",
  outlet_requirement: "插座是必须条件吗？",
  seating_requirement: "适合长时间工作的座位是必须条件吗？",
  noise_tolerance: "你能接受稳定的背景人声吗？",
  crowding_tolerance: "低拥挤对这次决定有多重要？",
  daylight_priority: "自然光是必须优先考虑的吗？",
};
const OPTION_COPY = {
  need_stable_background: "需要，背景声要稳定",
  leave_before_call: "不需要，我会提前离店",
  walk_10: "最多 10 分钟",
  walk_15: "最多 15 分钟",
  walk_20: "最多 20 分钟",
  outlets_required: "必须有插座",
  outlets_preferred: "有插座更好",
  work_seating_required: "必须适合久坐工作",
  any_seating_ok: "普通座位也可以",
  quiet_required: "需要安静工作环境",
  background_voice_ok: "可以接受背景人声",
  low_crowding_required: "尽量避开拥挤",
  moderate_crowding_ok: "适度人流可以接受",
  daylight_high: "自然光很重要",
  daylight_optional: "自然光只是加分项",
  use_conservative_assumption: "暂不确定，按保守情况",
};
const ERROR_COPY = {
  MODEL_NOT_CONFIGURED: "AI 决策服务尚未配置，当前不会使用固定评分伪装推荐。",
  MODEL_TIMEOUT: "意图或决策模型响应超时，你的结构化条件仍然保留。",
  MODEL_UPSTREAM_ERROR: "AI 决策服务暂时不可用，请稍后重试。",
  MODEL_NETWORK_ERROR: "AI 决策服务网络暂时不可用，你的结构化条件仍然保留。",
  EVIDENCE_UNAVAILABLE: "证据服务暂时不可核对，因此本次没有发布候选。",
  EVIDENCE_VERIFICATION_BLOCKED: "本次草稿没有通过证据校验，因此没有发布候选。",
  UNTRUSTED_INSTRUCTION_BLOCKED: "输入包含要求绕过证据、权限或隐私边界的指令，本次请求已阻止。",
};

function inputLengthBucket(value) {
  if (value.length <= 40) return "short";
  if (value.length <= 120) return "medium";
  return "long";
}

function toDateTimeInput(value) {
  return value ? value.slice(0, 16) : "";
}

function arrivalContextLabel(arrivalAt) {
  if (!arrivalAt) return "到店时间未定";
  const date = new Date(arrivalAt);
  if (Number.isNaN(date.getTime())) return "到店时间未定";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
}

function requestRows(request) {
  if (!request) return [];
  const rows = [
    { key: "task", label: "任务", value: `${request.task.type === "focus" ? "专注工作" : request.task.type === "recovery" ? "低刺激恢复" : request.task.type === "conversation" ? "见面交谈" : request.task.type === "call" ? "线上会议" : "其他任务"}${request.task.duration_minutes ? ` ${request.task.duration_minutes} 分钟` : ""}`, kind: "task" },
    { key: "time", label: "时间", value: request.time.arrival_at ? new Date(request.time.arrival_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未指定", kind: "time" },
    { key: "location", label: "地点", value: request.location.area, kind: "location" },
    { key: "walk", label: "步行", value: request.location.max_walk_minutes ? `不超过 ${request.location.max_walk_minutes} 分钟` : "尚未指定", kind: "walk" },
  ];
  for (const constraint of request.hard_constraints) {
    rows.push({ key: `constraint-${constraint.constraint_id}`, label: "硬条件", value: `${ATTRIBUTE_LABELS[constraint.field] ?? constraint.field}必须满足`, kind: "constraint", constraint });
  }
  for (const preference of request.soft_preferences) {
    rows.push({ key: `preference-${preference.field}`, label: ATTRIBUTE_LABELS[preference.field] ?? preference.field, value: `${preference.priority === "high" ? "高" : preference.priority === "medium" ? "中" : "低"}优先级`, kind: "preference", preference });
  }
  for (const field of request.unknowns.filter((item) => UNKNOWN_LABELS[item] || ATTRIBUTE_LABELS[item])) {
    rows.push({ key: `unknown-${field}`, label: "待确认", value: UNKNOWN_LABELS[field] ?? ATTRIBUTE_LABELS[field] ?? field, kind: "unknown", field });
  }
  return rows;
}

function Header({
  theme,
  onTheme,
  onMethod,
  onReset,
  hasDecision,
  area,
  arrivalAt,
}) {
  const ThemeIcon = theme === "light" ? SunMedium : Moon;

  return (
    <header className="ai-topbar">
      <a className="brand" href="#app" aria-label="QuietLens 首页">
        <span className="brand-mark"><img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" /></span>
        <span className="brand-wordmark">QuietLens</span>
      </a>
      <div className="ai-context" aria-label="当前覆盖范围">
        <span><MapPin aria-hidden="true" />{area}</span>
        <i aria-hidden="true" />
        <span><Clock3 aria-hidden="true" />{arrivalContextLabel(arrivalAt)}</span>
      </div>
      <nav className="ai-header-actions" aria-label="全局工具">
        {hasDecision && <button type="button" onClick={onReset}><RotateCcw aria-hidden="true" />新决定</button>}
        <button type="button" onClick={onTheme} title="切换显示模式"><ThemeIcon aria-hidden="true" />{theme === "light" ? "日间模式" : "夜间模式"}</button>
        <button type="button" onClick={() => onMethod("header")}><Database aria-hidden="true" />数据与方法</button>
      </nav>
    </header>
  );
}

function Composer({ value, onChange, onSubmit, disabled, compact = false, onFocus }) {
  return (
    <form className={`ai-composer ${compact ? "is-compact" : ""}`} onSubmit={onSubmit}>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        disabled={disabled}
        maxLength={1200}
        rows={compact ? 2 : 5}
        placeholder={compact ? "补充或纠正条件..." : "例如：明天下午两点，我想在外滩附近专注工作 90 分钟，自然光很重要。"}
        aria-label={compact ? "补充或纠正本次需求" : "描述这次地点需求"}
      />
      <button type="submit" disabled={disabled || !value.trim()} aria-label="提交需求" title="提交需求">
        {disabled ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : compact ? <Send aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
      </button>
    </form>
  );
}

function IntentEditor({ row, request, onSave, onCancel }) {
  const [taskType, setTaskType] = useState(request.task.type);
  const [duration, setDuration] = useState(request.task.duration_minutes ?? "");
  const [arrival, setArrival] = useState(toDateTimeInput(request.time.arrival_at));
  const [area, setArea] = useState(request.location.area);
  const [walk, setWalk] = useState(request.location.max_walk_minutes ?? "");
  const [priority, setPriority] = useState(row.preference?.priority ?? "high");
  const [constraintAction, setConstraintAction] = useState("preference");

  function submit(event) {
    event.preventDefault();
    if (row.kind === "task") onSave({ kind: "task", task_type: taskType, duration_minutes: duration ? Number(duration) : null });
    if (row.kind === "time") onSave({ kind: "time", arrival_at: arrival });
    if (row.kind === "location" && area.trim()) onSave({ kind: "location", area });
    if (row.kind === "walk") onSave({ kind: "walk", minutes: walk ? Number(walk) : null });
    if (row.kind === "preference") onSave({ kind: "preference", field: row.preference.field, priority: priority === "remove" ? null : priority });
    if (row.kind === "constraint") onSave({ kind: "constraint", constraint_id: row.constraint.constraint_id, action: constraintAction });
    if (row.kind === "unknown") onSave({ kind: "unknown", field: row.field });
  }

  return (
    <form className="ai-intent-editor" onSubmit={submit}>
      {row.kind === "task" && <><select value={taskType} onChange={(event) => setTaskType(event.target.value)} aria-label="任务类型"><option value="focus">专注工作</option><option value="recovery">低刺激恢复</option><option value="conversation">见面交谈</option><option value="call">线上会议</option><option value="other">其他任务</option></select><input type="number" min="1" max="480" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="分钟" aria-label="停留分钟数" /></>}
      {row.kind === "time" && <input type="datetime-local" value={arrival} onChange={(event) => setArrival(event.target.value)} aria-label="到达时间" />}
      {row.kind === "location" && <input value={area} onChange={(event) => setArea(event.target.value)} maxLength="40" aria-label="地点" />}
      {row.kind === "walk" && <input type="number" min="1" max="90" value={walk} onChange={(event) => setWalk(event.target.value)} placeholder="不限制" aria-label="最多步行分钟数" />}
      {row.kind === "preference" && <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="偏好优先级"><option value="high">高优先级</option><option value="medium">中优先级</option><option value="low">低优先级</option><option value="remove">删除这项偏好</option></select>}
      {row.kind === "constraint" && <select value={constraintAction} onChange={(event) => setConstraintAction(event.target.value)} aria-label="硬条件处理方式"><option value="preference">改为高优先级偏好</option><option value="remove">删除硬条件</option></select>}
      {row.kind === "unknown" && <p>确认这次不再考虑“{row.value}”</p>}
      <div><button type="submit">保存</button><button type="button" onClick={onCancel}>取消</button></div>
    </form>
  );
}

function IntentSummary({ request, changes, onEdit, disabled, onEditStarted }) {
  const [editingKey, setEditingKey] = useState(null);
  const rows = requestRows(request);
  return (
    <section className="ai-intent" aria-labelledby="intent-title">
      <div className="ai-section-title"><h2 id="intent-title">AI 理解的本次需求</h2><span>可直接修改</span></div>
      <div className="ai-intent-rows">
        {rows.map((row) => editingKey === row.key ? (
          <IntentEditor key={row.key} row={row} request={request} onSave={(edit) => { onEdit(row, edit); setEditingKey(null); }} onCancel={() => setEditingKey(null)} />
        ) : (
          <div key={row.key}><span>{row.label}</span><strong>{row.value}</strong><button type="button" disabled={disabled} onClick={() => { setEditingKey(row.key); onEditStarted(row); }} aria-label={`编辑${row.label}`} title={`编辑${row.label}`}><Pencil aria-hidden="true" /></button></div>
        ))}
      </div>
      {changes?.length > 0 && (
        <p className="ai-change-note"><Check aria-hidden="true" />本轮更新了 {changes.length} 项条件</p>
      )}
    </section>
  );
}

function ProcessStatus({ stage }) {
  const parsing = stage === "F1";
  const correcting = stage === "F6";
  return (
    <section className="ai-progress" aria-live="polite" aria-busy="true">
      <LoaderCircle className="is-spinning" aria-hidden="true" />
      <span className="ai-stage-label"><Sparkles aria-hidden="true" />AI 决策流程</span>
      <h2>{parsing ? "正在理解你的需求" : correcting ? "正在理解这次修改" : "正在比较可行地点"}</h2>
      <p>{parsing ? "提取任务、时间、地点、硬条件和真正需要确认的歧义" : correcting ? "只更新你刚刚修改的条件，并保留其余上下文" : "检索登记证据，程序正在校验硬条件、引用和未知项"}</p>
    </section>
  );
}

function Clarification({ clarification, onAnswer, onTextAnswer, disabled }) {
  const [answer, setAnswer] = useState("");
  const acceptsText = clarification.option_codes.includes("answer_in_own_words");
  return (
    <section className="ai-clarification" aria-labelledby="clarification-title">
      <span className="ai-stage-label"><Sparkles aria-hidden="true" />需要确认一项</span>
      <h2 id="clarification-title">{CLARIFICATION_COPY[clarification.question_code] ?? "这项条件会改变候选结果"}</h2>
      {acceptsText ? (
        <form onSubmit={(event) => { event.preventDefault(); if (answer.trim()) onTextAnswer(answer.trim()); }}>
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="直接用自然语言补充" aria-label="补充本次需求" disabled={disabled} />
          <button type="submit" disabled={disabled || !answer.trim()}><Send aria-hidden="true" />提交补充</button>
        </form>
      ) : <div>
        {clarification.option_codes.filter((code) => code !== "answer_in_own_words").map((code) => (
          <button key={code} type="button" onClick={() => onAnswer(code)}>{OPTION_COPY[code] ?? code}</button>
        ))}
      </div>}
    </section>
  );
}

function CandidateList({ brief, context, selectedId, onSelect, onPrefetch }) {
  const placeById = new Map(context.places.map((place) => [place.place_id, place]));
  const constraintById = new Map(brief.request.hard_constraints.map((constraint) => [constraint.constraint_id, constraint]));
  return (
    <section className="ai-candidates" aria-labelledby="candidate-title">
      <div className="ai-section-title"><h2 id="candidate-title">AI 决策比较</h2><span>{brief.candidates.length} 个比较项</span></div>
      <div className="ai-candidate-list">
        {brief.candidates.map((candidate, index) => {
          const place = placeById.get(candidate.place_id);
          const evidenceCount = new Set([
            ...candidate.fit_reasons.flatMap((reason) => reason.evidence_ids),
            ...candidate.tradeoffs.flatMap((reason) => reason.evidence_ids),
          ]).size;
          const pendingHardFields = candidate.hard_constraint_results
            .filter((result) => result.status === "unknown")
            .map((result) => constraintById.get(result.constraint_id)?.field)
            .filter(Boolean);
          return (
            <button
              key={candidate.place_id}
              type="button"
              className={selectedId === candidate.place_id ? "is-selected" : ""}
              onMouseEnter={() => onPrefetch(candidate.place_id, "candidate_hover")}
              onFocus={() => onPrefetch(candidate.place_id, "candidate_focus")}
              onTouchStart={() => onPrefetch(candidate.place_id, "candidate_touch")}
              onClick={() => onSelect(candidate.place_id, "list")}
            >
              <span className="ai-candidate-rank">{index + 1}</span>
              <span className="ai-candidate-copy">
                <span><em>{pendingHardFields.length ? "待核实" : ROLE_LABELS[candidate.role]}</em><strong>{place?.canonical_name ?? candidate.place_id}</strong></span>
                <small>{candidate.fit_reasons[0]?.text ?? "证据有限"}</small>
                {pendingHardFields.length > 0 && <small className="ai-pending-hard">尚不能确认：{pendingHardFields.map((field) => ATTRIBUTE_LABELS[field] ?? field).join("、")}</small>}
                <span className={`ai-confidence is-${candidate.confidence.level}`}>{CONFIDENCE_LABELS[candidate.confidence.level]}</span>
                <small>证据 {evidenceCount} 条</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FailureState({ state, onRetry, onReset }) {
  const refusal = state.brief?.refusal;
  const message = refusal
    ? refusal.reason_code === "coverage_out_of_scope"
      ? "当前 MVP 只覆盖黄浦区 10 家核实门店。"
      : refusal.reason_code === "hard_constraints_no_result"
        ? "没有候选能够明确满足全部硬约束。"
        : "现有证据不足以形成两个可比较候选。"
    : ERROR_COPY[state.errorCode] ?? "本次决策没有通过发布门禁。";
  return (
    <section className="ai-failure" aria-live="polite">
      <TriangleAlert aria-hidden="true" />
      <h2>这次不能可靠地给出决定</h2>
      <p>{message}</p>
      {refusal?.relaxable_fields?.length > 0 && <small>可重新考虑：{refusal.relaxable_fields.map((field) => ATTRIBUTE_LABELS[field] ?? field).join("、")}</small>}
      {!refusal && <button type="button" onClick={onRetry}>重试</button>}
      <button type="button" onClick={onReset}>开始新问题</button>
    </section>
  );
}

function attributeList(attributes) {
  return attributes.map((field) => ATTRIBUTE_LABELS[field] ?? field).join("、");
}

function nonRecommendationReason(exploration, request, candidateCount) {
  const explicitFields = new Set([
    ...request.hard_constraints.map((constraint) => constraint.field),
    ...request.soft_preferences.map((preference) => preference.field),
  ]);
  const explicitUnknowns = exploration.unknown_attributes.filter((field) => explicitFields.has(field));
  if (exploration.eligibility === "rejected") {
    const conflicts = exploration.not_matched_attributes.length
      ? `：${attributeList(exploration.not_matched_attributes)}`
      : "";
    return `本店已有登记信息与本次硬条件不一致${conflicts}。`;
  }
  if (exploration.not_matched_attributes.length) {
    return `本店在${attributeList(exploration.not_matched_attributes)}上有需要权衡的登记信息，因此未进入本轮 ${candidateCount} 家推荐。`;
  }
  if (exploration.eligibility === "uncertain" || explicitUnknowns.length) {
    const unknowns = explicitUnknowns.length ? explicitUnknowns : exploration.unknown_attributes.slice(0, 3);
    return `本店关于${attributeList(unknowns)}的证据仍不足，因此未进入本轮 ${candidateCount} 家推荐。`;
  }
  return `本店已进入比较范围，但相较本轮 ${candidateCount} 家候选，没有形成更强的本次需求证据组合。`;
}

function StoreProfile({ placeId, score, arrivalAt }) {
  const profile = getSensoryReferenceProfile(placeId, arrivalAt);
  if (!profile) return null;
  return (
    <div className="ai-store-profile">
      <div className="ai-store-match-summary">
        <div><strong>{score ?? "待补充"}</strong><span>综合参考</span></div>
        <div className="ai-store-confidence"><span>置信度 {profile.confidence}%</span><i><b style={{ width: `${profile.confidence}%` }} /></i></div>
      </div>
      <section className="ai-store-time"><Clock3 aria-hidden="true" /><div><span>适合时段</span><strong>{profile.best_time}</strong></div></section>
      <section className="ai-store-dimensions" aria-label="本店四项感官参考">
        {SENSORY_DIMENSIONS.map((dimension) => {
          const Icon = SENSORY_ICONS[dimension];
          const value = profile.display_scores[dimension];
          return (
            <div key={dimension}><Icon aria-hidden="true" /><span>{SENSORY_DIMENSION_LABELS[dimension]}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>
          );
        })}
      </section>
      <section className="ai-store-field-note">
        <h3>来自现场</h3>
        <div><MessageCircleMore aria-hidden="true" /><p>{profile.evidence}</p></div>
        <small><ShieldCheck aria-hidden="true" />{profile.source_status}</small>
      </section>
    </div>
  );
}

function CandidateEvidence({ candidate, context, emit }) {
  const records = buildCandidateCitationView(candidate, context);
  const viewedEvidence = useRef(new Set());

  if (records.length === 0) return null;

  function recordViewed(record, open) {
    if (!open || viewedEvidence.current.has(record.evidence_id)) return;
    viewedEvidence.current.add(record.evidence_id);
    emit("evidence_record_viewed", "F5", {
      place_id: candidate.place_id,
      evidence_id: record.evidence_id,
      attribute: record.attribute,
    });
  }

  function sourceOpened(source) {
    emit("evidence_source_opened", "F5", {
      place_id: candidate.place_id,
      source_id: source.source_id,
      source_type: source.source_type,
    });
  }

  return (
    <section className="ai-candidate-evidence" aria-labelledby="candidate-evidence-title">
      <h3 id="candidate-evidence-title"><Database aria-hidden="true" />决策依据</h3>
      <p className="ai-evidence-boundary">以下记录直接支持本轮理由、权衡或硬条件判断。来源内容只作为证据，不是实时状态保证。</p>
      <div className="ai-evidence-list">
        {records.map((record) => (
          <details key={record.evidence_id} onToggle={(event) => recordViewed(record, event.currentTarget.open)}>
            <summary><strong>{ATTRIBUTE_LABELS[record.attribute] ?? record.attribute}</strong><span>{record.kind_labels.join(" · ")}</span></summary>
            <p>{record.display_text}</p>
            <span>核实于 {record.verified_at ?? "日期未登记"} · {record.reliability === "high" ? "高可靠度" : record.reliability === "medium" ? "中可靠度" : "低可靠度"}</span>
            {record.sources.map((source) => source.url ? (
              <a key={source.source_id} href={source.url} target="_blank" rel="noreferrer" onClick={() => sourceOpened(source)}>
                <span>{source.publisher} · {source.title}</span><ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <small key={source.source_id}>{source.publisher} · {source.title}</small>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}

function DecisionRail({ state, onClose, emit }) {
  const { brief, context, selectedPlaceId } = state;
  if (!brief) return null;
  const candidate = brief.candidates.find((item) => item.place_id === selectedPlaceId) ?? null;
  const place = context?.places.find((item) => item.place_id === selectedPlaceId) ?? null;
  const exploration = context?.exploration?.places.find((item) => item.place_id === selectedPlaceId) ?? null;

  if (candidate && place) {
    return (
      <aside className="ai-decision-rail" aria-labelledby="place-detail-title">
        <button className="ai-rail-close" type="button" onClick={onClose} aria-label="关闭门店证据"><X aria-hidden="true" /></button>
        <div className="ai-store-status is-recommended">
          <span>AI 本轮推荐 · {ROLE_LABELS[candidate.role]}</span>
          <strong>{candidate.fit_reasons.map((reason) => reason.text).join("；")}</strong>
          {candidate.tradeoffs.length > 0 && <p>需要权衡：{candidate.tradeoffs.map((reason) => reason.text).join("；")}</p>}
          <small>{CONFIDENCE_LABELS[candidate.confidence.level]}</small>
        </div>
        <h2 id="place-detail-title">{place.canonical_name}</h2>
        <p className="ai-place-address"><MapPin aria-hidden="true" />{place.address}</p>
        {!place.asset && <p className="ai-asset-pending">门店水彩场景待补充，当前仍可查看已核实的文字证据。</p>}
        <CandidateEvidence candidate={candidate} context={context} emit={emit} />
        <StoreProfile placeId={place.place_id} score={exploration?.score} arrivalAt={brief.request.time.arrival_at} />
      </aside>
    );
  }

  if (exploration && place) {
    return (
      <aside className="ai-decision-rail" aria-labelledby="place-detail-title">
        <button className="ai-rail-close" type="button" onClick={onClose} aria-label="关闭门店证据"><X aria-hidden="true" /></button>
        <div className="ai-store-status is-not-recommended"><span>本轮未推荐</span><strong>{nonRecommendationReason(exploration, brief.request, brief.candidates.length)}</strong></div>
        <h2 id="place-detail-title">{place.canonical_name}</h2>
        <p className="ai-place-address"><MapPin aria-hidden="true" />{place.address}</p>
        {!place.asset && <p className="ai-asset-pending">门店水彩场景待补充，当前仍可查看已核实的文字证据。</p>}
        <StoreProfile placeId={place.place_id} score={exploration.score} arrivalAt={brief.request.time.arrival_at} />
      </aside>
    );
  }

  const unknowns = [...new Set(brief.candidates.flatMap((item) => item.unknowns))];
  return (
    <aside className="ai-decision-rail" aria-labelledby="decision-summary-title">
      <span className="ai-rail-kicker">已通过证据校验</span>
      <h2 id="decision-summary-title">本次决策摘要</h2>
      <p>系统只比较了黄浦区登记范围内、没有明确违反硬约束的门店。候选理由来自已登记证据，实时座位与当前声量不会被当作事实。</p>
      <section><h3><Sparkles aria-hidden="true" />本次假设</h3><p>{brief.request.assumptions.length ? brief.request.assumptions.join("；") : "没有替用户增加未确认假设"}</p></section>
      <section><h3><CircleHelp aria-hidden="true" />仍然未知</h3><p>{unknowns.length ? unknowns.map((item) => ATTRIBUTE_LABELS[item] ?? item).join("、") : "本次候选没有额外未知项"}</p></section>
      <section><h3><ShieldCheck aria-hidden="true" />证据范围</h3><p>黄浦区 10 家 · 公开来源 · v{brief.versions.evidence_store}</p></section>
    </aside>
  );
}

function MethodDialog({ onClose }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="guide-dialog method-dialog" role="dialog" aria-modal="true" aria-labelledby="method-title" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="dialog-close" aria-label="关闭数据与方法" onClick={onClose}><X aria-hidden="true" /></button>
        <h2 id="method-title">数据与方法</h2>
        <div className="method-list">
          <div><Sparkles aria-hidden="true" /><span><strong>模型职责</strong>解释自然语言并比较已过滤候选，不生成门店事实。</span></div>
          <div><Database aria-hidden="true" /><span><strong>证据范围</strong>当前只使用黄浦区 10 家的版本化公开证据。</span></div>
          <div><ShieldCheck aria-hidden="true" /><span><strong>发布门禁</strong>候选、引用、硬约束和置信度在展示前由程序校验。</span></div>
          <div><Calculator aria-hidden="true" /><span><strong>综合参考</strong>AI 理解本次偏好，程序结合四项编辑参考与登记证据；不代表实时状态。</span></div>
        </div>
      </section>
    </div>
  );
}

export function QuietLensDecisionApp() {
  const [state, dispatch] = useReducer(decisionReducer, initialDecisionState);
  const [input, setInput] = useState("");
  const [correction, setCorrection] = useState("");
  const [theme, setTheme] = useState("light");
  const [methodOpen, setMethodOpen] = useState(false);
  const [mapRegion, setMapRegion] = useState("shanghai");
  const [requestId, setRequestId] = useState(() => createRequestId());
  const sessionId = useMemo(() => getSessionId(), []);
  const analyticsContext = useRef({ request_id: requestId, model: "not-invoked", prompt: "not-invoked" });
  const exposed = useRef(new Set());
  const [sceneStatuses, setSceneStatuses] = useState({});
  analyticsContext.current = {
    request_id: requestId,
    model: state.brief?.versions?.model ?? state.versions?.intent_model ?? "not-invoked",
    prompt: state.brief?.versions?.prompt ?? state.versions?.intent_prompt ?? "not-invoked",
  };
  const emit = useMemo(() => createAnalyticsEmitter({ sessionId, getVersions: () => analyticsContext.current }), [sessionId]);

  useEffect(() => {
    if (exposed.current.has(`state-${requestId}-F0`)) return;
    exposed.current.add(`state-${requestId}-F0`);
    emit("page_state_viewed", "F0", { state_code: "decision_entry" });
    emit("new_decision_started", "F0", { previous_request_status: "none" });
  }, [emit, requestId]);

  useEffect(() => {
    if (state.stage === "F2" && state.clarification && !exposed.current.has(`clarification-${requestId}`)) {
      exposed.current.add(`clarification-${requestId}`);
      emit("clarification_viewed", "F2", { target_field: state.clarification.target_field });
    }
    if (state.stage === "F4" && state.brief && !exposed.current.has(`brief-${requestId}`)) {
      exposed.current.add(`brief-${requestId}`);
      const unknowns = new Set(state.brief.candidates.flatMap((candidate) => candidate.unknowns));
      emit("decision_brief_viewed", "F4", { candidate_count: state.brief.candidates.length, unknown_count: unknowns.size, assumption_count: state.brief.request.assumptions.length });
      emit("candidate_list_viewed", "F4", { candidate_count: state.brief.candidates.length, role_order: state.brief.candidates.map((candidate) => candidate.role) });
      emit("evidence_scope_viewed", "F4", { place_scope_count: 10, source_type_count: new Set(state.context.sources.map((source) => source.source_type)).size });
      state.brief.candidates.forEach((candidate) => {
        const evidenceCount = new Set([...candidate.fit_reasons.flatMap((reason) => reason.evidence_ids), ...candidate.tradeoffs.flatMap((reason) => reason.evidence_ids)]).size;
        emit("candidate_card_viewed", "F4", { place_id: candidate.place_id, role: candidate.role, confidence_level: candidate.confidence.level, evidence_count: evidenceCount });
        emit("candidate_marker_viewed", "F4", { place_id: candidate.place_id, role: candidate.role });
      });
      const candidateIds = new Set(state.brief.candidates.map((candidate) => candidate.place_id));
      (state.context.exploration?.places ?? []).filter((place) => !candidateIds.has(place.place_id)).forEach((place) => {
        emit("exploration_marker_viewed", "F4", { place_id: place.place_id, score_bucket: explorationScoreBucket(place.score), eligibility: place.eligibility });
      });
    }
    if (state.stage === "F7" && state.brief?.refusal && !exposed.current.has(`refusal-${requestId}`)) {
      exposed.current.add(`refusal-${requestId}`);
      emit("decision_refusal_viewed", "F7", { refusal_type: state.brief.refusal.reason_code, hard_constraint_count: state.request?.hard_constraints.length ?? 0, relaxable_fields: state.brief.refusal.relaxable_fields });
    }
    if (["F1", "F2", "F3", "F6", "F7"].includes(state.stage) && !exposed.current.has(`state-${requestId}-${state.stage}`)) {
      exposed.current.add(`state-${requestId}-${state.stage}`);
      emit("page_state_viewed", state.stage, { state_code: state.stage.toLowerCase() });
    }
  }, [emit, requestId, state]);

  useEffect(() => {
    if (state.brief?.status !== "published" || !state.context?.places) return undefined;
    const urls = selectScenePrefetchUrls(
      state.context.places,
      state.brief.candidates.map((candidate) => candidate.place_id),
    );
    urls.forEach((url, index) => prefetchSceneUrl(url, index === 0 ? "high" : "low"));
    return undefined;
  }, [state.brief, state.context]);

  function prefetchSceneUrl(url, fetchPriority = "low") {
    if (!url) return;
    const currentStatus = getDecodedImageStatus(url);
    setSceneStatuses((current) => current[url] === currentStatus && currentStatus !== "idle"
      ? current
      : { ...current, [url]: currentStatus === "idle" ? "loading" : currentStatus });
    if (currentStatus === "ready" || currentStatus === "failed") return;
    preloadDecodedImage(url, { fetchPriority })
      .then(() => setSceneStatuses((current) => ({ ...current, [url]: "ready" })))
      .catch(() => setSceneStatuses((current) => ({ ...current, [url]: "failed" })));
  }

  function prefetchPlaceScene(placeId, source = "intent") {
    const place = state.context?.places?.find((item) => item.place_id === placeId);
    const url = getCafeSceneMedia(place?.asset)?.scene?.src;
    prefetchSceneUrl(url, source.includes("click") || source.includes("touch") ? "high" : "low");
  }

  async function runRecommendation(request) {
    dispatch({ type: "DECISION_STARTED" });
    try {
      const result = await recommendDecision({ session_id: sessionId, request });
      dispatch({ type: "DECIDED", payload: result });
    } catch (error) {
      dispatch({ type: "FAILED", errorCode: error.code });
    }
  }

  async function submitInitial(event) {
    event.preventDefault();
    if (!input.trim()) return;
    setMapRegion("huangpu");
    dispatch({ type: "PARSE_STARTED" });
    emit("decision_request_submitted", "F0", { input_length_bucket: inputLengthBucket(input.trim()), entry_context: "primary_composer" });
    try {
      const result = await interpretDecision({
        session_id: sessionId,
        request_id: requestId,
        user_text: input,
        mode: "initial",
        page_context: { area: "黄浦区" },
      });
      dispatch({ type: "INTERPRETED", payload: result });
      emit("intent_summary_viewed", "F1", { field_count: requestRows(result.request).length, unknown_count: result.request.unknowns.length });
      if (!result.clarification.required) await runRecommendation(result.request);
    } catch (error) {
      dispatch({ type: "FAILED", errorCode: error.code });
    }
  }

  async function answerClarification(code) {
    const next = applyClarificationAnswer(state.request, state.clarification, code);
    const skipped = code === "use_conservative_assumption";
    emit(skipped ? "clarification_skipped" : "clarification_answered", "F2", skipped
      ? { target_field: state.clarification.target_field, conservative_assumption_used: true }
      : { target_field: state.clarification.target_field, answer_code: code });
    dispatch({ type: "CLARIFICATION_APPLIED", request: next });
    await runRecommendation(next);
  }

  async function answerClarificationText(answer) {
    const targetField = state.clarification.target_field;
    emit("clarification_answered", "F2", { target_field: targetField, answer_code: "natural_language" });
    dispatch({ type: "CLARIFICATION_PARSE_STARTED" });
    try {
      const result = await interpretDecision({
        session_id: sessionId,
        request_id: state.request.request_id,
        current_request: state.request,
        user_text: answer,
        mode: "correction",
        clarification_already_asked: true,
        page_context: { area: state.request.location.area },
      });
      dispatch({ type: "INTERPRETED", payload: result });
      await runRecommendation(result.request);
    } catch (error) {
      dispatch({ type: "FAILED", errorCode: error.code });
    }
  }

  async function submitCorrection(event) {
    event.preventDefault();
    if (!correction.trim() || !state.request) return;
    const beforeIds = state.brief?.candidates.map((candidate) => candidate.place_id).join(",") ?? "";
    dispatch({ type: "CORRECTION_STARTED" });
    emit("correction_submitted", "F6", { changed_field_count: 0 });
    try {
      const result = await correctDecision({
        session_id: sessionId,
        request_id: state.request.request_id,
        current_request: state.request,
        user_text: correction,
        clarification_already_asked: true,
      });
      dispatch({ type: "CORRECTED", payload: result });
      setCorrection("");
      const afterIds = result.brief?.candidates.map((candidate) => candidate.place_id).join(",") ?? "";
      emit("correction_result_viewed", "F6", { changed_field_count: result.changes.length, candidate_changed: beforeIds !== afterIds });
    } catch (error) {
      dispatch({ type: "FAILED", errorCode: error.code });
    }
  }

  async function editIntentField(row, edit) {
    if (!state.request) return;
    const result = applyManualFieldEdit(state.request, edit);
    dispatch({ type: "MANUAL_EDIT_APPLIED", request: result.request, changedFields: result.changedFields });
    for (const fieldName of result.changedFields) {
      emit("intent_field_updated", "F1", { field_name: fieldName, change_type: edit.action === "remove" || edit.priority === null ? "removed" : "set" });
    }
    await runRecommendation(result.request);
  }

  function selectPlace(placeId, source) {
    const candidate = state.brief.candidates.find((item) => item.place_id === placeId);
    const exploration = state.context?.exploration?.places.find((item) => item.place_id === placeId);
    if (!candidate && !exploration) return;
    prefetchPlaceScene(placeId, `${source}_click`);
    dispatch({ type: "PLACE_SELECTED", placeId });
    if (candidate) {
      emit("candidate_selected", "F4", { place_id: placeId, role: candidate.role, source });
    } else {
      emit("exploration_place_selected", "F4", { place_id: placeId, score_bucket: explorationScoreBucket(exploration.score), eligibility: exploration.eligibility, source });
    }
    emit("place_detail_opened", "F5", { place_id: placeId, source });
    emit("store_profile_viewed", "F5", {
      place_id: placeId,
      recommendation_status: candidate?.role ?? "not_recommended",
      profile_version: SENSORY_REFERENCE_PROFILE_VERSION,
    });
  }

  function clearPlace(source = "close_button") {
    if (!state.selectedPlaceId) return;
    emit("place_detail_closed", "F5", { place_id: state.selectedPlaceId, close_source: source, request_preserved: true });
    dispatch({ type: "PLACE_CLEARED" });
  }

  function reset() {
    emit("new_decision_started", "F0", { previous_request_status: state.status });
    dispatch({ type: "RESET" });
    setInput("");
    setCorrection("");
    setMapRegion("shanghai");
    const nextId = createRequestId();
    setRequestId(nextId);
  }

  const mapCafes = useMemo(() => {
    const placeById = new Map((state.context?.places ?? []).map((place) => [place.place_id, place]));
    const candidateById = new Map((state.brief?.candidates ?? []).map((candidate, index) => [candidate.place_id, { candidate, index }]));
    const explorationById = new Map((state.context?.exploration?.places ?? []).map((place) => [place.place_id, place]));
    return [...placeById.values()].map((place) => {
      const match = candidateById.get(place.place_id);
      const exploration = explorationById.get(place.place_id);
      const media = getCafeSceneMedia(place.asset);
      const nonRecommendationText = !match && exploration
        ? nonRecommendationReason(exploration, state.brief.request, state.brief.candidates.length)
        : null;
      return {
        id: place.place_id,
        name: place.canonical_name,
        shortName: place.canonical_name,
        address: place.address,
        district: "黄浦区",
        position: [place.location.latitude, place.location.longitude],
        scene: media?.scene?.src ?? null,
        sceneStatus: media?.scene?.src
          ? sceneStatuses[media.scene.src] ?? getDecodedImageStatus(media.scene.src)
          : "failed",
        notice: sceneNoticeForPlace({
          candidate: match?.candidate ?? null,
          nonRecommendationText,
          unknownLabel: (field) => ATTRIBUTE_LABELS[field] ?? field,
        }),
        role: match?.candidate.role ?? null,
        matchScore: exploration?.score ?? null,
        markerLabel: match ? match.index + 1 : exploration?.score ?? "待核",
        selectable: Boolean(match || exploration),
      };
    });
  }, [sceneStatuses, state.brief, state.context]);
  const selectedCafe = mapCafes.find((cafe) => cafe.id === state.selectedPlaceId) ?? null;
  const showRail = state.brief?.status === "published";
  const busy = ["parsing", "retrieving", "correcting"].includes(state.status);
  const headerArea = state.stage === "F0" ? "上海" : state.request?.location.area ?? "上海";

  function changeMapRegion(nextRegion, source) {
    if (nextRegion === mapRegion) return;
    emit("map_board_changed", state.stage, { from_region: mapRegion, to_region: nextRegion, source });
    setMapRegion(nextRegion);
  }

  function openMethod(source) {
    emit("data_method_opened", state.stage, { source });
    setMethodOpen(true);
  }

  return (
    <div className="theme-root" data-theme={theme}>
      <div className="mobile-notice"><img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" /><h1>QuietLens</h1><p>当前阶段专注桌面决策体验，请使用更宽的视口打开。</p></div>
      <main id="app" className="app-shell ai-shell">
        <Header
          theme={theme}
          onTheme={() => setTheme((value) => value === "light" ? "dark" : "light")}
          onMethod={openMethod}
          onReset={reset}
          hasDecision={state.stage !== "F0"}
          area={headerArea}
          arrivalAt={state.request?.time.arrival_at}
        />
        <div className={`workspace ai-workspace ${showRail ? "has-rail" : ""}`}>
          <aside className="sidebar ai-sidebar">
            {state.stage === "F0" ? (
              <section className="ai-entry">
                <span className="ai-stage-label">新决定</span>
                <h1>接下来，想找个地方做什么？</h1>
                <Composer value={input} onChange={setInput} onSubmit={submitInitial} disabled={busy} />
                <div className="ai-examples"><button type="button" onClick={() => setInput("明天下午两点，我想在外滩附近专注工作 90 分钟，自然光很重要。")}>限时专注</button><button type="button" onClick={() => setInput("我现在很累，想在黄浦找个低刺激、不要太吵的地方休息。")}>低刺激恢复</button></div>
              </section>
            ) : (
              <>
                <section className="ai-original-request"><span>你说的是</span><p>{input || correction || "已保留本次需求"}</p></section>
                {state.stage === "F1" && !state.request && <ProcessStatus stage="F1" />}
                {state.stage === "F2" && state.clarification && <Clarification clarification={state.clarification} onAnswer={answerClarification} onTextAnswer={answerClarificationText} disabled={busy} />}
                {state.request && <IntentSummary request={state.request} changes={state.changes} disabled={busy} onEdit={editIntentField} onEditStarted={(row) => emit("intent_field_edit_started", "F1", { field_name: row.kind, previous_state: row.value === "尚未指定" ? "empty" : "set" })} />}
                {state.stage === "F3" && <ProcessStatus stage="F3" />}
                {state.stage === "F6" && <ProcessStatus stage="F6" />}
                {state.brief?.status === "published" && <CandidateList brief={state.brief} context={state.context} selectedId={state.selectedPlaceId} onSelect={selectPlace} onPrefetch={prefetchPlaceScene} />}
                {state.stage === "F7" && <FailureState state={state} onRetry={() => state.request ? runRecommendation(state.request) : reset()} onReset={reset} />}
                {state.brief?.status === "published" && <div className="ai-correction"><div className="ai-correction-heading"><strong>继续修改本次条件</strong><button type="button" onClick={reset}><RotateCcw aria-hidden="true" />开始新问题</button></div><p>这里会保留上面的任务、时间和硬条件。</p><Composer value={correction} onChange={setCorrection} onSubmit={submitCorrection} disabled={busy} compact onFocus={() => emit("correction_started", "F6", {})} /></div>}
              </>
            )}
          </aside>
          <section className="map-workspace ai-map-workspace">
            <MapStage
              cafes={mapCafes}
              region={mapRegion}
              drawerOpen={false}
              selectedCafe={selectedCafe}
              onSelect={(placeId) => selectPlace(placeId, "map")}
              onPrefetch={prefetchPlaceScene}
              onClearSelection={() => clearPlace("map_blank")}
              onRegionChange={changeMapRegion}
            />
          </section>
          {showRail && <DecisionRail state={state} onClose={() => clearPlace("close_button")} emit={emit} />}
        </div>
      </main>
      {methodOpen && <MethodDialog onClose={() => setMethodOpen(false)} />}
    </div>
  );
}
