import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../src/ai-native/ui/QuietLensDecisionApp.jsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ai-native/client/decisionApi.js", import.meta.url), "utf8");
const service = await readFile(new URL("../worker/services/decisionService.js", import.meta.url), "utf8");
const mapStage = await readFile(new URL("../src/MapStage.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const aiStyles = await readFile(new URL("../src/ai-native/ui/ai-native.css", import.meta.url), "utf8");

test("the AI Native entry does not import the legacy fixed scoring path", () => {
  assert.doesNotMatch(ui, /scoreCafe|\.\.\/\.\.\/scoring|from ["'][^"']*data\.js/);
  assert.doesNotMatch(client, /scoreCafe|scoring\.js/);
});

test("the main decision flow requires both interpreter and reasoner model roles", () => {
  assert.match(service, /interpretIntent\(/);
  assert.match(service, /reasonAboutCandidates\(/);
  assert.match(service, /createDeepSeekResponsesClient\(/);
  assert.match(service, /MODEL_NOT_CONFIGURED/);
});

test("the header omits the duplicated global menu", () => {
  assert.doesNotMatch(ui, /打开全局菜单|ai-header-menu|header_menu_opened|header_menu_action_selected/);
  assert.match(ui, /日间模式/);
  assert.match(ui, /数据与方法/);
});

test("the task type editor uses the same paper menu as preference priority", () => {
  assert.match(ui, /const TASK_TYPE_OPTIONS = \[/);
  assert.match(ui, /<IntentPriorityMenu value=\{taskType\}[\s\S]*?ariaLabel="任务类型"/);
  assert.doesNotMatch(ui, /<select[^>]+aria-label="任务类型"/);
});

test("the time editor uses the custom QuietLens date and time panel", () => {
  assert.match(ui, /function IntentDateTimeMenu\(\{ value, onChange \}\)/);
  assert.match(ui, /row\.kind === "time"[\s\S]*?<IntentDateTimeMenu value=\{arrival\} onChange=\{setArrival\}/);
  assert.doesNotMatch(ui, /type="datetime-local"/);
  assert.match(ui, /className="ai-intent-datetime-panel"[\s\S]*?role="dialog"[\s\S]*?aria-label="选择到达时间"/);
  assert.match(aiStyles, /\.ai-intent-datetime-panel[\s\S]*?background: color-mix\(in srgb, var\(--paper\)/);
  assert.match(aiStyles, /\.ai-intent-calendar-days/);
  assert.match(aiStyles, /\.ai-intent-time-columns/);
});

test("the decision map follows the request and recommendation sequence", () => {
  assert.match(ui, /async function submitInitial[\s\S]*?setMapRegion\("shanghai"\)/);
  assert.match(ui, /async function runRecommendation[\s\S]*?brief\.status === "published"[\s\S]*?setMapRegion\("huangpu"\)/);
  assert.match(ui, /function openRequestPanel[\s\S]*?clearPlace\("request_panel"\)[\s\S]*?requestPanel\.scrollTop = 0[\s\S]*?setRequestPanelOpen\(true\)[\s\S]*?setMapRegion\("shanghai"\)/);
  assert.match(ui, /function closeRequestPanel[\s\S]*?setRequestPanelOpen\(false\)[\s\S]*?setMapRegion\("huangpu"\)/);
  assert.match(ui, /aria-label="关闭本次需求"/);
  assert.match(ui, /hasPublishedBrief && !requestPanelOpen && \(/);
  assert.match(mapStage, /return MAP_BOARDS\.map/);
  assert.match(mapStage, /opacity=\{boardLevel === level \? 1 : 0\}/);
  assert.doesNotMatch(mapStage, /RAIL_BOARD_CENTER|RAIL_MAP_BOUNDS/);
  assert.match(styles, /leaflet-image-layer[\s\S]*?transition: opacity 620ms/);
});
