---
name: vibe-bridge
purpose: "Vibe Bridge is a pull-based runner and control plane that bridges internal services to local-only tooling"
version: 1
owner: "Nariya Takemura"
lastReviewedAt: "2026-03-09"
reviewPolicy:
  codeOwnersRequired: true
  requiredApprovals: 1
selfEvolution:
  mode: proposal-only
  requireReason: true
  requireRollbackPlan: true
---

# SOUL

## IDENTITY
- Product identity: `vibe-bridge`.
- Primary users: end users, developers, operators, and business stakeholders.
- User promise: deliver stable value while keeping direction explicit and reviewable.
- Non-goals:
  - Do not optimize only for short-term speed at the cost of product integrity.
  - Do not introduce complexity without clear user or operational benefit.

## PRINCIPLES
- Preserve product intent over local convenience.
- Keep changes small, testable, and reversible.
- Align implementation and docs continuously.
- Treat security and data safety as first-class constraints.

Decision rule:
- If a proposal conflicts with core principles or no-go conditions, do not adopt it.

## CAPABILITIES
- Current strengths:
- Core stack detected: TypeScript.
- Documentation directory exists for contracts and operations.
- Test-related files/directories are present.
- Current blind spots:
- CI guardrails are missing; regressions may slip through.
- Ownership/review boundaries are not explicitly enforced by CODEOWNERS.
- Near-term capability targets (next 1-2 months):
  - Make quality signals explicit (tests, docs, CI, review boundaries).
  - Reduce intent drift between code, docs, and operational behavior.

Task proposal lens:
- Start from user/operator pain, then define the smallest meaningful task set.
- Keep proposed changes auditable: objective, expected impact, rollback.
- Update docs/contracts in the same change set when behavior changes.

## CONSTRAINTS
- Safety / security constraints:
  - Never include secrets or personal sensitive data in SOUL.
  - Reject changes that weaken auth, data integrity, or auditability.
- Regulatory / contractual constraints:
  - Keep behavior and docs consistent with explicit team agreements.
- Performance / cost constraints:
  - Prefer measurable improvements and staged rollout over speculative rewrites.
- No-Go conditions (must stop):
  - Irreversible data-destructive changes without proven backup/rollback.
  - Releasing known high-severity issues without owner sign-off.
  - Unreviewed SOUL changes merged directly.

## EVOLUTION
Self-evolution policy:
- SOUL self-improvement is allowed only as proposal-only.
- Every SOUL update requires reason, expected impact, and rollback plan.

Open proposals:
- [ ] (proposal id) Add project-specific KPI mappings for intent validation.
  - reason: make strategic intent measurable
  - expected impact: faster prioritization and clearer tradeoffs
  - rollback: revert KPI section to previous version

Evolution log:
| Date | Version | Change | Author | Review |
|------|---------|--------|--------|--------|
| 2026-03-09 | 1 | Initial SOUL baseline generated (TypeScript) | Nariya Takemura | pending |

## RELATIONSHIPS
- Dependencies:
  - Core runtime/framework/tooling used by this repository
  - CI/CD, documentation, and task tracking infrastructure
- Upstream systems:
  - Product requirements, contracts, and policy documents
- Downstream consumers:
  - End-user experience and internal operating workflows
- Team boundaries / ownership boundaries:
  - Code changes and SOUL changes require human review according to repo policy
