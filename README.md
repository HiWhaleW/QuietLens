<p align="center">
  <img src="media/quietlens-product-preview.png" alt="QuietLens AI-native decision brief on a watercolor map of Shanghai" width="1200">
</p>

<h1 align="center">QuietLens</h1>

<p align="center">
  An evidence-backed place decision agent for finding lower-friction work and recovery spaces.<br>
  It does not ask which café is most popular. It asks which place is less likely to disrupt what you need to do right now.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/AI--native-decision%20agent-0B57D0?style=flat-square" alt="AI-native decision agent">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=061A2E" alt="React 19">
  <img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 6">
  <img src="https://img.shields.io/badge/scope-10%20Huangpu%20cafés-D6A313?style=flat-square" alt="10 controlled Huangpu cafés">
  <img src="https://img.shields.io/badge/license-all%20rights%20reserved-D84A3A?style=flat-square" alt="All rights reserved">
</p>

<p align="center">
  <a href="#what-quietlens-does"><strong>Product overview</strong></a>
  ·
  <a href="#run-locally"><strong>Run locally</strong></a>
  ·
  <a href="https://github.com/HiWhaleW/QuietLens/issues"><strong>Report an issue</strong></a>
</p>

> [!NOTE]
> QuietLens is an experimental desktop portfolio prototype. Its current evidence boundary is a controlled set of 10 cafés in Huangpu, Shanghai; it is not comprehensive coverage of Shanghai.

> [!IMPORTANT]
> **Not medical advice and not a real-time availability service.** QuietLens does not diagnose sensory conditions or guarantee current seating, noise, crowd levels, opening hours, or accessibility. Verify time-sensitive details before travelling.

## What QuietLens does

QuietLens turns a natural-language request into a bounded, inspectable place decision. A user can describe the task, time, area, walking limit, hard constraints, and sensory preferences in their own words. The system then:

1. extracts a visible, editable intent summary;
2. asks at most one question when the missing answer could materially change the result;
3. filters a controlled place set with deterministic hard constraints;
4. retrieves only eligible evidence;
5. returns two or three comparable decision briefs;
6. shows trade-offs, assumptions, unknowns, confidence, and evidence scope; and
7. accepts a correction without forcing the user to restart.

The product never exposes hidden chain-of-thought. Explanations are limited to concise, verifiable decision grounds.

## The AI-native loop

```text
Natural-language request
→ editable Decision Request
→ at most one high-value clarification
→ deterministic hard-constraint filter
→ controlled evidence retrieval
→ model-assisted comparison
→ deterministic verification and rendering
→ user correction
```

AI is necessary for interpreting ambiguous intent, comparing heterogeneous evidence, and understanding incremental corrections. It is not the factual source and does not control the safety boundaries.

## Core experience

| Capability | What the user gets |
| --- | --- |
| Natural-language entry | Describe the situation without translating it into a complex filter form. |
| Editable intent summary | Inspect and correct the task, arrival time, area, walking limit, and priorities. |
| One-question maximum | Clarification is used only when it can change the candidate set or first choice. |
| Two or three decision briefs | Compare a preferred option, a conditional preference, and an alternative without a fake ten-place ranking. |
| Evidence-backed explanations | See fit reasons, trade-offs, confidence, assumptions, source scope, and unresolved facts. |
| Map-first exploration | Keep all 10 registered cafés selectable without changing the published recommendation order. |
| Store-specific detail | Open a café to see its role in the current decision and its bounded sensory profile. |
| Watercolor place reveal | Expand a selected café through an original torn-paper watercolor scene. |
| Correction loop | Add or revise a condition while preserving the rest of the Decision Request. |

## AI and deterministic responsibilities

| Model-assisted | Deterministic |
| --- | --- |
| Interpret ambiguous natural language | Validate the Decision Request schema |
| Identify the most valuable clarification target | Enforce the one-question limit |
| Compare retrieved evidence across candidates | Apply candidate allowlists and hard constraints |
| Draft bounded reasons and trade-offs | Verify citation existence and evidence eligibility |
| Understand an incremental correction | Enforce confidence ceilings and render the final brief |

Missing evidence is never treated as proof that a condition is satisfied. Reviews, webpages, and user-provided text are untrusted inputs until they pass the evidence pipeline.

## Current evidence boundary

- 10 controlled cafés in Huangpu, Shanghai
- public, traceable source material organized into atomic evidence records
- explicit separation between facts, sourced observations, editorial references, conflicts, and unknowns
- no claim of real-time seating, sound level, crowding, or opening status
- no open-ended place generation outside the controlled candidate set

The watercolor map and café scenes are product assets, not evidence. Third-party research photographs and private source registries are not included in this repository.

## Run locally

Requirements:

- Node.js 20+
- npm
- a server-side DeepSeek API key for the model-backed decision flow

```bash
git clone https://github.com/HiWhaleW/QuietLens.git
cd QuietLens
npm install
npm run build
npm run serve:local
```

Open `http://127.0.0.1:4173/`.

Store the key only in a local `.env.local` file:

```text
DEEPSEEK_API_KEY=your_key_here
```

The key is read by the server-side worker. Never prefix it with `VITE_`, expose it to client code, or commit the environment file.

For interface-only development:

```bash
npm run dev
```

## Architecture

- React 19 and Vite 6
- a bounded Intent Interpreter and Decision Reasoner
- deterministic request validation, hard-constraint filtering, evidence verification, and rendering
- server-side model calls through a Responses API adapter
- versioned, privacy-minimized analytics that exclude raw requests, precise personal locations, and hidden reasoning
- three discrete watercolor map boards: Shanghai overview, central city, and Huangpu detail
- desktop-first interface with a restrained notice below 1180 px
- reduced-motion support for the torn-paper café reveal

## Repository layout

```text
src/ai-native/       contracts, retrieval, verification, state, and AI-native UI
worker/              server-side decision routes, model adapters, and analytics
public/assets/map/   original watercolor map boards
public/assets/cafes/ original watercolor café scenes
tests/               contract, safety, evaluation, analytics, and hosting checks
media/               public README assets
```

## Validation

```bash
npm run test:phase3c
npm run test:phase3b
npm run test:analytics
npm run test:sites
npm run build
```

Live-model evaluation requires a local API key and is intentionally separate from deterministic regression tests.

## Privacy and security

- Environment files, local research, internal documentation, generated evaluation reports, and build output are excluded from Git.
- Raw natural-language requests, exact personal locations, hidden reasoning, and API credentials must not be logged.
- Model output cannot bypass the place allowlist, evidence eligibility rules, citation checks, or hard constraints.
- The public repository contains no private API key or local machine path.

## License

Copyright © 2026 QuietLens. All rights reserved.

Public availability does not grant permission to copy, modify, distribute, sublicense, or use this project commercially. See [LICENSE](LICENSE) for the complete terms.
