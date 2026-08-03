# Galaxy Crash — Documentation Index

## For operators integrating us (external)
- **[Seamless Wallet Integration Spec v1](specs/seamless-wallet-v1.md)** — the contract for embedding Galaxy Crash in your casino. Game launch, wallet callbacks, signing, idempotency, retries, errors.
- **[Operator Backoffice REST API v1](specs/operator-backoffice-v1.md)** — what we expose back to you for support, reconciliation, RG enforcement, and configuration.

## For internal staff
- **[Studio Backoffice REST API v1](specs/studio-backoffice-v1.md)** — cross-tenant control plane. Operator onboarding, money, rounds, bets, audit, reconciliation runs.

## Implementation plans
- **[B2B Seamless Wallet Platform (2026-05-18)](plans/2026-05-18-b2b-seamless-wallet-platform.md)** — the plan implementing all three specs above. Phased, ships independently.

## Reference / archived
- **[RNG Reference](README.md)** — the provably-fair crash-point generator, with proofs and empirical validation.
- **[Project Spec](PROJECT_SPEC.md)** — original B2C game spec.

## Doc conventions

- `doc/specs/*-v1.md` — public/internal API contracts. Versioned. Breaking changes ship as `-v2.md`.
- `doc/plans/YYYY-MM-DD-<slug>.md` — implementation plans. One per major initiative.
- `doc/ops/runbooks/*.md` — on-call procedures (created as needed by the plans).
- `doc/integrations/*.md` — operator-specific setup guides (e.g. SoftSwiss).
