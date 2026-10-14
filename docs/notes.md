# Build Notes

Raw notes captured during the build, used as source material for the case study.

## Lessons learned

### Forgot the initial database name in the RDS console (GUI phase)
- The "Initial database name" field is inside the collapsed **Additional configuration** panel at the bottom of the RDS create form. I skipped it, so RDS created the MariaDB server with no `snipeit` database.
- The setting can't be changed after creation. Instead of recreating the instance, I'll create the database from the EC2 instance:
  `CREATE DATABASE snipeit CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
- Running that command doubles as the first connectivity test (EC2 → RDS on 3306 through the security group reference), before Snipe-IT is involved.
- **Why this matters for IaC:** in the console, a setting hidden in a collapsed panel is easy to miss. In Terraform it's one line (`db_name = "snipeit"`), it's applied on every rebuild, and it shows up in code review.

### Console template picked a production-size database (GUI phase)
- The first RDS instance came up as **`db.r7g.large`** (memory-optimized, 16 GB RAM, roughly $170/month) instead of the planned `db.t4g.micro`/`db.t3.micro` (about $12/month). The template chosen on the create page sets defaults for many settings at once: instance class, storage type (possibly Provisioned IOPS, which bills per IOPS), monitoring and deletion protection.
- Fix: deleted and recreated it instead of modifying it, because RDS storage can't be shrunk after creation. Recreating also fixed the missing initial database name. The database was empty, so nothing was lost.
- Added a $20/month AWS Budgets alert so a cost mistake like this sends an email within days instead of going unnoticed.
- **Why this matters for IaC:** Terraform has no template defaults to accept by accident. `instance_class = "db.t4g.micro"` is written out, reviewable, and the same on every apply.

### Launched EC2 into the private subnet (GUI phase)
- The first `snipeit-app` instance got private IP `10.0.133.220`, which is inside the private subnet's range (`10.0.128.0/20`). AWS still allowed an Elastic IP to be attached, but the private route table has no route to the internet gateway, so no traffic could flow in or out. SSM would never have connected.
- Caught by reading the private IP against the subnet CIDRs, before spending time troubleshooting SSM.
- Fix: terminated and relaunched in the public subnet (an instance can't change subnets), then moved the same Elastic IP to the new instance. The public IP stayed the same, which is exactly what an Elastic IP is for.
- **Why this matters for IaC:** in Terraform, `subnet_id = aws_subnet.public_a.id` refers to the subnet by a meaningful name. In the console it's a dropdown of similar-looking IDs.

### RDS needs two private subnets, not one
- The original design had a single private subnet. An RDS DB subnet group must span at least two Availability Zones, even for a single-AZ instance, so the design now has 2 private subnets (plus 2 public).

## Validation checkpoints

- **SSM + outbound internet:** first Session Manager session worked with no inbound ports open. `curl ifconfig.me` returned the Elastic IP `67.202.58.185`. (Screenshot 08)
- **EC2 → RDS:** from the instance, `mysql -h <rds-endpoint> -u snipeit_admin -p --ssl -e "SHOW DATABASES;"` listed `snipeit`. This one test proved the security-group reference rule, private-subnet routing inside the VPC, and the initial database name, before installing Docker or Snipe-IT. (Screenshot 09)
- Troubleshooting approach: a timeout means a network problem (security group or routing), while "access denied" means the network is fine and the credentials are wrong.

## Security observations

### Hostname probed seconds after the certificate was issued
- Caddy obtained the Let's Encrypt certificate for `snipeit.jkdeleon.net`, and within 1 to 13 seconds requests arrived from three unrelated IPs, including a crawler identifying itself as "ForestEngine".
- Cause: every publicly trusted certificate is published in **Certificate Transparency (CT) logs**, and scanners watch those logs to discover new hostnames. A new subdomain is effectively public the moment its certificate is issued.
- Risk: Snipe-IT's first-run setup wizard lets whoever reaches it first create the admin account.
- Mitigation: temporarily restricted the EC2 security group (80/443) to my own IP until the admin account was created, then reopened it.
- **For the Terraform phase:** the setup-wizard exposure exists on every fresh apply. Options: apply with the security group restricted to my IP (a variable like `allowed_cidrs`), finish setup, then widen it with a second apply. Or seed the admin user non-interactively so the wizard is never exposed.

### Pre-flight: Snipe-IT thought the site was plain HTTP
- The setup wizard's URL check failed: `APP_URL` was `https://…` but Snipe-IT saw requests as `http://`. Caddy terminates TLS and forwards plain HTTP with `X-Forwarded-Proto: https`, but Snipe-IT wasn't trusting that header.
- Root cause, found by reading Snipe-IT's `config/trustedproxy.php`: `APP_TRUSTED_PROXIES` only sets *which proxies* to trust. Current versions also require `APP_TRUSTED_HEADERS` to say *which forwarded headers* to trust, and they default to none. The official `.env.docker` example doesn't include it.
- Fix: `APP_TRUSTED_HEADERS=HEADER_X_FORWARDED_FOR,HEADER_X_FORWARDED_HOST,HEADER_X_FORWARDED_PROTO` (only the three headers Caddy sends), then recreated the app container.
- Why it's opt-in: trusting forwarded headers from anyone would let a client spoof its IP via `X-Forwarded-For` and bypass login throttling.

### Pre-flight: "Config File" warning
- Snipe-IT can't tell whether `.env` is web-exposed, so it asks for a manual check. Verified: `https://snipeit.jkdeleon.net/.env` returns 403 (Apache blocks dotfiles). Also, in this setup the `.env` lives on the host at `/opt/snipeit/.env` and reaches the container as environment variables, so there's no `.env` in the web root at all.

## Sub-project 2 research (n8n + Documenso + Google Drive)

### Documenso free plan: tested instead of assumed
- Documenso's pricing page lists API access only on paid plans, which suggested the free plan couldn't be automated. I created an API token on the free plan and tested it: `GET https://app.documenso.com/api/v2/template` returned **HTTP 200**. The Webhooks settings page is also available on free, with a shared-secret field.
- Lesson: a pricing page that *doesn't mention* a feature isn't proof the feature is missing. A two-minute API call settled it.
- Constraint: **5 documents per month** on free. Plan to use n8n's "pin data" so downstream steps can be re-tested without creating new documents.
- API notes: v2 base URL `https://app.documenso.com/api/v2`, header `Authorization: <token>`. Docs say templates/documents are being replaced by "envelopes" (`POST /envelope/use`), so new work should use envelopes.

### Snipe-IT webhook and API facts (checked in Snipe-IT's source)
- The "General" webhook sends a **Slack-formatted** message: asset name with a link (`/hardware/{id}`), target user with a link (`/users/{id}`), admin, note, location. It includes **no email and no serial number**. n8n must pull the IDs out of the links, then fetch the full data from the Snipe-IT API.
- Since a 2026 security fix, the webhook address must be a public URL (internal/private addresses are rejected).
- Signed PDFs can be uploaded to an asset with `POST /api/v1/hardware/{id}/files` (multipart field `file[]`, optional `notes`; needs file-management rights on the asset).
- **The check-in webhook doesn't name the employee.** The checkout message has `To` (employee) and `By` (admin) links; the check-in message only has administrator, status and location. The employee for check-ins comes from the asset's activity log (`GET /api/v1/reports/activity?item_type=asset&item_id=…`), which the workflow reads anyway to verify the event.
- Adding a note: `POST /api/v1/notes/{assetId}/store` with `note`; needs edit rights on the asset.
- Documenso details (from its OpenAPI spec and docs): create from template with `POST /api/v2/envelope/use` (multipart field `payload` = JSON with `envelopeId`, `externalId`, `recipients[{id,email,name,signingOrder}]`, `prefillFields`, `distributeDocument`, `override.title`); list with `GET /api/v2/envelope?status=PENDING` (no externalId filter, so filter in n8n); download signed PDF with `GET /api/v2/envelope/item/{itemId}/download?version=signed`; webhook secret arrives in header `X-Documenso-Secret`; completed/rejected payloads include `envelopeId`, `externalId`, `recipients[].rejectionReason`.

## Sub-project 2 build log

### `n8n-bot` least privilege: the settings page didn't match reality
- First test of the `n8n-bot` token: `hardware 200`, `users 403`, `licenses 200`, `accessories 200`, nearly the opposite of the intent.
- `GET /api/v1/users/me` showed the stored permissions (`1` = Grant, `-1` = Deny, `0` = Inherit from groups): View and Edit had been granted on every item type (accessories, consumables, licenses, components), and `users.view` was denied.
- Also found: uploading files to an asset needs **`assets.files`**, separate from `assets.edit`.
- Fixed (users.view and assets.files granted; other item types denied) and re-tested: `hardware 200`, `users 200`, `licenses 403`, `accessories 403`.
- Lesson: verify least privilege by testing what the credential can and can't do. The permissions screen is easy to misclick, and the test catches it.

### Locked out of the admin account
- Forgot both the admin username and password. Recovery without SSH or an open database port:
  1. Over SSM, queried RDS: `SELECT id, username, email, JSON_EXTRACT(permissions, '$.superuser') FROM users WHERE deleted_at IS NULL;` to find the superuser's username.
  2. Used Snipe-IT's "Forgot password". With `MAIL_MAILER=log`, the reset email is written to the container log, so the link came from `docker compose logs app`.
  3. Recreated the app container afterwards to clear the reset link from the log.
- Lessons: save every account in the password manager as it's created. And anyone with SSM access to the instance effectively has Snipe-IT admin access, so IAM permissions for SSM are part of the app's security.

### Private CA and the n8n client certificate (Task 4)
- Built on the PC in Git Bash (OpenSSL 3.5.7), in `~/snipeit-ca`, outside the repo.
- CA: RSA 4096, self-signed, `CN=SnipeIT Automation Private CA`, valid 2026-09-27 → 2031-09-26. It's trusted only by Caddy on `snipeit-api.jkdeleon.net`.
- n8n client cert: RSA 2048, `CN=n8n-cloud`, `CA:FALSE`, EKU `clientAuth` only, valid 2026-09-27 → **2027-09-27 (renewal reminder set)**. `openssl verify` → OK.
- The CA private key should live offline (password manager) and off the disk, since it's only needed to issue certificates, the same reason companies keep root CAs offline. **For now it stays in `~/snipeit-ca`** (outside the repo) until a password manager is set up; see open items.
- Gotcha: in Git Bash on Windows, `-subj "/CN=..."` gets rewritten into a Windows path unless prefixed with `MSYS_NO_PATHCONV=1`.
- `.gitignore` blocks `*.key`, `*.csr`, `*.srl` as a second safety net.

### Per-hostname access and mTLS (Task 5), in progress
- DNS `snipeit-api.jkdeleon.net → 67.202.58.185` added in Vercel. CA certificate placed at `/opt/snipeit/ca/n8n-ca.crt`; `ADMIN_IP` added to `.env`. The new Caddyfile and compose file are mirrored in `docs/gui-build/`.
- `caddy validate` passed; Caddy obtained a Let's Encrypt certificate for `snipeit-api` over port 80 while 443 was still restricted.
- Caddy logged `enabling strict SNI-Host enforcement because TLS client auth is configured`: it rejects requests whose `Host` header doesn't match the TLS server name, which blocks the trick of connecting on the UI hostname (no certificate needed) and asking for the API site.
- Results so far:

| Test | Result |
|---|---|
| No client certificate | refused: `tlsv13 alert certificate required (SSL alert number 116)` |
| Certificate from a different CA | refused at handshake (curl exit 35) |
| Server's requested CA (`openssl s_client`) | `CN=SnipeIT Automation Private CA` |
| Valid certificate, no token | `401 Unauthorized` |
| Valid certificate, non-API path (`/login`) | `404 Not Found` |
| UI from admin IP | `302` → login |
| Host-header trick (SNI `snipeit`, Host `snipeit-api`) | `421 Misdirected Request` |
| Valid certificate + token | `200 OK` (an earlier `400 Bad Request` was a malformed token value in the shell, not the server) |

- **Windows gotcha:** Git Bash's curl uses Schannel (the Windows TLS library), which silently doesn't send a client certificate issued by a private CA that Windows doesn't trust. Every mTLS test through curl looked like "no certificate". `openssl s_client` (OpenSSL) works. n8n runs on OpenSSL through Node.js, so it isn't affected.
- **Git Bash paste gotcha:** the Git Bash window (mintty) doesn't paste with Ctrl+V; use Shift+Insert or right-click → Paste. With a hidden `read -s` prompt, a failed paste is invisible, so print the token's length to confirm it arrived.

### n8n Cloud (Task 6)
- Instance `kyleautolab`, n8n 2.40.6. **Trial ends around 2026-10-12** (the editor showed "8 days left" on 2026-10-04; the account dashboard had shown "9 days left" on 2026-09-30, so the two counters differ, and the later one is used here); 1,000 executions/month on the trial. Export each workflow to `n8n/workflows/` as soon as it works.
- Credentials: Header Auth (`Authorization: Bearer <n8n-bot token>`) + SSL Certificates (client cert + key; CA left empty because the server uses Let's Encrypt). In the HTTP Request node, the **SSL Certificates** toggle is on the node's **Settings** tab, not Parameters; turning it on adds a "Credential for SSL Certificates" field under Parameters.
- **First call hung instead of failing:** 443 was still limited to my home IP, so the security group silently dropped n8n Cloud's packets. A dropped connection hangs until timeout; a refused one fails immediately. When something hangs, suspect a firewall. Fixed by opening 443 to `0.0.0.0/0` (Caddy already enforcing per-hostname rules).
- Six credentials, renamed so workflows and exports read clearly: `Snipe-IT n8n-bot token`, `Snipe-IT mTLS client`, `Documenso API` (raw token, no "Bearer"), `Documenso webhook secret` (Header Auth `X-Documenso-Secret`, a random value from `openssl rand -hex 32`; a copy is kept in `~/snipeit-ca`), `Google Drive`, `Gmail` (n8n Cloud's built-in Google sign-in, no Google Cloud project needed).
- **n8n Cloud → mTLS → Snipe-IT works:** `GET https://snipeit-api.jkdeleon.net/api/v1/hardware?limit=1` returned asset `00001`. The response's `available_actions` shows the token's least privilege: `update: true`, but `checkout`, `checkin` and `delete` all `false`.

### Workflow 1: capturing Snipe-IT's webhook (Task 7)
- Snipe-IT → Settings → Integrations → **General Webhook**, endpoint = the n8n Webhook node's **Test URL** while building (switch to the Production URL at the end).
- "Test to Save" only saves on a 2xx response, and n8n's test URL only returns 2xx while **Listen for test event** is active. The first attempt failed with a "returns a redirect" error that couldn't be reproduced afterwards (from the server, the container, or with Guzzle's user agent, the URL returned 404, not a redirect). It saved fine once n8n was listening.
- Requests reach n8n Cloud through Cloudflare and n8n's load balancer, with `cf-connecting-ip` = the Elastic IP and `user-agent: GuzzleHttp/7`.
- Real payloads saved in `n8n/samples/` (test message and checkout). The checkout payload matches the source-code analysis: `text` contains `Asset checked out`, `title_link` → `/hardware/1`, field `To` → `/users/2` (Alice), field `By` → `/users/1` (admin). The test message has no `attachments`, so the Parse event step ignores it.
- The checkout payload is **pinned** on the Webhook node, so later steps can be re-run without new checkouts.
- **Verify against Snipe-IT's activity log:** `GET /api/v1/reports/activity?item_type=asset&item_id=1&limit=1&order=desc&sort=created_at` (over mTLS) returns `{ total, rows: [...] }`. The latest entry was `id 13`, `action_type: "checkout"`, `target {id 2, type "user"}` (Alice), `created_by {id 1}` (the IT admin, who becomes the countersigner). Output: `externalId: "checkout:asset-1:log-13"`.
- **Spoof test passed:** edited the pinned webhook to claim the asset went to `/users/3`. Verify event produced no output and the run stopped. No document, email or error. Restored to `/users/2` afterwards.
- **Document #1 created (2026-10-04)** via `POST /api/v2/envelope/use`: `envelope_vsfahfteekncftwu`, external ID `checkout:asset-1:log-13`, recipients Alice (order 1) then the IT admin (order 2). The payload was reviewed field by field against `n8n/config.md` before the single run.
- **Pre-fill confirmed:** the document showed `00001 / Dell Latitude 5450 / TESTSERIAL001 / 2026-10-04` in place of the `(auto)` stand-ins. Name/Email fields stay as placeholders until the signer signs. The signing email reached the plus-address, but Gmail marked it "suspicious" (sent from the free plan's shared domain `free.documensomail.com`); in a company you'd send from your own domain with SPF/DKIM, so employees don't learn to ignore warnings on signing emails.
- `Note: sent` added "Agreement sent to Alice Tester…" to the asset's history (`POST /api/v1/notes/1/store` → `Note Added`).
- **Bug found by the duplicate test:** re-running stopped at Verify event, not Skip duplicates. The verification fetched the asset's *latest* activity, which was now our own "note added", so it no longer matched "checkout". It failed safely here, but in real use any note, upload or edit between the checkout and n8n's processing would make a genuine checkout look forged, and the agreement would silently never be sent. Fix: filter the activity query by `action_type` (`checkout` / `checkin from`), so verification checks the latest event *of that type*. The anti-spoofing check still holds. A check that's too strict also causes failures, just quieter ones.
- After the `action_type` fix, re-running stopped at **Skip duplicates** (it found `checkout:asset-1:log-13` in Documenso), so a repeated webhook can't create a second document.
- **Workflow 1 exported** to `n8n/workflows/01-send-for-signature.json` (12 nodes). Checked for secrets: credentials appear only as name + ID. **`pinData` was removed** before committing, because the pinned webhook's headers contained the n8n instance hostname, which together with the webhook path would give anyone the full webhook URL. Verification would reject fake events, but each would still use up an execution.
- **Workflow 2's webhook** (`02 Archive on completion`) uses Webhook-node **Header Auth** with the `Documenso webhook secret` credential. Documenso → Settings → Webhooks points at it with triggers `DOCUMENT_COMPLETED` + `DOCUMENT_REJECTED` and the same secret. Test: a forged `{"event":"DOCUMENT_COMPLETED"}` POST without the `X-Documenso-Secret` header got **`403`** and no execution was created. Unlike Snipe-IT's webhook, Documenso's can prove who sent it.
- **Workflow 3 (unsigned reminder) tested** on the still-pending document #1 with the threshold temporarily at 0 days: IT received "1 asset agreement(s) unsigned for 3+ days — Asset Assignment – 00001 – Alice Tester (sent 2026-10-04)". Threshold set back to 3. It only counts documents whose `externalId` matches the automation's pattern.
- **Signing order wasn't enforced:** the IT signer's link opened and was signable before the employee had signed. Passing `signingOrder: 1/2` in the API call only labels recipients; Documenso enforces the order only when the template has **"Enable signing order"** turned on. With parallel signing, IT also saw the asset fields blank, because fields belonging to another signer only show once that signer has completed. Fix: turn on "Enable signing order" in both templates (affects new documents only). Document #1 was signed in the right order by hand.
- **First real `DOCUMENT_COMPLETED` received** (document #1 signed by Alice, then IT): `event: DOCUMENT_COMPLETED`, `payload.externalId: checkout:asset-1:log-13`, `status: COMPLETED`. It arrived from Documenso's servers in Frankfurt (`cf-ipcountry: DE`, `user-agent: node`) and passed the secret check. Pinned in Workflow 2.
  - `payload.recipients` again listed IT before Alice, but each recipient includes `signingOrder`, so the employee is matched by `signingOrder === 1`.
  - `documentMeta.signingOrder: PARALLEL` confirmed the signing-order bug. `documentMeta.timezone` was `Etc/UTC`, but the signed PDF stamped the signing dates in the signer's local time (signed 10:05 UTC, PDF shows 06:05 PM at UTC+8), so no template timezone change is needed.
  - The signed PDF (`GET /envelope/item/{id}/download?version=signed`, 369 kB) contains every field: Name/Email filled by Documenso at signing, the four pre-filled asset fields, both signatures and both dates. Screenshot 29b.
  - **The webhook secret is stored in n8n's execution data:** the `x-documenso-secret` header is recorded in every execution and in pinned data (and it was pasted into a chat). A secret that travels in a header ends up in the receiver's logs. Plan: **rotate the secret** in Task 12, before switching to the Production URL.
- **Workflow 2 archive path:** `Get asset (tag)` → `File name` (re-attaches the PDF, because each HTTP node's output replaces its input) → `Upload to Snipe-IT` (`POST /hardware/1/files`, multipart `file[]` + `notes`; Snipe-IT stored it as `asset-1-<random>-<name>.pdf`, "Created By n8n-bot") → Drive folder lookup/create → upload → note.
  - Drive folder lookup uses Drive's query language (`name = '00001' and mimeType = 'application/vnd.google-apps.folder' and '<root>' in parents and trashed = false`) rather than name search, which matches partial names. The search node needs **Always Output Data** so "not found" continues to the create branch.
  - **Two Drive errors on the way:** (1) a leftover `ROOT-FOLDER-ID` placeholder in the query → "File not found". (2) "File not found: <root id>" when creating the subfolder: the root folder had been created in a **different Google account** from the one n8n's Google credential uses. Recreated it in `it-admin@example.com`.
  - **Timezones (to be aligned before go-live, see open items):** three clocks are involved. n8n Cloud runs on UTC (file-name dates and "Date Issued"), Documenso stamps signing times in the signer's browser timezone, and Snipe-IT uses `APP_TIMEZONE`. In testing, the laptop was on PH time (UTC+8) while the tester was in Qatar (UTC+3). In production you'd pick one business timezone and set it explicitly everywhere, e.g. `toLocaleDateString('en-CA', { timeZone: … })` in the Code nodes, ideally using the document's `completedAt` for archive file names so re-runs give the same name.
  - Tip: pin the output of nodes with side effects (uploads) while debugging later steps, so re-runs don't repeat them.
  - **Workflow 2's completed path works end to end (2026-10-05):** signed PDF downloaded → uploaded to asset `00001` in Snipe-IT → `Snipe-IT Agreements/00001/` in Drive → "archived" note on the asset. A second run took **Folder exists? → true** and reused the folder (no duplicate `00001` folder).
- **Document #2 (check-in), fully automatic in production (2026-10-05):** checking asset `00001` in from Alice in Snipe-IT triggered Workflow 1's production webhook. Run green through `Note: sent` in 5.8 s, with no manual listening. Verify event matched the `checkin from` activity entry, which confirmed Snipe-IT's action type name. The return form went to Alice only. **Signing order now enforced:** no IT invitation was sent until the employee signed (with document #1, both were invited at once).
- **Document #2 completed and archived automatically:** Alice signed ("Waiting for others to sign"), then IT ("Everyone has signed"). Workflow 2 production run #35 (7.3 s) reused the `00001` folder and archived `2026-10-04_checkin_alice-tester.pdf` to Snipe-IT and Drive. Asset `00001` now holds both the assignment agreement and the return form.
  - **Template bug found:** in the Return form, `condition_notes` was assigned to the **employee**, read-only, with the `(Auto)` stand-in, so IT couldn't fill it in and the archived form shows "(Auto)". **Fixed (2026-10-05):** reassigned to IT Administrator, Read Only off, stand-in text removed; checked in the template editor (blue = IT). It will be confirmed on the next real check-in.
  - "Date returned" showed `2026-10-04` for a check-in at ~04:00 local on 10-05 (UTC date), another case for the timezone-alignment item.
- **Document #3, rejection path, in production (2026-10-05):** checkout to Alice → Workflow 1 sent a new assignment → Alice rejected it ("Testing rejection path") → Workflow 2 run #37 (2.7 s) took the `rejected` branch: Rejection details → Email IT: rejected → Note: rejected. The completed path didn't run. **All three planned test documents used, and all three paths (checkout, check-in, rejection) tested with real documents.** Confirmed: IT email "Agreement rejected: …" naming who rejected and linking the asset (reason empty → "(no reason given)" fallback, since none was typed); rejection note on the asset; **asset still checked out to Alice**, so a rejection notifies without changing Snipe-IT.
- **Workflow 4 (error handler):** Error Trigger → Gmail (HTML) with workflow name, failed step, error message and a link to the failed run; set as the error workflow for Workflows 1–3. **Error workflows only fire for production runs, not manual ones**, so the test was a deliberate production failure in the harmless reminder workflow: its URL changed to `/envelope-broken` and the schedule to every minute, then published. The email arrived ("n8n workflow failed: 03 Unsigned reminder", failed step "Pending envelopes", "resource … could not be found"), and both changes were reverted. Gotchas: the first attempt didn't fail, because only the schedule change had been published, not the URL change; and a per-minute schedule uses up executions (trial limit 1,000/month).
- **The response contains live `signingUrl`s** (`/sign/<token>`). Whoever has a signer's link can sign as that person without logging in. They must not be screenshotted or committed, and because n8n stores each execution's data, they also sit in n8n's execution history. Limiting execution-data retention is part of securing the automation platform.
- n8n gotchas met here:
  - Code nodes must be in **Run Once for All Items** mode for `.first()` and `return []`.
  - `$('Node name')` finds nodes by exact, case-sensitive name, so rename nodes as you add them.
  - **Execute step** reuses the previous outputs of earlier nodes; **Execute workflow** re-runs everything from the trigger. Use the latter after editing pinned data.

### Small gotcha
- PowerShell `$env:` variables only last for that window. In a new window, API calls silently send an empty token and get `401` on everything.

## Self-hosted n8n build log

Goal: run the same four workflows on n8n self-hosted next to Snipe-IT, with every system on Asia/Qatar time, and compare the result with the n8n Cloud + mTLS version on measured evidence (setup effort, attack surface, operations, cost, fit with Terraform).

### Sizing baseline (2026-10-12)
- Fresh boot, before n8n: 308 MiB used of 1.9 GiB, 1.4 GiB available, no swap. `snipeit-app-1` 96.8 MiB, `snipeit-caddy-1` 13.3 MiB (screenshot 33). Decision: keep the t3.small and add swap.

### Swap file (Task 1, 2026-10-12)
- 2 GiB at `/swapfile`, made with `dd` (the root filesystem is XFS, where `dd` always gives a valid swap file), `chmod 600` (swap can hold any process's memory, including secrets), in `/etc/fstab`.
- `vm.swappiness=10` in `/etc/sysctl.d/99-swappiness.conf`: swap only under real memory pressure. Swap on gp3 writes at ~160 MB/s, far slower than RAM, so it's a cushion against spikes, not extra capacity.
- Verified after a reboot: `Swap: 2.0Gi`, `/swapfile` active, swappiness `10`, both containers back on their own (`Up 26 seconds`).

### Google OAuth app (Task 2, 2026-10-12)
- Google Cloud project `snipeit-automation` in the test account. Only the **Google Drive API** and **Gmail API** are enabled. No billing account is needed or linked: these APIs have quotas, not charges.
- Consent screen: External (Internal is only for Google Workspace organizations; External doesn't make the app public). Authorized domain `jkdeleon.net`.
- Web OAuth client `n8n self-hosted`, redirect URI `https://n8n.jkdeleon.net/rest/oauth2-credential/callback`. Google sends the authorization code only to a listed URI, so it must match exactly. Client ID and secret are stored in `~/snipeit-ca`, never in the repo.
- **Publishing deferred:** "Publish app" stays disabled until the Branding page has a home page and a privacy policy link on the authorized domain. Those will be real pages on `jkdeleon.net` (a project summary that doubles as the portfolio page, plus a privacy note). Until then, the app is in **Testing** with the test account added as a test user, and **n8n's Google logins expire after 7 days**. If a Drive or Gmail step fails, reconnect the credential first. After publishing, reconnect once more, because logins created during Testing keep the 7-day limit. Publishing is a precondition for the real-document test (plan Task 9 Step 0).

### n8n container, Caddy route, DNS, timezone (Task 3, 2026-10-12)
- DNS: Vercel A record `n8n` → `67.202.58.185`, added and resolving **before** Caddy knew the name. Caddy requests a certificate as soon as a hostname is in its config, and Let's Encrypt limits failed validations per hostname per hour.
- n8n **2.42.7**: the release GitHub marks "Latest" on 2026-10-12. The 2.43.x releases are n8n's beta track (marked pre-release). Image `docker.n8n.io/n8nio/n8n:2.42.7`.
- n8n settings live in `/opt/snipeit/n8n.env` (chmod 600), separate from Snipe-IT's `.env`, so the Snipe-IT container never sees n8n's encryption key. The key was generated on the server (`openssl rand -hex 32`), never printed in the build log, and copied once to `~/snipeit-ca/n8n-encryption.key` (65 bytes = 64 hex + newline).
- Backups before changes: `docker-compose.yml.bak-cloud`, `Caddyfile.bak-cloud`. The server config matched `docs/gui-build/` exactly. New config: `docs/gui-build/self-hosted/`. Both files were written whole with `tee` and a quoted heredoc (`<<'EOF'`, so `${ADMIN_IP}` isn't expanded by the shell), then validated with `docker compose config --quiet` and a throwaway `docker compose run --rm --no-deps caddy caddy validate` before anything restarted.
- Caddy for `n8n.jkdeleon.net`: two `handle` blocks. Caddy runs only the first matching one, so `/webhook/*` skips the IP check; `/webhook-test/*` doesn't match `/webhook/*` and stays admin-only.
- **Gotcha 1: `grep` without `sudo` on a `600` file.** The command `grep -q ... .env && sed ... || echo ... >> .env` couldn't read `.env` (`Permission denied`), so the "missing" branch appended a second `APP_TIMEZONE` line. Fixed by deleting the old line (one line left, permissions still `600`). Lesson: a failed check in an `a && b || c` chain looks the same as a false result.
- **The server was on `Asia/Manila`, not UTC.** The repo's `env.example` said `'UTC'`, so the repo had drifted from the server. Now `APP_TIMEZONE=Asia/Qatar` on both. Records created before the switch display 5 hours earlier than their real time (Manila is UTC+8, Qatar UTC+3), because Snipe-IT stores times without a timezone.
- **Gotcha 2: `docker compose up -d` didn't recreate Caddy.** Compose only recreates a container when its own settings change, and a new `depends_on` entry doesn't count. Caddy kept the old config in memory until `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`, which applies a new config without dropping connections and refuses an invalid one.
- Results: three containers up. n8n logs `Editor is now accessible via: https://n8n.jkdeleon.net`. Snipe-IT `APP_TIMEZONE` is `Asia/Qatar`. Let's Encrypt issued the certificate in ~3 s after validating from **five different IP addresses** (multi-perspective validation: an attacker who hijacks the route from one network can't get a certificate). The setup page loads over HTTPS from the admin IP.
- Like Snipe-IT's setup wizard, whoever reaches a fresh n8n first creates the owner account. The admin-IP rule covers exactly that window.
- **Upgrade item:** n8n 2.42.7 warns that internal task-runner mode (Code nodes run inside the main process) is deprecated in favor of a separate runner container, and that several defaults will shrink (task timeout 300 s → 60 s, decompression limits). Fine for this lab. Before any future upgrade, check that internal mode still exists, or budget memory for a runner container.

### Owner account and internal API (Task 4, in progress, 2026-10-12)
- Owner account created from the admin IP (marketing emails off, survey and license offer skipped).
- Credential `Snipe-IT n8n Token` (Header Auth, `Authorization: Bearer <n8n-bot token>`).
- **Test 1 passed:** `GET http://app/api/v1/hardware/1` from n8n returned asset `00001` on the first try. There was no HTTP→HTTPS redirect, so Snipe-IT nodes don't need an `X-Forwarded-Proto` header. Docker Compose's internal DNS resolves the service name `app` to the Snipe-IT container; the call never leaves the server.
- **Activity-log date shape** (for Task 7): `rows[0].created_at` is `{ "datetime": "YYYY-MM-DD HH:MM:SS", "formatted": "..." }`, in Snipe-IT's `APP_TIMEZONE`. Rows also carry `action_date` in the same shape.
- **The audit trail records the caller's IP:** entries made by n8n Cloud show `remote_ip: 4.184.78.244`, `user_agent: n8n`. Entries from self-hosted n8n should show an internal Docker address (172.x). Compare once document #4 runs.
- **Timezone shift visible:** asset `00001`'s `last_checkout` reads `2026-10-05 04:10:49`. It was saved under Asia/Manila, so the real moment was 23:10 on Oct 4 in Qatar time. Snipe-IT stores bare clock times, so it now shows the same digits under the new timezone.
- **Review Focus 2 passed:** after `docker compose up -d --force-recreate n8n` (new container, created about a minute earlier), the `Snipe-IT n8n Token` credential still decrypted and the call returned the same result. The key comes from `n8n.env`, not from a file n8n generates inside the container, so recreates and upgrades keep the credentials readable.
- **Documenso from self-hosted n8n (2026-10-14):** credential `Documenso API` (raw token). The envelope list returned the 3 documents: #1 `envelope_vsfahfteekncftwu` COMPLETED (`checkout:asset-1:log-13`), #2 `envelope_mxnduchozbdtfudc` COMPLETED (`checkin:asset-1:log-22`), #3 `envelope_bdyichodzllrfcbc` REJECTED (`checkout:asset-1:log-26`). Envelopes carry `completedAt` in UTC ISO format (set on rejection too), which supports the WF2 date fix. The list response also includes each recipient's signing `token`, so raw API output must never be committed.
- **Review Focus 5, lockout drill passed:** `ADMIN_IP` set to `203.0.113.1/32` (a documentation-only address) → `403` from the PC; restored from the `cp -p` backup → `200`. Recovery if the home IP changes: SSM in (it doesn't depend on the IP), update `ADMIN_IP` in `/opt/snipeit/.env`, `docker compose up -d caddy` (the variable is read when the container is created).
- **Tests 2a/2b from a phone on mobile data passed:** `/` → `Forbidden`, `/rest/settings` → `Forbidden`, `/webhook-test/anything` → `Forbidden`, `/webhook/does-not-exist` → n8n's own `404` "webhook … is not registered" (screenshots 37, 37b). Only `/webhook/*` reaches n8n from outside.
- Task 4 complete.

### Google credentials in n8n (Task 5, 2026-10-13)
- `Google Drive account` and `Gmail account`: Google OAuth2 credentials using the own OAuth client. n8n showed the expected redirect URL. Sign-in went through Google's "unverified app" warning once (screenshot 38, email blurred).
- Drive: searching inside the archive root folder returned the `00001` folder (right account, right folder). Gmail: a test message from "IT Asset Automation" arrived in the IT inbox.
- **Task 6 mistake: the n8n Cloud files were imported instead of the self-hosted ones.** Test 3 caught it. `Get asset` still called `https://snipeit-api.jkdeleon.net/...`, and n8n had auto-filled the wrong credential (`Documenso API` on a Snipe-IT node) because the credential IDs in the Cloud exports didn't exist on the new instance. The Documenso token was never sent: Caddy refused the TLS handshake (`alert certificate required`) before any HTTP request. That's live proof the mTLS gate still works. Lessons: check the source folder in the file picker, and check each credential **by name**, not just whether the field is red.
- The same run showed the WF1 timezone edit working: `eventDate: 2026-10-13` for a log entry stamped 00:15 Qatar (21:15 UTC the day before). The edits were then added to `n8n/workflows-self-hosted/01-send-for-signature.json`, so the re-import keeps them.
- **Resume here (next session):** in n8n, delete the wrongly imported `01`/`02`/`03` (keep `04`, already published, identical in both folders). Re-import 01–03 from `n8n/workflows-self-hosted/`. Check every credential by name, set the error workflow to `04 Error handler`, and restore the real IT inbox (WF2 `Rejection details`, WF3 Gmail To). Check `Get asset` reads `http://app/...`. Redo the Test 3 pins and run `Build envelope payload` → expect `2026-10-13` and `"timezone":"Asia/Qatar"` in `payloadJson`. Then Task 7 Steps 4–7 (WF2 `Parse externalId`, WF3 `Overdue`).
- **Session 4 (2026-10-14):** the wrong imports were deleted and 01–03 re-imported from `n8n/workflows-self-hosted/`, with every credential checked by name, the error workflow set to `04 Error handler`, and the real IT inbox restored. Timezone code edits made in the editor: WF2 `Parse externalId` (date from `completedAt`, converted to Asia/Qatar), WF3 `Overdue` (sent dates in Asia/Qatar).
- **Test 3 passed (Task 7):** WF1 pinned with a checkout log entry at `2026-10-13 00:15:00` (Qatar). Every node up to `Build envelope payload` was green, including the real `Get asset`/`Get user`/`Get admin` calls to `http://app`, and `payloadJson` carried the date `2026-10-13` and `"timezone":"Asia/Qatar"`. WF2 `Parse externalId` with `completedAt: 2026-10-12T21:30:00Z` gave `2026-10-13`; without `completedAt`, today's Qatar date (fallback). All pins removed afterwards.
- **Webhooks re-pointed and published (Task 8, 2026-10-14):** new Documenso webhook secret (`openssl rand -hex 32`; Git Bash's openssl on Windows wrote a CRLF line ending, so the file was 66 bytes and `$(cat …)` would have kept a stray `\r`; stripped to exactly 64 bytes). Credential `Documenso webhook secret` (Header Auth `X-Documenso-Secret`) on WF2's Webhook node. WF1–WF3 published. The webhook paths are unchanged from n8n Cloud (they're stored in the workflow files); only the hostname moved to `n8n.jkdeleon.net`.
- Documenso's existing webhook was edited (not duplicated, which would deliver every event twice) to the new URL and secret. Its **Test** button sent a sample `document.completed`: `200`, WF2 production run `Webhook → Event type (completed) → Parse externalId` → stopped (no `externalId` in our format). Headers showed `via: 1.1 Caddy`. n8n's run history keeps webhook headers, including the secret; it's pruned after 14 days.
- Snipe-IT: locked out of the admin account again. Recovered with the same reset-link-from-the-log method, but this time the username came from self-hosted n8n (`GET http://app/api/v1/users/1` with the bot token) instead of a SQL query. The reset email is quoted-printable encoded, so the link is split across lines (`=` at line ends, `=` written as `=3D`). The container was recreated afterwards to drop the link from the log. The integration was set back to **General Webhook** (it showed Slack; both send the same Slack-style payload). The test passed: "Your General Webhook Integration works!".
- **Test 2c passed:** WF2 webhook without the secret → `403`, with a wrong secret → `403` (refused by n8n's Header Auth before the workflow starts).
- **Test 2d passed:** forged Snipe-IT checkout (asset 1 to user 999) → `200` (Snipe-IT webhooks can't carry a secret, so n8n accepts anyone's request), and the run stopped at `Verify event`, because Snipe-IT's own activity log disagreed. No document was created.
- **Review Focus 1 (n8n down) observed:** with `docker compose stop n8n`, Snipe-IT's "Test General integration" showed an error, and Save turned into "Test to Save" (screenshot 42). The message was a raw translation key (`admin/settings/message.webhook.error_server`), another pre-release string bug. A *real* checkout sends its webhook in the background, with no message and no retry, so **a checkout made while n8n is down silently gets no agreement**. WF3 doesn't catch it, because it only sees documents that were sent. Possible fixes: a daily reconciliation (Snipe-IT checkouts vs Documenso `externalId`s) plus health monitoring of n8n. After `docker compose start n8n`, the test passed again and the settings were saved. Task 8 complete.
- **Document #4, the real end-to-end test (Task 9, 2026-10-14):** new asset `00002` (serial `TEST-0002`) checked out to Alice. Using a new asset avoided a check-in of `00001`, which would have used the spare document. The WF1 production run was green through `Note: sent` (screenshot 43). Duplicate test: the same Snipe-IT body re-sent with curl → stopped at `Skip duplicates`; still one document. The first attempt stopped at `Parse event` because the copied JSON included n8n's `[{"headers":…,"body":…}]` wrapper; re-sending needs only the `body`. The webhook headers showed `x-forwarded-for: 67.202.58.185` (the server's own Elastic IP: Snipe-IT → public URL → Caddy → n8n) and `user-agent: GuzzleHttp/7`.
- Signed by Alice, then IT (05:15 PM). WF2 archived it within a minute: Snipe-IT `00002` Files has the PDF, uploaded by `n8n-bot` at 05:16 PM; the Drive folder `00002` was created with `2026-10-14_checkout_alice-tester.pdf` (screenshots 44, 45). **The timezone fix holds everywhere:** Date Issued `2026-10-14` (from Snipe-IT's log), signing times `2026-10-14 05:15 PM` Qatar (not the signer's browser time), the file name dated in Qatar time, and Snipe-IT's asset and file timestamps on the same clock.
- **Audit trail:** the `n8n-bot` activity entries for `00002` show `remote_ip: 172.18.0.3` (n8n's container on the Docker network), versus `4.184.78.244` (n8n Cloud's shared public IP) for the Cloud-era entries. The API calls never leave the server.
- **Memory after (Test 7, screenshot 34):** 831 MiB used of 1.9 GiB, 866 MiB available, **swap 0 used**. n8n 419 MiB (more than the 200–300 MiB estimate: it includes the built-in JavaScript task runner), Snipe-IT 188 MiB (up from 97 MiB idle after a boot), Caddy 23 MiB. The t3.small fits with ~45% headroom, and swap hasn't been touched.
- **Skipped (user decision):** the manual WF3 run with `DAYS = 0`. The WF3 date line edited for Qatar time hasn't run on self-hosted yet; if it ever errored, WF4 would email IT.
- **Check-in path (Task 10, Test 5a):** WF1 pinned with a check-in message, and `Recent envelopes` pinned to an empty list (otherwise `Skip duplicates` rightly stops it, because document #2 exists). The real activity log gave `logId 22` → `externalId checkin:asset-1:log-22` (exactly document #2's), the return-form template `envelope_vebezsuleweowkaf`, the title "Asset Return – 00001 – Alice Tester", Alice as the employee (from the log, since check-in messages don't name the user) and `eventDate 2026-10-05`. That check-in was recorded under Asia/Manila (Oct 5 03:59), so the real Qatar time is Oct 4 22:59: the pre-switch shift.
- **Rejection replay (Test 5b):** a `DOCUMENT_REJECTED` event built from document #3's data, sent with the real secret → `200`, the rejected path, the IT email and a note on `00001`, with the checkout unchanged. The first attempt failed at `Email IT: rejected` ("email address '' … isn't valid") because the replay file's `<…>` placeholders hadn't been replaced; n8n's Gmail node reads `Name <address>` syntax, so `<your IT email>` became an empty address. Bad test data, not a workflow bug.
- **Error handler proven by a real failure (Test 6b):** that failed production run triggered WF4, which emailed IT naming the workflow and the failing node. That's better evidence than a staged failure, so the planned forced-failure test was skipped. Task 10 complete.
- n8n's Google credential form also offers "Allowed HTTP Request Domains" (default All) and "Custom Scopes". Both are possible hardening steps: limit the token to Google API domains, and request narrower scopes.
- **Earlier resume point (done):** Task 4 Step 6, the `Documenso API` credential (raw token, no `Bearer`) and `GET https://app.documenso.com/api/v2/envelope?type=DOCUMENT&perPage=10` → note the envelope IDs and statuses of #2 (COMPLETED, check-in) and #3 (REJECTED). Then Step 7 (admin-IP lockout drill), Step 8 (phone tests 2a/2b), Step 9 (log).

### Google app published (2026-10-14)
- Built the two pages Google requires on the authorized domain, in the portfolio site repo (`website-portfolio`, PR #7): `https://jkdeleon.net/projects/snipeit-automation` (project page, also listed in the portfolio's projects) and `https://jkdeleon.net/projects/snipeit-automation/privacy` (what Drive and Gmail data the app uses, Limited Use statement, how to remove access, contact).
- Branding updated with both links, then **Publish app → In production** (unverified). It was done **before** connecting Drive and Gmail in n8n, so no login was ever issued under Testing: the 7-day expiry never applies and there's nothing to reconnect (plan Task 9 Step 0 is already satisfied).

### Time log
| Session | Date | Tasks | Minutes |
|---|---|---|---|
| 1 | 2026-10-12 | Design decisions, spec, plan | not measured (no timestamps) |
| 1 | 2026-10-12 | Task 1 (swap, including a reboot test) | ~10 |
| 1 | 2026-10-12 | Task 2 (Google OAuth app, publishing deferred) | ~20 |
| 2 | 2026-10-12 | Task 3 (DNS, n8n container, Caddy, timezone) | ~15 |
| 2 | 2026-10-12 | Task 4 Steps 1–5 (owner account, Snipe-IT credential, internal API, recreate test) | ~20 |

| 3 | 2026-10-13 (Qatar) | 18:35–19:29 UTC (21:35–22:29 Qatar): RDS/EC2 start, Google app site pages (portfolio PR #7) and publish, Task 4 Steps 6–8, Task 5, Task 6 (imported the Cloud files by mistake, see below), Task 7 Steps 1–2 | 54 |
| 4 | 2026-10-14 (Qatar) | Started 13:08 UTC (16:08 Qatar): re-import 01–03, Task 7 edits and Test 3 | in progress |

From session 3 on, times come from the conversation's own message timestamps (UTC), so they're exact.

Build minutes for sessions 1–2 are estimated from timestamps in the server output (all UTC):
- **Reboot ≈ 09:10.** Caddy showed `Up 34 minutes` at the `docker compose up -d` run, and that run came right after the 09:41:44 Caddy validate.
- **n8n's certificate was issued at 09:45:47**, ending Task 3.
- **The force-recreated n8n container was "about a minute" old** near the end of Task 4.

The edges of each session (the start of Task 1, the end of Task 4) are rough.

## Instance setup log (draft of the Terraform user-data script)

Commands run by hand on `snipeit-app` over SSM, in order. In the Terraform phase these become the EC2 user-data script (user-data runs as root, so `sudo` won't be needed there).

```bash
# Database client (only needed for manual testing; probably not part of user-data)
sudo dnf install -y mariadb105

# Align the database collation with Snipe-IT's Laravel config (one-time, while the DB is empty)
mysql -h <rds-endpoint> -u snipeit_admin -p --ssl \
  -e "ALTER DATABASE snipeit CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Docker Engine: start now and on every boot
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo docker run --rm hello-world

# Docker Compose plugin (not packaged for Amazon Linux 2023)
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
sudo docker compose version   # printed v5.5.1

# Swap (added for self-hosted n8n): 2 GiB, used only under memory pressure
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
```

- **Pin the Snipe-IT image in Terraform:** `snipe/snipe-it:latest` turned out to be a pre-release development build (the footer showed `v8.8.0-pre – build 25083 (master)`). Set `APP_VERSION` to a stable release tag instead. Moving from a pre-release to an older stable version can be risky, because a database migrated by the newer pre-release may not work with it. The pre-release also had a visible bug: in a dark-mode browser, the setup wizard showed white text on a light background (its CSS picks colors with `light-dark()`, but the setup page hard-codes a light background). Workaround: switch the browser to light mode during setup.
- **Setup wizard, "Email my credentials":** leave it unchecked. With `MAIL_MAILER=log`, the email (including the admin password) is written to the container log in plain text.
- **Pin Compose in user-data:** use `.../releases/download/v5.5.1/docker-compose-linux-x86_64` instead of `latest`, so a rebuild months later installs the same version.
- RDS created the `snipeit` database as `utf8mb4` with MariaDB 11's default collation `utf8mb4_uca1400_ai_ci`. It was aligned to `utf8mb4_unicode_ci` to match the tables Snipe-IT creates and avoid "Illegal mix of collations" errors. In Terraform this could be handled by the setup script, since `aws_db_instance` can't set the collation.

## Decisions made during the GUI build

- **VPC created with the "VPC and more" wizard** instead of building each piece by hand. The wizard's result log maps almost 1:1 to Terraform resources (`aws_vpc`, `aws_subnet`, `aws_internet_gateway`, `aws_route_table`, associations).
- **What makes a subnet public:** its route table has `0.0.0.0/0 → Internet Gateway`. There's no "public" flag on the subnet itself.
- **The wizard made two private route tables** (one per AZ, in case a NAT gateway is added in each AZ later). With no NAT, they're identical, so Terraform can use one shared private route table.
- **No NAT gateway:** about $32/month, and nothing in the private subnets needs outbound internet.
- **EC2 security group:** inbound 80 and 443 from anywhere. Port 80 is for Caddy's HTTP→HTTPS redirect and the Let's Encrypt domain check. No port 22, because SSM needs no inbound rule (the agent connects outbound).
- **EC2 security group, final version:** after setup, 443 stays restricted to my IP (n8n Cloud's IPs get added in sub-project 2), and only 80 is open to everyone. Reasoning: the only clients Snipe-IT ever needs are me, n8n Cloud, and Let's Encrypt for renewals. Port 80 only serves the certificate check and redirects to HTTPS, which is blocked for everyone else. Rule descriptions are filled in so each rule explains itself. (Screenshot 03b, with my IP blurred.)
- **RDS security group:** inbound 3306 with the EC2 security group as the source, not an IP range. The rule follows the instance through rebuilds, and only instances with that group attached can reach the database.
- **RDS public access: No.** It's defense in depth on top of the private subnets.

## Pausing and resuming the GUI build

- **Pause:** stop EC2 first, then RDS ("Stop temporarily"), so Snipe-IT isn't running with its database gone.
- **Resume:** start RDS first and wait for *Available*, then start EC2. Docker is enabled at boot and the containers use `restart: unless-stopped`, so the stack should come back without any manual steps. This is a free test of that design.
- **Tested 2026-09-27:** started RDS, then EC2, touched nothing on the server. About 2 minutes later `https://snipeit.jkdeleon.net` returned `302 → /login` and port 80 returned `308` to HTTPS, with a valid certificate. Docker-at-boot, `restart: unless-stopped` and the persisted `caddy_data` volume all worked.
- **While stopped, these still cost money:** EBS (16 GiB), RDS storage (20 GiB), and the Elastic IP (all public IPv4 addresses are billed, attached or not). Roughly $7/month instead of ~$35/month running.
- **RDS restarts itself after 7 days** of being stopped. Stop it again if the pause runs longer.
- **Don't release the Elastic IP while the Vercel A record points at it.** A released address can be reassigned to another AWS customer, leaving `snipeit.jkdeleon.net` pointing at their server (a dangling DNS record, which can lead to subdomain takeover). Delete the DNS record whenever the IP is released.

## Publishing hygiene

- The real test email address was replaced in all text files and exported workflows with the placeholder `it-admin@example.com` (plus-addresses as `it-admin+<name>@example.com`). `example.com` is reserved for documentation, so it can't belong to anyone. Re-importing a workflow means setting the real IT inbox again (Workflow 2's rejection fallback, Workflows 3 and 4's "To" field).
- Screenshots showing the address (`26`, `29a`, `29b`, `30c`, `31`) were pixelated over just the address.
- **Published with fresh history (2026-10-13):** https://github.com/jkdleon/snipeit-n8n-automation (public). `main` was replaced by a single starting commit with the current, clean files. The full earlier history (which still contains the original address and unblurred images) is kept in the local-only branch `private-history`, set to push to a non-existent remote (`branch.private-history.pushRemote=no-push`) so it can't be pushed by accident.
- Commits in this repo use the GitHub no-reply address as author email (repo-local `git config user.email`), so no personal email appears in public commit data.
- Before each push: `git grep -I gmail.com` returns nothing, and new screenshots are reviewed.

## Open items

- [x] S3 gateway endpoint: **kept.** Gateway endpoints are free. Nothing uses it yet: it's attached only to the private route tables, and the EC2 instance sits in a public subnet. If Snipe-IT backups or signed documents go to S3 later, associate it with the public route table too, so that traffic stays on the AWS network. Terraform will include it to match the validated build.
- [x] ~~Create the `snipeit` database from EC2~~: no longer needed, since the recreated RDS instance sets the initial database name.
- [ ] Recreate RDS with a micro class, gp3 20 GiB and initial database name `snipeit`, then retake screenshot 06.
- [x] AWS Budgets: set up a **zero-spend budget** (alerts once real charges appear). Since the account runs on credits, also check Billing → Credits now and then to see how fast credits are being used, because a zero-spend alert won't catch that.
- [x] Switched to production early (2026-10-05), to run documents #2 and #3 without 2-minute listening windows: Workflows 1–3 published; Snipe-IT's webhook and Documenso's webhook point at the Production URLs; Documenso webhook secret rotated (new value in the n8n credential and Documenso; the old value had leaked into a chat). Verified: Workflow 2's production URL returns `403` with the **old** secret and with no secret.
- [x] Emails readable: rejection and reminder emails switched to HTML (`<br>` line breaks; the reminder converts the Overdue list with `lines.split('\n').join('<br>')`) and sender name "Asset Automation". All four workflows published.
- [x] ~~Limit n8n execution data~~: **left at defaults on purpose (lab decision)**, because the n8n instance is deleted at the end of the project. In production: for Workflows 1–2, don't save successful or manual executions, keep failed ones (needed for debugging; the error email links to them), and delete history that holds old secrets. The real audit trail lives in Snipe-IT notes/files, Documenso's audit log and the archived PDFs, not in n8n's execution history.
- [x] Documenso templates: "Enable signing order" turned on in both templates (2026-10-05); verify on document #2 that `documentMeta.signingOrder` is `SEQUENTIAL` and IT is only invited after the employee signs.
- [ ] **Timezone alignment before go-live** (audit-trail consistency): choose one business timezone (Asia/Qatar or Asia/Manila), then set it in Snipe-IT `APP_TIMEZONE`, each n8n workflow's Settings → Timezone and the Code-node dates, Documenso via `override.timezone` on document creation (and check the signing stamps follow it), and base archive file names on the document's `completedAt` in that timezone.
- [ ] After the n8n Cloud version works end to end: rebuild with **self-hosted n8n** and compare the two deployments (setup effort, attack surface, operations, cost, reproducibility). See the spec's "Follow-up: deployment comparison". Decide from that which version Terraform codifies.
- [ ] Set up a password manager (e.g. Bitwarden or KeePassXC) and move in: RDS password, Snipe-IT admin and `n8n-bot` logins, API tokens, `APP_KEY`, Documenso webhook secret, and the CA files (`ca.key`, `ca.crt`, `n8n-client.*`). Only then delete `ca.key` from `~/snipeit-ca`.
- [ ] Before teardown: screenshot Cost Explorer showing the project's total actual cost (case-study closer).
