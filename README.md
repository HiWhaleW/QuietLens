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
  <img src="https://img.shields.io/badge/scope-10%20Huangpu%20cafés-D6A313?style=flat-square" alt="10 controlled Huangpu cafés">
  <img src="https://img.shields.io/badge/license-all%20rights%20reserved-D84A3A?style=flat-square" alt="All rights reserved">
</p>

<p align="center">
  <a href="#what-quietlens-does"><strong>Product overview</strong></a>
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
2. asks one clarification when the interpreted request is incomplete, with a hard limit of one question;
3. filters a controlled place set with deterministic hard constraints;
4. retrieves only eligible evidence;
5. returns two or three comparable decision briefs by default, or one confirmed option when a strict hard constraint leaves only one eligible candidate;
6. shows trade-offs, assumptions, unknowns, confidence, and evidence scope; and
7. accepts a correction without forcing the user to restart.

The product never exposes hidden chain-of-thought. Explanations are limited to concise, verifiable decision grounds.

## The AI-native loop

```text
Natural-language request
→ editable Decision Request
→ one clarification when required fields remain incomplete
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
| Mandatory clarification, one-round maximum | If the visible structured request remains incomplete after extraction, ask for the highest-priority missing information once; never ask a second question. |
| One to three decision briefs | Compare two or three options by default without a fake ten-place ranking; when a strict hard constraint leaves one confirmed option, show that option without padding the result with unknown candidates. |
| Evidence-backed explanations | Inspect localized decision grounds, verification dates, reliability, and source links without exposing internal model text. |
| Map-first exploration | Keep all 10 registered cafés selectable without changing the published recommendation order. |
| Store-specific detail | Open a café to see its role in the current decision and its bounded sensory profile. |
| Watercolor place reveal | Expand a selected café through an original torn-paper watercolor scene. |
| Correction loop | Add or revise a condition while preserving the rest of the Decision Request. |

## AI and deterministic responsibilities

| Model-assisted | Deterministic |
| --- | --- |
| Interpret ambiguous natural language | Validate the Decision Request schema |
| Interpret which unresolved field the user is addressing | Decide whether the request is incomplete, prioritize the clarification target, and enforce the one-question limit |
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

## License

Copyright © 2026 QuietLens. All rights reserved.

Public availability does not grant permission to copy, modify, distribute, sublicense, or use this project commercially. See [LICENSE](LICENSE) for the complete terms.
