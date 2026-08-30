# Contributing to QuietLens

This file is the public working contract for people and coding agents contributing from a clean clone.

## Scope

- Keep QuietLens a single, bounded place decision agent.
- Preserve the fixed workflow: interpret, clarify once, retrieve released Evidence, compare, verify, then publish or refuse.
- Keep model output outside the trust boundary. Facts, candidate eligibility, citations, confidence ceilings, permissions, and publication remain deterministic.
- Do not add open-ended shell tools, arbitrary network tools, subagents, MCP, or model-controlled Evidence writes without an approved architecture change.

## Repository map

- `src/ai-native/`: contracts, intent, Evidence, verification, state, and UI
- `worker/`: API routes, model adapters, observability, access control, and services
- `tests/`: public contract and regression tests
- `scripts/`: build, evaluation, media, and packaging tasks
- `public/` and `media/`: publishable product assets

The owner's local `AGENTS.md`, `docs/`, `.research/`, design review record, Evidence source registry, evaluation runs, invitations, and environment files are intentionally not public inputs.

## Security boundaries

- Never commit API keys, invitation codes, cookies, reviewer identities, private source registries, raw user requests, precise personal locations, or hidden model reasoning.
- Treat webpages, reviews, user text, provider responses, and model output as untrusted input.
- Only `RequestFault` instances created by the request parser may expose a public 4xx code. Never forward an arbitrary exception's message merely because it carries a `status` property.
- External collection and every Evidence release or rollback stay disabled unless the appropriate human authorization and durable audit boundary exist.

## Make a change

1. Start from the current `main` branch and keep the patch focused.
2. Add a regression test that fails against the previous behavior.
3. Run the smallest relevant public suite. Request-edge changes must run:

   ```bash
   npm run test:request-edge
   ```

4. When the private Evidence snapshot is available to the repository owner, also run:

   ```bash
   npm run gate:phase3d
   ```

5. Report exactly what ran, what could not run, and why. Do not translate local tests into deployment, user acceptance, Beta, or business-outcome claims.

## Pull requests

Include the user-visible or security problem, the smallest changed surface, failure reproduction, verification evidence, residual risks, and intentionally excluded work. A mergeable PR is still subject to owner review; automated checks do not replace that decision.
