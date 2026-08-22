import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backlog = JSON.parse(await readFile(
  new URL("../docs/stage-2/evidence-pipeline/v1.0/legacy-poi-expansion-backlog.json", import.meta.url),
  "utf8",
));

test("accounts for all 22 legacy poi-only records without duplicate identities", () => {
  assert.equal(backlog.items.length, 22);
  assert.equal(new Set(backlog.items.map((item) => item.legacy_id)).size, 22);

  const counts = backlog.items.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});

  assert.deepEqual(counts, {
    prototype_candidate: 11,
    retired_replaced: 5,
    already_promoted: 5,
    identity_replaced: 1,
  });
});

test("keeps crawled records pending human review and prevents automatic promotion", () => {
  assert.equal(backlog.publication_status, "not_published");
  assert.equal(backlog.human_review_status, "pending");
  assert.equal(backlog.release_gate.ai_is_factual_source, false);
  assert.equal(backlog.release_gate.search_output_is_factual_source, false);
  assert.equal(backlog.release_gate.automatic_promotion_allowed, false);
  assert.equal(backlog.release_gate.human_review_required, true);
  assert.equal(backlog.release_gate.unsupported_numeric_sensory_scores_allowed, false);
});

test("requires traceable pages for original and replacement prototype candidates", () => {
  const candidates = backlog.items.filter((item) => item.status === "prototype_candidate");
  const retired = backlog.items.filter((item) => item.status === "retired_replaced");
  const replacements = retired.map((item) => item.replacement);

  assert.ok(candidates.every((item) => item.sources.length > 0));
  assert.ok(candidates.every((item) => item.sources.every((source) => /^https?:\/\//.test(source.url))));
  assert.ok(candidates.every((item) => item.unknown_fields.includes("photo")));
  assert.equal(new Set(replacements.map((item) => item.replacement_id)).size, 5);
  assert.ok(replacements.every((item) => item.status === "prototype_candidate"));
  assert.ok(replacements.every((item) => item.sources.length > 0));
  assert.ok(replacements.every((item) => item.sources.every((source) => /^https?:\/\//.test(source.url))));
  assert.ok(replacements.every((item) => item.unknown_fields.includes("photo")));
});

test("does not reintroduce legacy numeric sensory scores into the research backlog", () => {
  const forbiddenKeys = new Set(["scores", "confidence", "weekendPenalty", "rating", "cost"]);
  for (const item of backlog.items) {
    assert.equal(Object.keys(item).some((key) => forbiddenKeys.has(key)), false, item.legacy_id);
    if (item.replacement) {
      assert.equal(
        Object.keys(item.replacement).some((key) => forbiddenKeys.has(key)),
        false,
        item.replacement.replacement_id,
      );
    }
  }
});

test("records the online enrichment run without pretending OpenCLI or human review completed", () => {
  assert.deepEqual(backlog.online_enrichment_run, {
    started_at: "2026-08-19",
    requested_method: "opencli",
    opencli_version: "1.8.6",
    opencli_browser_bridge_status: "blocked_extension_not_connected",
    opencli_page_requests_completed: 0,
    fallback_discovery: "exa_search_and_fetch",
    fallback_reason: "Public-web enrichment continued without reading any logged-in browser session while the OpenCLI Browser Bridge extension was absent.",
    candidate_count: 16,
    result_slots_reviewed: 175,
    body_fetch_attempts: 30,
    photos_collected: 0,
    publication_effect: "none",
    next_review_stage: "Stage 3 public Beta running period",
    seed_user_role: "Provide consented on-site observations after launch; observations remain untrusted candidates until a separately authorized human reviewer approves a release.",
    release_before_stage3_launch_required: false,
  });
  assert.equal(backlog.human_review_status, "pending");
  assert.equal(backlog.publication_status, "not_published");
});

test("keeps discovered conflicts and Stage 3 candidates out of automatic release", () => {
  const oneGarden = backlog.items.find((item) => item.legacy_id === "xh-one-garden");
  assert.ok(oneGarden.candidate_address.includes("2号 / 衡山路2号甲"));
  assert.ok(oneGarden.unknown_fields.includes("address_human_confirmation"));
  assert.equal(oneGarden.verified_fields.includes("address"), false);
  assert.equal(backlog.release_gate.automatic_promotion_allowed, false);
  assert.equal(backlog.release_gate.human_review_required, true);
});
