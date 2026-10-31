# ADR-002: Serverless AWS backend, kept under ~5 €/month

- **Status:** Accepted
- **Date:** 2026-10-12 (confirms July 2025 design)

## Context
Owner is an AWS specialist; company pays AWS today but the app must stay affordable if that changes.

## Decision
S3 (images + static web) · DynamoDB on-demand, single-table · Lambda + API Gateway (HTTP API) ·
Bedrock (Claude Haiku-class vision model) for identification · Route 53 for the domain.
Two CDK stacks: `CollectorsData` and `CollectorsApi`. No VPC, no NAT, no RDS/Aurora.

## Consequences
- Expected cost 2–5 €/month after free tier; ~0.50 €/month in the first year.
- AI is the only meaningfully variable cost → gated by the local duplicate check (ADR-004).
- Cognito dropped: single user → Sign in with Apple + PKCE, long-lived refresh token.
