# n8n Workflow Configuration

Non-secret IDs the workflows depend on. Secrets (API tokens, client key, webhook secret) live only in n8n credentials and the password manager.

## Documenso templates

Recipients are matched by `signingOrder`, not by their position in API responses (the API doesn't return them in signing order).

| Template | Envelope ID | Employee recipient (order 1) | IT recipient (order 2) |
|---|---|---|---|
| Asset Assignment Agreement (checkout) | `envelope_bevvhdbxmyucxmvz` | `3709840` | `3709839` |
| Asset Return Form (checkin) | `envelope_vebezsuleweowkaf` | `3709844` | `3709845` |

### Field IDs

| Label | Assignment field ID | Return field ID | Recipient |
|---|---|---|---|
| `asset_tag` | `18376052` | `18375984` | Employee |
| `asset_model` | `18376054` | `18375985` | Employee |
| `asset_serial` | `18376053` | `18375986` | Employee |
| `event_date` | `18376055` | `18375987` | Employee |
| `condition_notes` | n/a | placed; ID not needed | IT recipient, **not** read-only, no default text (typed by IT at countersigning, never pre-filled) |

All four pre-filled fields are TEXT, read-only, with the stand-in text `(auto)` that the pre-fill replaces. Name, Email, Signature and Date fields aren't pre-filled: Documenso fills Name/Email from the recipient details and Date at signing time.

## People and notifications

| Role | Address | Source |
|---|---|---|
| Employee signer (order 1) | per document | Snipe-IT user the asset is checked out to / in from |
| IT signer (order 2) | per document | Snipe-IT admin who performed the action (activity log `created_by`) |
| IT team inbox (reminders, errors, rejection fallback) | `it-admin@example.com` | fixed |
| Test employees | `it-admin+<name>@example.com` | Gmail plus-addressing |

## Google Drive

| Item | ID |
|---|---|
| `Snipe-IT Agreements` root folder | `1MncxImAg_QYc2AKd_fc1bI5k1Poidp5s` (in the `it-admin@example.com` Drive, the account n8n's Google credentials use) |

Subfolders are named after the asset tag (e.g. `00001`) and created by Workflow 2 on first use. Files are named `YYYY-MM-DD_<checkout|checkin>_<employee>.pdf`.
