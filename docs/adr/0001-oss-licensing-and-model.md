# ADR 0001 — OSS licensing and commercial model

Status: Accepted (2026-06-15)
Context: OSS migration of Moira (branch `feature/oss-prep`). Records four decisions
that deliberately differ from the OSS-transition research
(`claude-temp-files/oss-research-*.md`). The research is sound input; these are the
post-research calls the project commits to. Each decision states what research point
it supersedes and why.

---

## Decision 1 — Model: all-OSS + runtime flags (no `packages/ee/`)

**Decision.** The entire codebase ships under one OSS license. Commercial behavior is
gated by runtime flags resolved through `FeatureResolver` + `DEPLOYMENT_MODE`
(`packages/shared/src/config/feature-resolver.ts`), not by a separate proprietary
`packages/ee/` directory. The code is not hidden. Revenue is protected by hosted-cloud
operations and by payment/provider secrets living in env, not by code secrecy.

**Context.** Earlier drafts (and the research) assumed open-core with an `ee/` folder
under a separate proprietary license.

**Rationale.** Chat/LLM/billing/SSO/cloud features are flagged code, not hidden code.
A flag-based seam keeps a single build, a single license, and no relicensing surface,
while the actual moat (running the hosted service + holding the payment-provider
secrets) does not require the code to be closed. This matches the Temporal/Dify
"permissive + ops moat" pattern that `oss-research-models.md` itself lists as the
majority approach for adoption-first dev tools.

**Consequences.** No `ee/` dual-build, no separate EE license file, no EE migrations.
The commercial layer is feature-flagged OSS code. Anyone can self-host every feature;
the paid offering is the managed cloud, not extra source.

**Supersedes research.** `oss-research-architecture.md` and `oss-research-governance.md`
(§5) recommend an `ee/`-folder open-core split. `oss-research-models.md` recommends
"build chat/LLM as a separate proprietary EE layer." → Superseded: no `ee/`, all-OSS +
flags. (The research's `ee/` plumbing — dual-build, separate license, EE migrations —
is therefore moot.)

---

## Decision 2 — License: Apache-2.0

**Decision.** The project is licensed under Apache License 2.0 (root `LICENSE`,
`package.json` `"license": "Apache-2.0"`).

**Context.** `package.json` previously declared MIT with no `LICENSE` file.

**Rationale.** Apache-2.0 is permissive (adoption parity with MIT) and adds an explicit
patent grant that enterprise legal teams value. `oss-research-governance.md` (§1, row
"Apache 2.0") marks it Recommended for the core for exactly this reason. MIT→Apache-2.0
removes no freedoms (it adds the patent clause), so it is not a backlash-triggering
restriction.

**Consequences.** All distributable code carries Apache-2.0. `THIRD_PARTY_LICENSES`
tracks dependency compatibility; AGPL/UNKNOWN transitive deps were removed via npm
overrides (see ADR-adjacent license remediation commit `5a34b331`).

**Supersedes research.** `oss-research-models.md` recommendation #1 ("keep the MIT
engine MIT") → Superseded by the Apache-2.0 choice. Aligns with governance.md's primary
recommendation.

---

## Decision 3 — AGPL rejected: moat is cloud operations + brand, adoption-first

**Decision.** The core engine is NOT moved to AGPLv3 (or BSL/SSPL/source-available).
The project consciously accepts cloud-resale exposure of the OSS core. The moat is (a)
running the official managed cloud and (b) the "Moira" brand/trademark, not a copyleft
legal moat.

**Context.** `oss-research-models.md` Caution 1 frames the core-license choice as a
one-way door that is cheaper to decide while the project is still small: permissive
(no legal moat, ops/brand moat) vs AGPLv3 + dual-license (legal moat against
hyperscaler resale, Windmill pattern).

**Rationale.** Priority is adoption + trust + community. AGPL's network-copyleft scares
enterprises and slows adoption (models.md: "AGPL scares some enterprises → slower
adoption"). Moving permissive→AGPL later is itself a relicensing event that triggers
forks (Terraform→OpenTofu, Elastic, Redis); deciding now to stay permissive avoids that
event entirely. The cloud-resale risk is accepted in exchange for maximum adoption.

**Consequences.** A hyperscaler/competitor may legally host the OSS core. Defense rests
on operational speed, "official" status, hosted-cloud convenience, and the trademark
(Decision 4 dependency: see `TRADEMARK.md`). This is a deliberate, recorded trade-off,
not a default — revisit only with a conscious relicensing decision (which would itself
be a fork-risk event).

**Supersedes research.** `oss-research-models.md` Caution 1 / recommendation #4 and
`oss-research-governance.md` §1 AGPL-fallback both insist on a deliberate documented
decision. → This ADR is that decision: AGPL rejected, permissive + cloud/brand moat,
adoption-first.

---

## Decision 4 — Contributions: DCO (not CLA)

**Decision.** Inbound contributions use the Developer Certificate of Origin (sign-off
via `git commit -s`), documented in `CONTRIBUTING.md`. No CLA.

**Context.** `oss-research-governance.md` §2 recommends a CLA (CLA Assistant bot),
arguing open-core needs the right to fold community contributions into proprietary EE
and to relicense.

**Rationale.** That argument is a direct consequence of open-core (Decision 1). With no
proprietary `ee/` and no planned relicensing, the CLA's purpose evaporates: there is
nothing proprietary to fold contributions into. DCO certifies provenance with far less
contributor friction. governance.md itself notes the fallback: "if adoption is a higher
priority than flexibility, use DCO."

**Consequences.** Contributors sign off commits; no separate agreement to sign. If the
project ever pursued a proprietary EE or a relicense, a CLA would need to be introduced
first — which the all-OSS model (Decision 1) explicitly avoids.

**Supersedes research.** `oss-research-governance.md` §2 (CLA recommended) → Superseded
by DCO, as a downstream consequence of Decision 1 (no `ee/`, no relicensing plan).

---

## Cross-references

- Brand moat (depends on Decision 3): `TRADEMARK.md`
- Dependency licenses + AGPL remediation: `THIRD_PARTY_LICENSES`
- Feature-flag seam (Decision 1): `packages/shared/src/config/feature-resolver.ts`
