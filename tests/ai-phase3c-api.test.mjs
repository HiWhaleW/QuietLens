import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createEmptyDecisionRequest,
  createKeepPatch,
} from "../src/ai-native/intent/requestPatch.js";
import { retrieveEvidence } from "../src/ai-native/evidence/retrieveEvidence.js";
import {
  buildReasonerContext,
  modelDecisionDraftSchema,
  reasonAboutCandidates,
} from "../worker/ai/decisionReasoner.js";
import { createDeepSeekResponsesClient } from "../worker/ai/deepseekResponsesClient.js";
import { recommendForDecisionRequest } from "../worker/services/decisionService.js";
import worker from "../worker/index.js";

const evidenceRoot = new URL("../docs/phase-3b/evidence/v0.1/", import.meta.url);
async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, evidenceRoot), "utf8"));
}
const store = {
  manifest: await readJson("manifest.json"),
  places: await readJson("places.json"),
  sources: await readJson("sources.json"),
  evidence: await readJson("evidence.json"),
};

function initialPatch(requestId) {
  const patch = createKeepPatch(requestId, "initial");
  patch.task_type = { action: "set", value: "focus", confidence: "high" };
  patch.duration_minutes = { action: "set", value: 90, confidence: "high" };
  patch.arrival_at = { action: "set", value: "2026-08-17T14:00:00+08:00", confidence: "high" };
  patch.time_original_phrase = { action: "set", value: "明天下午两点", confidence: "high" };
  patch.max_walk_minutes = { action: "set", value: 15, confidence: "high" };
  patch.soft_preferences = { action: "replace", value: [{ field: "daylight", priority: "high" }], confidence: "high" };
  return patch;
}

function modelPatch(requestId = "req-model-owned") {
  const patch = initialPatch(requestId);
  return {
    scalar_updates: [
      { field: "task_type", ...patch.task_type },
      { field: "duration_minutes", ...patch.duration_minutes },
      { field: "arrival_at", ...patch.arrival_at },
      { field: "time_original_phrase", ...patch.time_original_phrase },
      { field: "max_walk_minutes", ...patch.max_walk_minutes },
    ],
    hard_constraints: patch.hard_constraints,
    soft_preferences: patch.soft_preferences,
    unknowns: patch.unknowns,
    assumptions: patch.assumptions,
  };
}

const draft = {
  flow_schema_version: "0.1.0",
  request_id: "req-api-flow",
  outcome: "publish",
  refusal_reason_code: null,
  candidates: [
    {
      place_id: "hp-cafe-on-air",
      role: "primary",
      fit_evidence_groups: [{ attribute: "daylight", evidence_ids: ["ev-cafe-air-daylight"] }],
      tradeoff_evidence_groups: [{ attribute: "crowding", evidence_ids: ["ev-cafe-air-crowding"] }],
      unknown_attributes: ["realtime_seats", "realtime_noise"],
      assumption_refs: [],
    },
    {
      place_id: "hp-blue-house",
      role: "alternative",
      fit_evidence_groups: [{ attribute: "daylight", evidence_ids: ["ev-blue-daylight"] }],
      tradeoff_evidence_groups: [{ attribute: "crowding", evidence_ids: ["ev-blue-crowding"] }],
      unknown_attributes: ["realtime_seats", "realtime_noise"],
      assumption_refs: [],
    },
  ],
};

function environment() {
  const events = [];
  return {
    events,
    env: {
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
      QUIETLENS_EVIDENCE_STORE: store,
      QUIETLENS_ANALYTICS_SINK: { write: async (event) => events.push(event) },
      QUIETLENS_NOW: () => "2026-08-16T10:00:00+08:00",
      QUIETLENS_MODEL_CLIENT: {
        async callStructured({ schemaName }) {
          if (schemaName === "quietlens_decision_request_patch") return { value: modelPatch("req-api-flow"), usage: null, response_id: "mock-intent" };
          if (schemaName === "quietlens_decision_draft") return { value: draft, usage: null, response_id: "mock-reasoner" };
          throw new Error(`Unexpected schema ${schemaName}`);
        },
      },
    },
  };
}

async function post(path, body, env) {
  return worker.fetch(new Request(`https://quietlens.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quietlens.test" },
    body: JSON.stringify(body),
  }), env);
}

test("uses the stateless DeepSeek Responses API with strict structured output", async () => {
  let captured;
  const client = createDeepSeekResponsesClient({ DEEPSEEK_API_KEY: "test-key" }, async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: "resp-deepseek-test",
      status: "completed",
      store: false,
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ ok: true }) }],
      }],
      usage: { input_tokens: 10, output_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await client.callStructured({
    model: "deepseek-v4-flash",
    instructions: "Return the schema only.",
    input: "test",
    schemaName: "quietlens_test",
    schema: {
      $id: "ignored-by-provider",
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    reasoningEffort: "none",
  });

  assert.equal(captured.url, "https://api.deepseek.com/responses");
  assert.equal(captured.init.headers.authorization, "Bearer test-key");
  assert.equal(captured.body.model, "deepseek-v4-flash");
  assert.equal(captured.body.store, false);
  assert.deepEqual(captured.body.reasoning, { effort: "none" });
  assert.equal(captured.body.text.format.type, "json_schema");
  assert.equal(captured.body.text.format.strict, true);
  assert.equal("$id" in captured.body.text.format.schema, false);
  assert.equal(captured.body.text.format.schema.properties.ok.type, "boolean");
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.response_id, "resp-deepseek-test");
});

test("rejects a non-header-safe DeepSeek credential before fetch", async () => {
  let fetchCalled = false;
  const client = createDeepSeekResponsesClient({ DEEPSEEK_API_KEY: "not-a-key-中文" }, async () => {
    fetchCalled = true;
  });

  await assert.rejects(
    client.callStructured({}),
    (error) => error.code === "MODEL_CREDENTIAL_INVALID",
  );
  assert.equal(fetchCalled, false);
});

test("runs the bounded intent and decision API without exposing model text", async () => {
  const runtime = environment();
  const interpretedResponse = await post("/api/decision/interpret", {
    session_id: "sess-api-flow",
    request_id: "req-api-flow",
    user_text: "明天下午两点在黄浦找个自然光好的地方工作90分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  assert.equal(interpretedResponse.status, 200);
  const interpreted = (await interpretedResponse.json()).data;
  assert.equal(interpreted.request.task.type, "focus");
  assert.equal(interpreted.clarification.required, false);

  const recommendedResponse = await post("/api/decision/recommend", {
    session_id: "sess-api-flow",
    request: interpreted.request,
  }, runtime.env);
  assert.equal(recommendedResponse.status, 200);
  const recommended = (await recommendedResponse.json()).data;
  assert.equal(recommended.brief.status, "published");
  assert.deepEqual(recommended.brief.candidates.map((candidate) => candidate.place_id), ["hp-cafe-on-air", "hp-blue-house"]);
  assert.equal(recommended.context.places.length, 10);
  assert.ok(runtime.events.some((event) => event.event_name === "intent_parse_succeeded"));
  assert.ok(runtime.events.some((event) => event.event_name === "evidence_verification_succeeded"));
  const published = runtime.events.find((event) => event.event_name === "decision_published");
  assert.equal(published.properties.candidate_count, 2);
  assert.equal(published.properties.unknown_count, 2);
  assert.ok(published.properties.total_duration_ms >= 1);
});

test("keeps request identity and mode server-owned outside the model schema", async () => {
  const runtime = environment();
  let capturedSchema;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured({ schema, schemaName }) {
      assert.equal(schemaName, "quietlens_decision_request_patch");
      capturedSchema = schema;
      return {
        value: { ...modelPatch(), request_id: "req-model-owned", mode: "correction" },
        usage: { input_tokens: 12, output_tokens: 8 },
        response_id: "mock-server-owned",
      };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-server-owned",
    request_id: "req-server-owned",
    user_text: "明天下午两点工作90分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal("request_id" in capturedSchema.properties, false);
  assert.equal("mode" in capturedSchema.properties, false);
  assert.equal("flow_schema_version" in capturedSchema.properties, false);
  assert.equal(capturedSchema.required.includes("request_id"), false);
  assert.equal(capturedSchema.required.includes("mode"), false);
  assert.equal(capturedSchema.required.includes("flow_schema_version"), false);
  assert.equal(interpreted.patch.request_id, "req-server-owned");
  assert.equal(interpreted.patch.mode, "initial");
  assert.equal(interpreted.request.request_id, "req-server-owned");
});

test("retries one repairable intent output and counts both model calls", async () => {
  const runtime = environment();
  const inputs = [];
  let calls = 0;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured({ input, schemaName }) {
      assert.equal(schemaName, "quietlens_decision_request_patch");
      inputs.push(JSON.parse(input));
      calls += 1;
      if (calls === 1) {
        const invalid = modelPatch();
        invalid.scalar_updates.push({
          field: "hard_leave_at",
          action: "append",
          value: "2026-08-17T17:00:00+08:00",
          confidence: "high",
        });
        return {
          value: invalid,
          usage: { input_tokens: 10, output_tokens: 6 },
          response_id: "mock-invalid-intent",
        };
      }
      return {
        value: modelPatch(),
        usage: { input_tokens: 14, output_tokens: 7 },
        response_id: "mock-repaired-intent",
      };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-repair-intent",
    request_id: "req-repair-intent",
    user_text: "明天下午两点工作90分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal("repair_request" in inputs[0], false);
  assert.equal(inputs[1].repair_request.code, "MODEL_PATCH_INVALID");
  assert.ok(inputs[1].repair_request.validation_issues.some((issue) => issue.instance_path === "/hard_leave_at/action"));
  assert.equal(interpreted.metrics.model_calls, 2);
  assert.equal(interpreted.metrics.usage.length, 2);
  assert.deepEqual(interpreted.metrics.repair_issues, [{
    code: "MODEL_PATCH_INVALID",
    validation_issues: [{
      instance_path: "/hard_leave_at/action",
      keyword: "enum",
      message: "must be equal to one of the allowed values",
    }],
  }]);
});

test("repairs a null non-nullable scalar before merging the request", async () => {
  const runtime = environment();
  let calls = 0;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      calls += 1;
      const value = modelPatch();
      if (calls === 1) {
        value.scalar_updates = [{
          field: "location_area",
          action: "set",
          value: null,
          confidence: "low",
        }];
      }
      return { value, usage: null, response_id: `mock-non-nullable-${calls}` };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-non-nullable-repair",
    request_id: "req-non-nullable-repair",
    user_text: "想在黄浦找家店工作。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(interpreted.request.location.area, "黄浦区");
  assert.deepEqual(interpreted.metrics.repair_codes, ["MODEL_PATCH_INVALID"]);
  assert.equal(interpreted.metrics.repair_issues[0].validation_issues[0].instance_path, "/scalar_updates/0/value");
});

test("retries one transient intent network error without deterministic completion", async () => {
  const runtime = environment();
  let calls = 0;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("network");
        error.code = "MODEL_NETWORK_ERROR";
        throw error;
      }
      return { value: modelPatch(), usage: null, response_id: "mock-intent-network-retry" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-intent-network-retry",
    request_id: "req-intent-network-retry",
    user_text: "明天下午两点工作90分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(interpreted.metrics.model_calls, 2);
  assert.deepEqual(interpreted.metrics.repair_codes, ["MODEL_NETWORK_ERROR"]);
});

test("enforces explicit out-of-scope areas before clarification", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      return { value, usage: null, response_id: "mock-out-of-scope" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-out-of-scope",
    request_id: "req-out-of-scope",
    user_text: "帮我推荐静安寺附近适合工作的咖啡店。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.location.area, "静安寺");
  assert.equal(interpreted.clarification.required, false);
});

test("normalizes explicit quiet-work evidence into the noise hard constraint", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = {
        action: "replace",
        value: [
          { field: "operating_status", operator: "available", value: "true" },
          { field: "call_environment", operator: "supports", value: "quiet" },
        ],
        confidence: "high",
      };
      return { value, usage: null, response_id: "mock-quiet-normalization" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-quiet-normalization",
    request_id: "req-quiet-normalization",
    user_text: "必须确认门店当前营业，并且有安静工作观察。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [
      { field: "operating_status", operator: "available", value: true },
      { field: "noise", operator: "equals", value: "quiet_working" },
    ],
  );
});

test("rebuilds all explicit critical constraints when the model omits a charging requirement", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = {
        action: "replace",
        value: [{ field: "outdoor_seating", operator: "available", value: "true" }],
        confidence: "high",
      };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      return { value, usage: null, response_id: "mock-missing-charging-constraint" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-missing-charging-constraint",
    request_id: "req-missing-charging-constraint",
    user_text: "会面要在室外，但电脑也必须能充电。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [
      { field: "outlets", operator: "available", value: true },
      { field: "outdoor_seating", operator: "available", value: true },
    ],
  );
});

test("treats a request for verified quiet-work evidence as a hard constraint", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = {
        action: "replace",
        value: [{ field: "noise", priority: "high" }],
        confidence: "high",
      };
      return { value, usage: null, response_id: "mock-verified-quiet-constraint" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-verified-quiet-constraint",
    request_id: "req-verified-quiet-constraint",
    user_text: "黄浦下午整理数据，需要已核实的安静办公状态。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [{ field: "noise", operator: "equals", value: "quiet_working" }],
  );
  assert.deepEqual(interpreted.request.soft_preferences, []);
});

test("maps a low-volume-discussion evidence requirement to the quiet noise constraint", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = {
        action: "replace",
        value: [{ field: "workspace", operator: "supports", value: "low_volume_conversation" }],
        confidence: "high",
      };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      return { value, usage: null, response_id: "mock-low-volume-noise-constraint" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-low-volume-noise-constraint",
    request_id: "req-low-volume-noise-constraint",
    user_text: "明天两点在黄浦写方案，只考虑有低声讨论证据的店。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [{ field: "noise", operator: "equals", value: "quiet_working" }],
  );
});

test("keeps realtime seat guarantees out of static seating and crowding constraints", async () => {
  for (const [userText, wrongField] of [
    ["我要一个能保证现在不排队的地方。", "crowding"],
    ["必须确认此刻靠窗座位空着。", "seating"],
  ]) {
    const runtime = environment();
    runtime.env.QUIETLENS_MODEL_CLIENT = {
      async callStructured() {
        const value = modelPatch();
        value.scalar_updates = [];
        value.hard_constraints = {
          action: "replace",
          value: [{
            field: wrongField,
            operator: wrongField === "crowding" ? "at_most" : "available",
            value: wrongField === "crowding" ? "2" : "true",
          }],
          confidence: "high",
        };
        value.soft_preferences = { action: "keep", value: [], confidence: "low" };
        return { value, usage: null, response_id: `mock-realtime-${wrongField}` };
      },
    };

    const response = await post("/api/decision/interpret", {
      session_id: `sess-realtime-${wrongField}`,
      request_id: `req-realtime-${wrongField}`,
      user_text: userText,
      mode: "initial",
      page_context: { area: "黄浦区" },
    }, runtime.env);
    const interpreted = (await response.json()).data;

    assert.equal(response.status, 200);
    assert.deepEqual(
      interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
      [{ field: "realtime_seats", operator: "available", value: true }],
    );
  }
});

test("does not turn an explicit realtime-seat non-requirement into a hard constraint", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = {
        action: "replace",
        value: [{ field: "realtime_seats", operator: "available", value: "true" }],
        confidence: "high",
      };
      value.soft_preferences = {
        action: "replace",
        value: [{ field: "size", priority: "high" }],
        confidence: "high",
      };
      value.assumptions = ["不要求实时有座 interpreted as realtime_seats availability is required."];
      return { value, usage: null, response_id: "mock-realtime-seat-non-requirement" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-realtime-seat-non-requirement",
    request_id: "req-realtime-seat-non-requirement",
    user_text: "想去一间体量小的咖啡店短暂停留，不要求实时有座。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(interpreted.request.hard_constraints, []);
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "size", priority: "high" }]);
  assert.deepEqual(interpreted.request.assumptions, []);
});

test("demotes importance language to a soft preference without a hard requirement signal", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.hard_constraints = {
        action: "replace",
        value: [{ field: "daylight", operator: "supports", value: "true" }],
        confidence: "high",
      };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      return { value, usage: null, response_id: "mock-soft-importance" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-soft-importance",
    request_id: "req-soft-importance",
    user_text: "明天下午在黄浦工作90分钟，自然光重要。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(interpreted.request.hard_constraints, []);
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "daylight", priority: "high" }]);
});

test("normalizes accepted crowding separately from the requested outdoor preference", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      value.unknowns = [];
      value.assumptions = [];
      return { value, usage: null, response_id: "mock-accepted-crowding" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-accepted-crowding",
    request_id: "req-accepted-crowding",
    user_text: "银杏季想坐室外聊半小时，可以接受人多。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "outdoor_seating", priority: "high" }]);
  assert.equal(interpreted.request.task.type, "conversation");
});

test("adds a medium call-environment preference without clarifying uncertain timing", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      value.unknowns = ["duration", "arrival_time"];
      value.assumptions = [];
      return { value, usage: null, response_id: "mock-uncertain-call" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-uncertain-call",
    request_id: "req-uncertain-call",
    user_text: "我可能要接一个电话，但时间还不确定。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.task.type, "call");
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "call_environment", priority: "medium" }]);
  assert.equal(interpreted.clarification.required, false);
});

test("treats a casual historical-interior request as a medium preference", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      value.unknowns = [];
      value.assumptions = [];
      return { value, usage: null, response_id: "mock-casual-interior" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-casual-interior",
    request_id: "req-casual-interior",
    user_text: "想找个历史感空间坐一会儿。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "interior", priority: "medium" }]);
});

test("preserves an explicit conflicting duration instead of shortening it to fit the deadline", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [
        { field: "duration_minutes", action: "set", value: 60, confidence: "high" },
        { field: "arrival_at", action: "set", value: "2026-08-16T10:00:00+08:00", confidence: "high" },
        { field: "hard_leave_at", action: "set", value: "2026-08-16T11:00:00+08:00", confidence: "high" },
      ];
      return { value, usage: null, response_id: "mock-time-conflict" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-time-normalization",
    request_id: "req-time-normalization",
    user_text: "十点到店想待两小时，不过十一点有硬截止。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.task.duration_minutes, 120);
  assert.equal(interpreted.request.time.arrival_at, "2026-08-16T10:00:00+08:00");
  assert.equal(interpreted.request.time.hard_leave_at, "2026-08-16T11:00:00+08:00");
  assert.equal(interpreted.versions.intent_normalizer, "explicit-time-conflict-normalizer-v0.1.2");
});

test("moves an explicit walk limit out of hard constraints and into location state", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.hard_constraints = {
        action: "replace",
        value: [{ field: "walk_time", operator: "at_most", value: "10" }],
        confidence: "high",
      };
      return { value, usage: null, response_id: "mock-walk-limit" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-walk-limit",
    request_id: "req-walk-limit",
    user_text: "外滩附近工作，步行十分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.location.max_walk_minutes, 10);
  assert.deepEqual(interpreted.request.hard_constraints, []);
});

test("normalizes explicit correction targets while preserving unrelated preferences", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = {
        action: "replace",
        value: [{ field: "outlets", priority: "high" }],
        confidence: "high",
      };
      return { value, usage: null, response_id: "mock-correction-normalization" };
    },
  };
  const current = createEmptyDecisionRequest("req-correction-normalization");
  current.task = { type: "focus", duration_minutes: 90 };
  current.soft_preferences = [{ field: "noise", priority: "high" }];
  current.unknowns = [];

  const response = await post("/api/decision/interpret", {
    session_id: "sess-correction-normalization",
    request_id: current.request_id,
    user_text: "插座现在比安静更重要，而且必须确认。",
    mode: "correction",
    current_request: current,
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [{ field: "outlets", operator: "available", value: true }],
  );
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "noise", priority: "high" }]);
});

test("applies an absolute walk-limit correction without changing other fields", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      return { value, usage: null, response_id: "mock-walk-correction" };
    },
  };
  const current = createEmptyDecisionRequest("req-walk-correction");
  current.task = { type: "conversation", duration_minutes: 60 };
  current.location.max_walk_minutes = 15;
  current.unknowns = [];

  const response = await post("/api/decision/interpret", {
    session_id: "sess-walk-correction",
    request_id: current.request_id,
    user_text: "把最多步行改为二十分钟，时间和任务不变。",
    mode: "correction",
    current_request: current,
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.location.max_walk_minutes, 20);
  assert.deepEqual(interpreted.request.task, current.task);
  assert.deepEqual(interpreted.request.time, current.time);
});

test("prioritizes explicit uncertainty over generic missing fields", async () => {
  const scenarios = [
    ["三点半可能要在店里开会。", "call_environment", "call_environment_uncertain"],
    ["安静到底多重要我没想好。", "noise", "noise_importance"],
    ["普通凳子能不能接受还不确定。", "seating", "seating_acceptance"],
    ["带电脑工作，可能需要充电。", "outlets", "charging_need"],
  ];

  for (const [userText, target, modelUnknown] of scenarios) {
    const runtime = environment();
    runtime.env.QUIETLENS_MODEL_CLIENT = {
      async callStructured() {
        const value = modelPatch();
        value.scalar_updates = target === "call_environment"
          ? [{ field: "hard_leave_at", action: "set", value: "2026-08-16T15:30:00+08:00", confidence: "medium" }]
          : [];
        value.hard_constraints = { action: "keep", value: [], confidence: "low" };
        value.soft_preferences = {
          action: "replace",
          value: [{ field: target, priority: "medium" }],
          confidence: "medium",
        };
        value.unknowns = ["walk_time", modelUnknown];
        value.assumptions = ["模型不应代替用户解决这个不确定项"];
        return { value, usage: null, response_id: `mock-uncertainty-${target}` };
      },
    };

    const response = await post("/api/decision/interpret", {
      session_id: `sess-uncertainty-${target.replaceAll("_", "-")}`,
      request_id: `req-uncertainty-${target.replaceAll("_", "-")}`,
      user_text: userText,
      mode: "initial",
      page_context: { area: "黄浦区" },
    }, runtime.env);
    const responseBody = await response.json();
    const interpreted = responseBody.data;

    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.equal(interpreted.clarification.target_field, target);
    assert.ok(interpreted.request.unknowns.includes(target));
    assert.ok(!interpreted.request.soft_preferences.some((item) => item.field === target));
    assert.deepEqual(interpreted.request.assumptions, []);
    if (target === "call_environment") assert.equal(interpreted.request.time.hard_leave_at, null);
  }
});

test("asks the necessary call-location question when a later meeting is ambiguous", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [
        { field: "task_type", action: "set", value: "focus", confidence: "high" },
        { field: "duration_minutes", action: "set", value: 90, confidence: "high" },
        { field: "arrival_at", action: "set", value: "2026-08-16T14:00:00+08:00", confidence: "high" },
        { field: "hard_leave_at", action: "set", value: "2026-08-16T15:30:00+08:00", confidence: "medium" },
      ];
      value.assumptions = ["User will probably leave before the meeting."];
      return { value, usage: null, response_id: "mock-ambiguous-later-call" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-ambiguous-later-call",
    request_id: "req-ambiguous-later-call",
    user_text: "明天下午两点在外滩附近专注工作 90 分钟，15:30 有一个线上会议。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.task.type, "focus");
  assert.equal(interpreted.clarification.required, true);
  assert.equal(interpreted.clarification.target_field, "call_environment");
  assert.equal(interpreted.request.time.hard_leave_at, null);
  assert.deepEqual(interpreted.request.assumptions, []);
});

test("preserves an explicit in-scope neighborhood when the model misses it", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [{
        field: "location_area",
        action: "set",
        value: "黄浦区",
        confidence: "medium",
      }];
      return { value, usage: null, response_id: "mock-explicit-location" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-explicit-location",
    request_id: "req-explicit-location",
    user_text: "明天下午想在外滩附近专注工作。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.location.area, "外滩");
  assert.equal(interpreted.versions.intent_normalizer, "explicit-semantic-normalizer-v0.1.4");
});

test("does not ask about a generic missing field without a high-impact ambiguity", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.unknowns = ["walk_time"];
      return { value, usage: null, response_id: "mock-generic-unknown" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-generic-unknown",
    request_id: "req-generic-unknown",
    user_text: "明天上午想在人民广场附近低刺激休息，历史感很重要。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.clarification.required, false);
  assert.deepEqual(interpreted.request.unknowns, ["walk_time"]);
});

test("clarifies a walk range that the user says will change the choice", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [{
        field: "location_area",
        action: "set",
        value: "外滩",
        confidence: "high",
      }];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      value.unknowns = ["max_walk_minutes"];
      value.assumptions = [];
      return { value, usage: null, response_id: "mock-walk-range-clarification" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-walk-range-clarification",
    request_id: "req-walk-range-clarification",
    user_text: "我在外滩，能走十分钟还是二十分钟会改变选择。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.clarification.required, true);
  assert.equal(interpreted.clarification.target_field, "walk_time");
});

test("keeps the original planned duration when an earlier hard departure conflicts", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [
        { field: "duration_minutes", action: "set", value: 60, confidence: "high" },
        { field: "arrival_at", action: "set", value: "2026-08-16T15:00:00+08:00", confidence: "high" },
        { field: "hard_leave_at", action: "set", value: "2026-08-16T16:00:00+08:00", confidence: "high" },
      ];
      return { value, usage: null, response_id: "mock-planned-window-conflict" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-planned-window-conflict",
    request_id: "req-planned-window-conflict",
    user_text: "计划15:00 工作到17:00，但16:00 必须到别处。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.task.duration_minutes, 120);
  assert.equal(interpreted.request.time.arrival_at, "2026-08-16T15:00:00+08:00");
  assert.equal(interpreted.request.time.hard_leave_at, "2026-08-16T16:00:00+08:00");
  assert.equal(interpreted.versions.intent_normalizer, "explicit-time-conflict-normalizer-v0.1.2");
});

test("detects a spaced hard-departure marker after an explicit start time", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [
        { field: "duration_minutes", action: "set", value: 90, confidence: "high" },
        { field: "arrival_at", action: "set", value: "2026-08-16T13:30", confidence: "high" },
        { field: "hard_leave_at", action: "set", value: "2026-08-16T14:00", confidence: "high" },
      ];
      return { value, usage: null, response_id: "mock-spaced-hard-departure" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-spaced-hard-departure",
    request_id: "req-spaced-hard-departure",
    user_text: "13:30 开始专注90分钟，14:00 就必须离店。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(interpreted.request.task.duration_minutes, 90);
  assert.equal(interpreted.request.time.arrival_at, "2026-08-16T13:30:00+08:00");
  assert.equal(interpreted.request.time.hard_leave_at, "2026-08-16T14:00:00+08:00");
  assert.equal(interpreted.versions.intent_normalizer, "explicit-time-conflict-normalizer-v0.1.2");
});

test("keeps a medium noise preference for a short recovery request", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const value = modelPatch();
      value.scalar_updates = [];
      value.hard_constraints = { action: "keep", value: [], confidence: "low" };
      value.soft_preferences = { action: "keep", value: [], confidence: "low" };
      value.unknowns = [];
      value.assumptions = [];
      return { value, usage: null, response_id: "mock-short-recovery-preference" };
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-short-recovery-preference",
    request_id: "req-short-recovery-preference",
    user_text: "我想在黄浦短暂恢复。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(interpreted.request.soft_preferences, [{ field: "noise", priority: "medium" }]);
});

test("falls back to versioned explicit critical constraints after model timeout", async () => {
  const runtime = environment();
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      const error = new Error("Model request timed out");
      error.code = "MODEL_TIMEOUT";
      throw error;
    },
  };

  const response = await post("/api/decision/interpret", {
    session_id: "sess-critical-fallback",
    request_id: "req-critical-fallback",
    user_text: "只推荐当前实时有空位的店。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.deepEqual(
    interpreted.request.hard_constraints.map(({ field, operator, value }) => ({ field, operator, value })),
    [{ field: "realtime_seats", operator: "available", value: true }],
  );
  assert.equal(interpreted.metrics.model_calls, 1);
  assert.ok(interpreted.metrics.repair_codes.includes("MODEL_TIMEOUT"));
  assert.ok(interpreted.metrics.repair_codes.includes("DETERMINISTIC_CRITICAL_FALLBACK"));
  assert.equal(interpreted.versions.intent_fallback, "critical-constraint-fallback-v0.1.0");
});

test("returns a formal model-not-configured state instead of a deterministic recommendation", async () => {
  const runtime = environment();
  delete runtime.env.QUIETLENS_MODEL_CLIENT;
  const response = await post("/api/decision/interpret", {
    session_id: "sess-no-model",
    request_id: "req-no-model",
    user_text: "想找个安静地方工作。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "MODEL_NOT_CONFIGURED" } });
});

test("emits a reasoning failure when the configured model becomes unavailable", async () => {
  const runtime = environment();
  const interpretedResponse = await post("/api/decision/interpret", {
    session_id: "sess-reasoning-failure",
    request_id: "req-api-flow",
    user_text: "明天下午两点在黄浦专注工作 90 分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await interpretedResponse.json()).data;
  delete runtime.env.QUIETLENS_MODEL_CLIENT;

  const response = await post("/api/decision/recommend", {
    session_id: "sess-reasoning-failure",
    request: interpreted.request,
  }, runtime.env);

  assert.equal(response.status, 503);
  assert.ok(runtime.events.some((event) => (
    event.event_name === "decision_reasoning_failed"
      && event.error_code === "MODEL_NOT_CONFIGURED"
      && event.properties.duration_ms >= 1
  )));
});

test("emits a retrieval failure before any reasoning call when the evidence store is invalid", async () => {
  const runtime = environment();
  const interpretedResponse = await post("/api/decision/interpret", {
    session_id: "sess-retrieval-failure",
    request_id: "req-api-flow",
    user_text: "明天下午两点在黄浦专注工作 90 分钟。",
    mode: "initial",
    page_context: { area: "黄浦区" },
  }, runtime.env);
  const interpreted = (await interpretedResponse.json()).data;
  runtime.env.QUIETLENS_EVIDENCE_STORE = {};

  const response = await post("/api/decision/recommend", {
    session_id: "sess-retrieval-failure",
    request: interpreted.request,
  }, runtime.env);

  assert.equal(response.status, 500);
  assert.ok(runtime.events.some((event) => (
    event.event_name === "retrieval_failed"
      && event.error_code === "RETRIEVAL_FAILED"
      && event.properties.duration_ms >= 1
  )));
  assert.ok(!runtime.events.some((event) => event.event_name === "decision_reasoning_started"));
});

test("refuses deterministically when no candidate has confirmed all hard constraints", async () => {
  const runtime = environment();
  let modelCalled = false;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      modelCalled = true;
      throw new Error("Reasoner must not run without an eligible candidate");
    },
  };
  const request = createEmptyDecisionRequest("req-no-eligible");
  request.hard_constraints = [
    { constraint_id: "hc-no-eligible-outlets", field: "outlets", operator: "available", value: true },
    { constraint_id: "hc-no-eligible-outdoor", field: "outdoor_seating", operator: "available", value: true },
  ];
  request.unknowns = [];

  const response = await post("/api/decision/recommend", {
    session_id: "sess-no-eligible",
    request,
  }, runtime.env);
  const result = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(result.brief.status, "refused");
  assert.equal(result.brief.refusal.reason_code, "hard_constraints_no_result");
  assert.deepEqual(result.brief.refusal.relaxable_fields, ["outlets", "outdoor_seating"]);
  assert.equal(modelCalled, false);
  assert.ok(!runtime.events.some((event) => event.event_name === "decision_reasoning_started"));
});

test("uses the reasoner to compare one grounded match with explicitly uncertain alternatives", async () => {
  const runtime = environment();
  let modelCalled = false;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured({ input }) {
      modelCalled = true;
      const context = JSON.parse(input);
      const eligible = context.candidates.find((candidate) => candidate.eligibility === "eligible");
      const uncertain = context.candidates.find((candidate) => candidate.eligibility === "uncertain" && candidate.evidence.length > 0);
      return {
        value: {
          outcome: "publish",
          refusal_reason_code: null,
          candidates: [eligible, uncertain].map((candidate, index) => ({
            place_id: candidate.place_id,
            role: index === 0 ? "primary" : "conditional",
            fit_evidence_groups: [{
              attribute: candidate.evidence[0].attribute,
              evidence_ids: [candidate.evidence[0].evidence_id],
            }],
            tradeoff_evidence_groups: [],
          })),
        },
        usage: null,
        response_id: "mock-bounded-comparison",
      };
    },
  };
  const request = createEmptyDecisionRequest("req-single-eligible");
  request.hard_constraints = [
    { constraint_id: "hc-single-eligible-outlets", field: "outlets", operator: "available", value: true },
  ];
  request.unknowns = [];

  const response = await post("/api/decision/recommend", {
    session_id: "sess-single-eligible",
    request,
  }, runtime.env);
  const result = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(result.brief.status, "published");
  assert.equal(result.brief.candidates.length, 2);
  assert.equal(result.brief.candidates[0].place_id, "hp-cafe-on-air");
  assert.ok(result.brief.candidates[1].hard_constraint_results.some((item) => item.status === "unknown"));
  assert.ok(result.brief.candidates[0].fit_reasons[0].evidence_ids.length > 0);
  assert.equal(modelCalled, true);
  assert.equal(result.metrics.model_calls, 1);
  assert.ok(runtime.events.some((event) => event.event_name === "evidence_verification_succeeded"));
  assert.ok(runtime.events.some((event) => event.event_name === "decision_published"));
});

test("keeps hard-constraint evidence in the bounded reasoner context", () => {
  const request = createEmptyDecisionRequest("req-reasoner-context");
  request.task.type = "focus";
  request.hard_constraints = [{
    constraint_id: "hc-outdoor-context",
    field: "outdoor_seating",
    operator: "available",
    value: true,
  }];
  request.unknowns = [];

  const retrieval = retrieveEvidence(request, store);
  const context = buildReasonerContext(request, retrieval);

  assert.deepEqual(context.candidates.map((candidate) => candidate.place_id).sort(), [
    "hp-antique",
    "hp-blue-house",
    "hp-east-sea",
    "hp-metal-hands",
  ]);
  for (const candidate of context.candidates.filter((item) => item.eligibility === "eligible")) {
    assert.ok(candidate.evidence.length <= 4);
    assert.ok(candidate.evidence.some((record) => record.attribute === "outdoor_seating"));
    for (const record of candidate.evidence) {
      const sourceRecord = store.evidence.find((item) => item.evidence_id === record.evidence_id);
      assert.notEqual(sourceRecord.publishability, "not_factual");
      assert.notEqual(sourceRecord.epistemic_status, "model_inference");
    }
  }
  assert.ok(context.candidates.some((candidate) => candidate.eligibility === "uncertain"));
});

test("keeps unknown disclosure and assumptions outside the reasoner output contract", () => {
  const candidateSchema = modelDecisionDraftSchema.properties.candidates.items;
  assert.equal("unknown_attributes" in candidateSchema.properties, false);
  assert.equal("assumption_refs" in candidateSchema.properties, false);
  assert.equal(candidateSchema.required.includes("unknown_attributes"), false);
  assert.equal(candidateSchema.required.includes("assumption_refs"), false);
});

test("fills a missing fit group only from the selected candidate's controlled context", async () => {
  const request = createEmptyDecisionRequest("req-reasoner-fit-normalization");
  request.task.type = "focus";
  request.soft_preferences = [{ field: "daylight", priority: "high" }];
  request.unknowns = [];
  const retrieval = retrieveEvidence(request, store);
  const result = await reasonAboutCandidates({
    model: "mock-reasoner",
    request,
    retrieval,
    modelClient: {
      async callStructured() {
        return {
          value: {
            outcome: "publish",
            refusal_reason_code: null,
            candidates: [{
              place_id: "hp-cafe-on-air",
              role: "primary",
              fit_evidence_groups: [{
                attribute: "noise",
                evidence_ids: ["ev-cafe-air-daylight"],
              }],
              tradeoff_evidence_groups: [],
            }, {
              place_id: "hp-blue-house",
              role: "alternative",
              fit_evidence_groups: [{ attribute: "daylight", evidence_ids: ["ev-blue-daylight"] }],
              tradeoff_evidence_groups: [],
            }],
          },
          usage: null,
          response_id: "mock-reasoner-fit-normalization",
        };
      },
    },
  });

  assert.equal(result.draft.candidates[0].fit_evidence_groups.length, 1);
  assert.equal(result.draft.candidates[0].fit_evidence_groups[0].attribute, "daylight");
  assert.ok(result.draft.candidates[0].fit_evidence_groups[0].evidence_ids[0].startsWith("ev-cafe-air-"));
});

test("drops out-of-scope draft candidates and fills the bounded comparison", async () => {
  const request = createEmptyDecisionRequest("req-reasoner-candidate-normalization");
  request.task.type = "focus";
  request.soft_preferences = [{ field: "daylight", priority: "high" }];
  request.unknowns = [];
  const retrieval = retrieveEvidence(request, store);
  const result = await reasonAboutCandidates({
    model: "mock-reasoner",
    request,
    retrieval,
    modelClient: {
      async callStructured() {
        return {
          value: {
            outcome: "publish",
            refusal_reason_code: null,
            candidates: [{
              place_id: "hp-invented",
              role: "primary",
              fit_evidence_groups: [],
              tradeoff_evidence_groups: [],
            }],
          },
          usage: null,
          response_id: "mock-reasoner-candidate-normalization",
        };
      },
    },
  });

  assert.equal(result.draft.candidates.length, 2);
  assert.deepEqual(result.draft.candidates.map((candidate) => candidate.role), ["primary", "conditional"]);
  assert.ok(result.draft.candidates.every((candidate) => candidate.place_id !== "hp-invented"));
  assert.ok(result.draft.candidates.every((candidate) => candidate.fit_evidence_groups.length > 0));
});

test("keeps one direct high-priority preference candidate in the bounded comparison", async () => {
  const request = createEmptyDecisionRequest("req-reasoner-preference-coverage");
  request.task.type = "recovery";
  request.soft_preferences = [{ field: "size", priority: "high" }];
  request.unknowns = [];
  const retrieval = retrieveEvidence(request, store);
  const result = await reasonAboutCandidates({
    model: "mock-reasoner",
    request,
    retrieval,
    modelClient: {
      async callStructured() {
        return {
          value: {
            outcome: "publish",
            refusal_reason_code: null,
            candidates: [{
              place_id: "hp-cafe-on-air",
              role: "primary",
              fit_evidence_groups: [{ attribute: "daylight", evidence_ids: ["ev-cafe-air-daylight"] }],
              tradeoff_evidence_groups: [],
            }, {
              place_id: "hp-blue-house",
              role: "alternative",
              fit_evidence_groups: [{ attribute: "crowding", evidence_ids: ["ev-blue-crowding"] }],
              tradeoff_evidence_groups: [],
            }],
          },
          usage: null,
          response_id: "mock-reasoner-preference-coverage",
        };
      },
    },
  });

  assert.ok(result.draft.candidates.some((candidate) => (
    ["hp-shiteng", "hp-naive-tree"].includes(candidate.place_id)
  )));
});

test("retries one transient reasoner failure", async () => {
  const runtime = environment();
  const request = createEmptyDecisionRequest("req-reasoner-transient");
  request.task.type = "focus";
  request.soft_preferences = [{ field: "daylight", priority: "high" }];
  request.unknowns = [];
  let calls = 0;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("timeout");
        error.code = "MODEL_TIMEOUT";
        throw error;
      }
      return {
        value: {
          outcome: "publish",
          refusal_reason_code: null,
          candidates: draft.candidates.map(({ unknown_attributes, assumption_refs, ...candidate }) => candidate),
        },
        usage: null,
        response_id: "mock-reasoner-transient",
      };
    },
  };

  const result = await recommendForDecisionRequest(runtime.env, {
    session_id: "sess-reasoner-transient",
    request,
  });

  assert.equal(result.brief.status, "published");
  assert.equal(result.metrics.model_calls, 2);
  assert.ok(result.metrics.verification_repair_codes.includes("MODEL_TIMEOUT"));
});

test("retries one transient reasoner network error", async () => {
  const runtime = environment();
  const request = createEmptyDecisionRequest("req-reasoner-network-transient");
  request.task.type = "focus";
  request.soft_preferences = [{ field: "daylight", priority: "high" }];
  request.unknowns = [];
  let calls = 0;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("network");
        error.code = "MODEL_NETWORK_ERROR";
        throw error;
      }
      return {
        value: {
          outcome: "publish",
          refusal_reason_code: null,
          candidates: draft.candidates.map(({ unknown_attributes, assumption_refs, ...candidate }) => candidate),
        },
        usage: null,
        response_id: "mock-reasoner-network-transient",
      };
    },
  };

  const result = await recommendForDecisionRequest(runtime.env, {
    session_id: "sess-reasoner-network-transient",
    request,
  });

  assert.equal(result.brief.status, "published");
  assert.equal(result.metrics.model_calls, 2);
  assert.ok(result.metrics.verification_repair_codes.includes("MODEL_NETWORK_ERROR"));
});

test("refuses a conflicting duration and hard leave time before reasoning", async () => {
  const runtime = environment();
  let modelCalled = false;
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      modelCalled = true;
      throw new Error("Reasoner must not run for a deterministic time conflict");
    },
  };
  const request = createEmptyDecisionRequest("req-time-conflict");
  request.task.duration_minutes = 120;
  request.time.arrival_at = "2026-08-16T14:00:00+08:00";
  request.time.hard_leave_at = "2026-08-16T15:00:00+08:00";
  request.unknowns = [];

  const response = await post("/api/decision/recommend", {
    session_id: "sess-time-conflict",
    request,
  }, runtime.env);
  const result = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(result.brief.status, "refused");
  assert.equal(result.brief.refusal.reason_code, "time_window_conflict");
  assert.equal(modelCalled, false);
});

test("reports both reasoner calls when verification blocks both drafts", async () => {
  const runtime = environment();
  const request = createEmptyDecisionRequest("req-reasoner-block-count");
  request.task.type = "focus";
  request.soft_preferences = [{ field: "daylight", priority: "high" }];
  request.unknowns = [];
  runtime.env.QUIETLENS_MODEL_CLIENT = {
    async callStructured() {
      return {
        value: { outcome: "refuse", refusal_reason_code: "insufficient_comparison", candidates: [] },
        usage: null,
        response_id: "mock-blocked-reasoner",
      };
    },
  };

  await assert.rejects(
    recommendForDecisionRequest(runtime.env, {
      session_id: "sess-reasoner-block-count",
      request,
    }),
    (error) => {
      assert.equal(error.code, "EVIDENCE_VERIFICATION_BLOCKED");
      assert.equal(error.model_calls, 2);
      assert.deepEqual(error.verification_repair_codes, ["MODEL_REFUSAL_UNSUPPORTED"]);
      return true;
    },
  );
});
