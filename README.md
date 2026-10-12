# Snipe-IT Asset Agreement Automation

> **🚧 Work in progress.** The hand-built AWS infrastructure and the n8n Cloud version of the automation are finished and tested. A self-hosted n8n rebuild is under way, followed by a Terraform rebuild. This repo is updated as each phase lands.

When IT checks a laptop or phone out (or back in) in **Snipe-IT**, this project sends the right agreement for e-signature, has it signed by the employee and then by the IT admin who did the handover, and archives the signed PDF on the asset record and in Google Drive. Rejections, unsigned agreements and failures reach IT by email. Nothing in Snipe-IT is ever changed automatically.

**Read the full write-up:** [docs/case-study.md](docs/case-study.md)

## Stack

| Layer | What |
|---|---|
| Asset system | Snipe-IT in Docker on AWS EC2, RDS MariaDB in private subnets, Caddy for HTTPS and access rules, SSM instead of SSH |
| Automation | n8n: four workflows (send for signature, archive on completion, unsigned reminder, error handler) |
| E-signature | Documenso (API v2 and webhooks) |
| Archive and alerts | Google Drive (a folder per asset) and Gmail |

## Highlights

- **A SaaS tool with no fixed IP, connected to a private system:** n8n Cloud reaches Snipe-IT's API through mutual TLS with a private CA plus a least-privilege API token, instead of an IP allowlist.
- **Webhook as signal, API as source of truth:** Snipe-IT's webhook can't be authenticated, so every event is verified against Snipe-IT's own activity log before anything is sent.
- **Tested with three real documents** (checkout, check-in, rejection) on a 5-documents-a-month free plan, plus security tests that used none.
- **Built by hand first, codified later:** the console mistakes are documented as the case for Terraform.

## Status

| Phase | State |
|---|---|
| AWS infrastructure, built by hand in the console | ✅ Done |
| Signing automation on n8n Cloud, with mTLS | ✅ Done and tested |
| Self-hosted n8n rebuild and comparison, one business timezone | 🚧 In progress |
| Terraform rebuild of the infrastructure | ⏳ Planned |
| Final diagram and demo recording | ⏳ Planned |

## Repository map

| Path | Contents |
|---|---|
| [`docs/case-study.md`](docs/case-study.md) | The write-up: problem, architecture, decisions, testing, limitations |
| [`docs/notes.md`](docs/notes.md) | Full build log, including every mistake and dead end |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs for each phase |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Step-by-step implementation plans |
| [`docs/gui-build/`](docs/gui-build/) | Server config (Docker Compose, Caddyfile, env example) for the n8n Cloud version; [`self-hosted/`](docs/gui-build/self-hosted/) holds the version in progress |
| [`n8n/workflows/`](n8n/workflows/) | Exported n8n workflows (n8n Cloud version) |
| [`n8n/config.md`](n8n/config.md), [`n8n/samples/`](n8n/samples/) | Documenso template and field IDs; sample Snipe-IT webhook payloads |
| [`docs/templates/`](docs/templates/) | The agreement PDFs used as Documenso templates |
| [`docs/screenshots/`](docs/screenshots/) | Screenshots referenced by the write-up |

Secrets (API tokens, certificates, keys, `.env` files) are never committed. Exported workflows reference n8n credentials by name only, and test email addresses are replaced with `example.com` placeholders.

This is a personal lab project. The AWS environment will be torn down once the project is complete.
