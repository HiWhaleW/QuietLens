# QuietLens Agent and Harness Architecture

QuietLens is one user-facing place decision agent, not a multi-agent system. It combines two bounded model responsibilities with a deterministic application Harness.

```text
Natural-language request
  -> input validation and safety checks
  -> model-assisted intent interpretation
  -> at most one deterministic clarification
  -> allowlisted Evidence retrieval
  -> model-assisted candidate comparison
  -> deterministic constraint, citation, and confidence verification
  -> publish a Decision Brief or fail closed
```

## Model and Harness responsibilities

| Model-assisted | Deterministic Harness |
| --- | --- |
| Interpret ambiguous intent | Validate request and output schemas |
| Compare eligible Evidence | Enforce the 10-place allowlist and hard constraints |
| Draft bounded reasons and trade-offs | Verify citations, conflicts, unknowns, and confidence ceilings |
| Interpret an incremental correction | Control state transitions, permissions, logging, and final rendering |

The model is never a factual source. Model output cannot add a place, convert missing Evidence into a satisfied constraint, publish Evidence, or bypass verification.

## Execution scope and approval

QuietLens separates the capability boundary from the approval boundary.

| Operation | Execution scope | Approval rule |
| --- | --- | --- |
| Interpret or compare a user's current request | Current invite session and server-side model adapter | Authorized by the user's submitted decision request |
| Read released Evidence | Versioned read-only Evidence snapshot | Automatic inside the decision workflow |
| Create a candidate Evidence record | Pending, untrusted review workspace | Reviewer workflow only; never consumer-triggered |
| Release or roll back Evidence | Signed, versioned Evidence release | Explicit authorized human action |
| Call an unapproved external source or mutate the allowlist | Outside the active scope | Forbidden by default |

This is an application-level policy boundary, not an operating-system sandbox. Infrastructure isolation, server-side secrets, provider egress controls, and human release procedures remain separate controls.

## Failure contract

- Only typed request faults may return their stable public code and 4xx status.
- Provider, storage, and unexpected exceptions return a route-specific stable code; internal messages are not exposed.
- Invalid model output, missing citations, unknown hard constraints, or unavailable Evidence fail closed.
- Analytics failure cannot make an unverified decision publishable.

## Why Codex is a reference, not a dependency

The architecture adopts two ideas from OpenAI Codex:

1. sandbox scope and approval policy are separate decisions;
2. durable repository instructions should be discovered from project context.

The reference was reviewed at OpenAI Codex commit [`cefa060`](https://github.com/openai/codex/tree/cefa060695594cdeebfb4306170cc27487c8a088), especially the approval/sandbox orchestration and project-instruction discovery. QuietLens does **not** embed Codex CLI or App Server and does not adopt shell execution, worktrees, arbitrary tool loops, subagents, MCP, or a model-controlled goal loop.

The public clone uses [CONTRIBUTING.md](CONTRIBUTING.md) as a Codex project-instruction fallback through [`.codex/config.toml`](.codex/config.toml). The owner's private operating record and research material remain outside Git.

## Primary implementation locations

- `worker/services/decisionService.js`: fixed decision orchestration
- `worker/ai/`: bounded model adapters and prompts
- `src/ai-native/evidence/`: Evidence retrieval and eligibility
- `src/ai-native/decision/verifyAndRender.js`: deterministic publication gate
- `worker/routes/http.js`: trusted public request-fault boundary
- `src/ai-native/state/decisionReducer.js`: visible F0-F7 state transitions

## Validation

```bash
npm run test:request-edge
npm run gate:phase3d
```

The full Phase 3D gate requires the owner's private Evidence and evaluation snapshot. External contributions should use synthetic fixtures and report the exact subset that ran; passing tests are not product-owner acceptance or deployment evidence.
