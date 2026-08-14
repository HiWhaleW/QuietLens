import { useMemo, useState } from "react";
import {
  Armchair,
  AudioLines,
  Calculator,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coffee,
  Database,
  ExternalLink,
  Info,
  Laptop,
  MapPin,
  Menu,
  MessageCircleMore,
  Moon,
  ShieldCheck,
  SunMedium,
  Users,
  UsersRound,
  X,
} from "lucide-react";

import { MapStage } from "./MapStage.jsx";
import {
  CAFES,
  DIMENSIONS,
  DIMENSION_LABELS,
  SCENARIOS,
  VISIT_TIMES,
} from "./data.js";
import { scoreCafe } from "./scoring.js";

const SCENARIO_ICONS = {
  deepWork: Laptop,
  unwind: Coffee,
  social: UsersRound,
};

const DIMENSION_ICONS = {
  quiet: AudioLines,
  uncrowded: Users,
  daylight: SunMedium,
  seating: Armchair,
};

const MAP_REGIONS = {
  shanghai: "上海全域",
  central: "中心城区",
  huangpu: "黄浦区",
};

function Header({ region, onRegion, visitTime, onVisitTime, theme, onToggleTheme, onOpenGuide, onOpenMethod }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ThemeIcon = theme === "light" ? SunMedium : Moon;

  function openMethod() {
    setMenuOpen(false);
    onOpenMethod();
  }

  return (
    <header className="topbar">
      <a className="brand" href="#app" aria-label="QuietLens 首页">
        <span className="brand-mark"><img src="/assets/brand/quietlens-mark.png" alt="" /></span>
        <span className="brand-wordmark">QuietLens</span>
      </a>

      <div className="header-filters" aria-label="当前地区和时段">
        <label className="header-select">
          <MapPin aria-hidden="true" />
          <select
            aria-label="选择地区"
            value={region}
            onChange={(event) => onRegion(event.target.value)}
          >
            {Object.entries(MAP_REGIONS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <span className="header-divider" aria-hidden="true" />
        <label className="header-select">
          <Clock3 aria-hidden="true" />
          <select
            aria-label="选择时段"
            value={visitTime}
            onChange={(event) => onVisitTime(event.target.value)}
          >
            {Object.entries(VISIT_TIMES).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
      </div>

      <nav className="header-actions" aria-label="全局工具">
        <button
          className="text-button"
          type="button"
          title={`切换为${theme === "light" ? "夜间" : "日间"}模式`}
          aria-label={`当前为${theme === "light" ? "日间" : "夜间"}模式，切换为${theme === "light" ? "夜间" : "日间"}模式`}
          aria-pressed={theme === "dark"}
          onClick={onToggleTheme}
        >
          <ThemeIcon aria-hidden="true" />
          <span>{theme === "light" ? "日间模式" : "夜间模式"}</span>
        </button>
        <button className="text-button" type="button" onClick={onOpenGuide}>
          <CircleHelp aria-hidden="true" />
          <span>使用指南</span>
        </button>
        <div className="menu-wrap">
          <button
            className="text-button"
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Menu aria-hidden="true" />
            <span>菜单</span>
          </button>
          {menuOpen && (
            <div className="header-menu" role="menu">
              <button type="button" role="menuitem" onClick={openMethod}>数据与方法</button>
              <a href="https://github.com/AiWhale980728/QuietLens" target="_blank" rel="noreferrer" role="menuitem">
                GitHub <ExternalLink aria-hidden="true" />
              </a>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}

function ScenarioPicker({ scenario, onChange }) {
  return (
    <section className="scenario-section" aria-labelledby="scenario-heading">
      <h2 id="scenario-heading">此刻想做什么</h2>
      <div className="scenario-tabs" role="radiogroup" aria-label="当前场景">
        {Object.entries(SCENARIOS).map(([id, item]) => {
          const Icon = SCENARIO_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              className={scenario === id ? "is-active" : ""}
              role="radio"
              aria-checked={scenario === id}
              onClick={() => onChange(id)}
            >
              <Icon aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PreferenceSliders({ preferences, onChange }) {
  return (
    <section className="preferences" aria-label="感官偏好">
      {DIMENSIONS.map((dimension) => (
        <label className="preference" key={dimension}>
          <span className="preference-label">
            <span>{DIMENSION_LABELS[dimension]} <Info aria-hidden="true" /></span>
            <strong>{preferences[dimension]}</strong>
          </span>
          <span className="range-wrap">
            <span className="range-track" aria-hidden="true">
              <i style={{ width: `${(preferences[dimension] - 20) / 0.8}%` }} />
            </span>
            <input
              type="range"
              min="20"
              max="100"
              value={preferences[dimension]}
              aria-label={DIMENSION_LABELS[dimension]}
              onChange={(event) => onChange(dimension, Number(event.target.value))}
            />
          </span>
        </label>
      ))}
    </section>
  );
}

function RankedList({ cafes, selectedId, expanded, onToggle, onSelect }) {
  const visibleCafes = expanded ? cafes : cafes.slice(0, 5);

  return (
    <section className="recommendations" aria-labelledby="recommendations-heading">
      <div className="section-heading">
        <h2 id="recommendations-heading">推荐地点</h2>
        <span aria-hidden="true" />
      </div>
      <ol>
        {visibleCafes.map((cafe, index) => (
          <li key={cafe.id} className={selectedId === cafe.id ? "is-selected" : ""}>
            <button type="button" onClick={() => onSelect(cafe.id)} aria-current={selectedId === cafe.id ? "true" : undefined}>
              <span className="rank">{index + 1}</span>
              <span className="cafe-name">{cafe.shortName}</span>
              <strong>{cafe.matchScore}</strong>
            </button>
          </li>
        ))}
      </ol>
      <button className="show-more" type="button" onClick={onToggle}>
        {expanded ? "收起地点" : "查看更多地点"}
        <ChevronDown className={expanded ? "is-open" : ""} aria-hidden="true" />
      </button>
    </section>
  );
}

function DetailsDrawer({ cafe, open, onClose, onOpen }) {
  if (!cafe) return null;

  return (
    <>
      <button
        type="button"
        className={`drawer-reopen ${open ? "is-hidden" : ""}`}
        aria-label="展开地点详情"
        title="展开地点详情"
        onClick={onOpen}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <aside className={`details-drawer ${open ? "is-open" : ""}`} aria-hidden={!open}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭地点详情" title="关闭">
          <X aria-hidden="true" />
        </button>

        <div className="drawer-scroll">
          <header className="place-heading">
            <h2>{cafe.name}</h2>
            <p><MapPin aria-hidden="true" />{cafe.district} · {cafe.address}</p>
          </header>

          <div className="match-summary">
            <strong className="match-number">{cafe.matchScore}</strong>
            <span>适配分</span>
            <div className="confidence">
              <span>置信度 {cafe.confidence}%</span>
              <span className="confidence-track"><i style={{ width: `${cafe.confidence}%` }} /></span>
            </div>
          </div>

          <section className="time-summary">
            <Clock3 aria-hidden="true" />
            <strong>{cafe.bestTime}</strong>
          </section>

          <section className="dimension-summary" aria-label="四项感官得分">
            {DIMENSIONS.map((dimension) => {
              const Icon = DIMENSION_ICONS[dimension];
              const value = cafe.displayScores[dimension];
              return (
                <div className="dimension-row" key={dimension}>
                  <Icon aria-hidden="true" />
                  <span>{DIMENSION_LABELS[dimension]}</span>
                  <span className="score-track"><i style={{ width: `${value}%` }} /></span>
                  <strong>{value}</strong>
                </div>
              );
            })}
          </section>

          <section className="field-note">
            <h3>来自现场</h3>
            <div>
              <MessageCircleMore aria-hidden="true" />
              <p>{cafe.evidence}</p>
            </div>
            <small><ShieldCheck aria-hidden="true" />{cafe.sourceStatus}</small>
          </section>
        </div>
      </aside>
    </>
  );
}

function GuideDialog({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="dialog-close" aria-label="关闭使用指南" onClick={onClose}><X aria-hidden="true" /></button>
        <h2 id="guide-title">用感官偏好缩小选择</h2>
        <p>选择当下想做的事，再调整四项感官偏好。榜单和地图会使用同一套规则即时重排。</p>
        <h3>四项感官偏好</h3>
        <div className="guide-dimensions" aria-label="四项感官偏好">
          {DIMENSIONS.map((dimension) => <span key={dimension}>{DIMENSION_LABELS[dimension]}</span>)}
        </div>
        <h3>三步使用流程</h3>
        <div className="guide-steps">
          <span><strong>1</strong>选场景与时段</span>
          <span><strong>2</strong>对比地点适配分</span>
          <span><strong>3</strong>查看证据与冲突</span>
        </div>
        <p className="guide-boundary">分数用于降低决策成本，不代表对环境的永久承诺。出发前仍应核对营业状态。</p>
      </section>
    </div>
  );
}

function MethodDialog({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="guide-dialog method-dialog" role="dialog" aria-modal="true" aria-labelledby="method-title" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="dialog-close" aria-label="关闭数据与方法" onClick={onClose}><X aria-hidden="true" /></button>
        <h2 id="method-title">数据与方法</h2>
        <p>QuietLens 用可解释的规则对比地点，不使用不可见的个人化推断。</p>
        <div className="method-list">
          <div><Calculator aria-hidden="true" /><span><strong>适配分</strong>四项感官得分按当前偏好加权后得到，同一组输入会得到同一结果。</span></div>
          <div><Clock3 aria-hidden="true" /><span><strong>时段修正</strong>时段只调整安静度与低拥挤估计，不会改写自然光和座位条件。</span></div>
          <div><Database aria-hidden="true" /><span><strong>证据状态</strong>门店位置、现场观察和营业信息分开记录；研究中的内容不作为已核实事实。</span></div>
          <div><ShieldCheck aria-hidden="true" /><span><strong>置信度</strong>表示当前证据的完整度与可核查程度，不等同于对门店品质的评分。</span></div>
        </div>
        <p className="guide-boundary">地图位置与营业状态会变化，出发前请使用门店官方渠道复核。</p>
      </section>
    </div>
  );
}

export function App() {
  const [scenario, setScenario] = useState("deepWork");
  const [preferences, setPreferences] = useState(SCENARIOS.deepWork.preferences);
  const [visitTime, setVisitTime] = useState("weekdayAfternoon");
  const [region, setRegion] = useState("shanghai");
  const [selectedId, setSelectedId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const [theme, setTheme] = useState("light");

  const scoredCafes = useMemo(
    () => CAFES.map((cafe) => scoreCafe(cafe, preferences, visitTime)).sort((a, b) => b.matchScore - a.matchScore),
    [preferences, visitTime],
  );
  const selectedCafe = scoredCafes.find((cafe) => cafe.id === selectedId) ?? null;

  function changeScenario(nextScenario) {
    setScenario(nextScenario);
    setPreferences({ ...SCENARIOS[nextScenario].preferences });
  }

  function changePreference(dimension, value) {
    setPreferences((current) => ({ ...current, [dimension]: value }));
  }

  function selectCafe(id) {
    setRegion("huangpu");
    setSelectedId(id);
    setDrawerOpen(true);
  }

  function clearSelection() {
    setSelectedId(null);
    setDrawerOpen(false);
  }

  function changeRegion(nextRegion) {
    setRegion(nextRegion);
    if (nextRegion !== "huangpu") clearSelection();
  }

  return (
    <div className="theme-root" data-theme={theme}>
      <div className="mobile-notice">
        <img src="/assets/brand/quietlens-mark.png" alt="" />
        <h1>QuietLens</h1>
        <p>当前阶段专注桌面体验，请在 1180px 以上的视口中打开。</p>
      </div>

      <main id="app" className="app-shell">
        <Header
          region={region}
          onRegion={changeRegion}
          visitTime={visitTime}
          onVisitTime={setVisitTime}
          theme={theme}
          onToggleTheme={() => setTheme((current) => current === "light" ? "dark" : "light")}
          onOpenGuide={() => setGuideOpen(true)}
          onOpenMethod={() => setMethodOpen(true)}
        />
        <div className="workspace">
          <aside className="sidebar">
            <ScenarioPicker scenario={scenario} onChange={changeScenario} />
            <PreferenceSliders preferences={preferences} onChange={changePreference} />
            <RankedList
              cafes={scoredCafes}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
              onSelect={selectCafe}
            />
          </aside>

          <section className="map-workspace">
            <MapStage
              cafes={scoredCafes}
              region={region}
              drawerOpen={drawerOpen}
              selectedCafe={selectedCafe}
              onSelect={selectCafe}
              onClearSelection={clearSelection}
              onRegionChange={changeRegion}
            />
            <DetailsDrawer
              cafe={selectedCafe}
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              onOpen={() => setDrawerOpen(true)}
            />
          </section>
        </div>
      </main>

      <GuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />
      <MethodDialog open={methodOpen} onClose={() => setMethodOpen(false)} />
    </div>
  );
}
