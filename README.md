# shop-launcher

Takes a shop live without anyone typing a key. One workflow, `launch.yml`,
finds or creates everything a shop needs and passes the secrets it makes
straight from one API to the next, inside the job:

| Resource | Found by | Made with |
|---|---|---|
| Supabase project `shop-<slug>` | name, in the org `SUPABASE_ORG_ID` | Management API `POST /v1/projects` |
| The shop's migrations | Supabase's own migration history | `POST /v1/projects/{ref}/database/migrations` |
| Resend key `shop-<slug>` | name | `POST /api-keys`, `permission: sending_access` |
| Stripe webhook | URL `<siteUrl>/api/stripe/webhook` plus `metadata[shop]` | `POST /v1/webhook_endpoints`, two events: `checkout.session.completed`, `checkout.session.async_payment_succeeded` |
| Worker secrets | names Cloudflare lists (it never shows values) | `wrangler deploy --secrets-file` |

This repository is public and holds code only. Each shop is one file in
`shops/` (`shops/orb.json`): its slug, repo, Worker name and public URL.

## Storage: Supabase or D1

`"storage"` in `shops/<slug>.json` says where the shop keeps its orders, as
`SHOP.storage` does in the shop's own `config/shop.ts`. Leave it out for
`"supabase"` (the orb shop). Supabase's free plan allows two projects and
both are used, so shop three onward is `"d1"`:

| Resource | Found by | Made with |
|---|---|---|
| D1 database `<slug>-orders` | name, in `CLOUDFLARE_ACCOUNT_ID` | `POST /accounts/{id}/d1/database` |
| Its tables | wrangler's own migration table | `wrangler d1 migrations apply DB --remote`, from the shop's `d1/migrations/`, before the first deploy |

A D1 shop has no database key: only its Worker reaches the database, through
the `DB` binding `npm run shop:sync` writes into the shop's `wrangler.jsonc`.
So it needs no `SUPABASE_ACCESS_TOKEN` or `SUPABASE_ORG_ID`, and its Worker
gets no `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`. Before
anything else the launcher checks that `wrangler.jsonc` binds `DB` to
`<slug>-orders` (and to that database's id, if it names one); otherwise
wrangler would migrate and bind another database, so plan and apply stop
there. `CLOUDFLARE_API_TOKEN` needs **Account > D1 > Edit** as well as its
Workers permissions; without it plan names that permission.

Plan sends GET calls only, and which migrations a database already has is a
read Cloudflare takes only as a POST. So for an existing database plan says
`update` ("wrangler applies whatever is missing"), and apply says `skip` when
wrangler had nothing to apply. The smoke reads and marks the order row
through D1's query API with the same token.

## Running it

Actions > launch > Run workflow, with a shop slug and a mode. The store's
dispatch op (piece 5) will do the same thing.

- **plan**: GET calls only. Prints `create`, `skip`, `rotate` or `update` for
  every resource, which Worker secrets would be set, token expiry warnings
  (14 days ahead), and any missing Supabase permission by name.
- **apply**: does what plan printed. Run it twice and the second run is all
  `skip` with zero write calls.
- **smoke**: records the live Worker version and the commit `/api/version`
  reports, deploys the shop's `main`, then runs seven checks on Stripe test
  keys: (1) `/`, `/shop/<product>`, `/start`, `/returns` answer 200 and
  `/api/version` equals main; (2) Playwright pays on Stripe's test Checkout
  with 4242 4242 4242 4242 as `delivered@resend.dev` (Resend's test inbox, no
  person); (3) Stripe's event for that session has `pending_webhooks` 0 (every
  endpoint answered 2xx), cross-checked by the shop's order row; (4) one
  session in `orders`; (5) `alert_email_at` set and Resend holds the "New
  order" email linking to that order; (6) the Add tracking link opens and
  saves `LP00123456789CN`, `shipped_email_at` set; (7) Stripe refunds the
  payment and the row becomes `refunded` with `supplier_order_ref` "test:
  shop-launcher smoke <run>". On any fail it runs `wrangler rollback <recorded
  id>` and checks `/api/version` is the earlier commit; a paid test is still
  refunded. Only after a green smoke are old Resend keys and Stripe webhooks
  (all but the newest) deleted. The job page shows one line per check.
- **live**, **rollback**: refused with a message. They are piece 3.

The smoke needs the shop's Stripe test key to allow, beyond piece 1's list:
Checkout Sessions read, Events read, Refunds write. It reads the orders table
through the shop's own database API with the service key (revealed as in
apply), or for a D1 shop through D1's query API, and Resend's sent emails
with `RESEND_ADMIN_KEY`.

`rotate` means a secret that cannot be read back (a Stripe webhook secret,
a Resend key) is missing from the Worker. apply makes a new one and puts it
on the Worker; the old one stays until a green smoke (apply runs the smoke
itself when started with `--browser`). If the deploy fails, apply
deletes what it just made, so a failed run leaves the accounts as they were.

The job runs on the laptop runner (`[self-hosted, shop-launcher]`). A launch
sent while the laptop is off waits in the queue and starts when Elijah logs
in; that is a wait, not a failure. `concurrency: launch-<shop>` with
`cancel-in-progress: false` keeps it to one launch per shop and never
cancels a queued one. GitHub drops a job that waits more than 24 hours.

## What Elijah sets up (later, not in this pull request)

- Environment `provision`, deployment branches `main` only, with secrets
  `SUPABASE_ACCESS_TOKEN`, `RESEND_ADMIN_KEY`, `CLOUDFLARE_API_TOKEN`,
  `GH_PROVISION_TOKEN` and one `STRIPE_RK_TEST__<SLUG>` per shop.
- Variables `SUPABASE_ORG_ID`, `CLOUDFLARE_ACCOUNT_ID`, and optionally
  `SUPABASE_ACCESS_TOKEN_EXPIRES_ON` and `RESEND_ADMIN_KEY_EXPIRES_ON` (ISO
  dates) so plan can warn before those tokens expire. Cloudflare's expiry is
  read from Cloudflare itself.
- The runner, label `shop-launcher`: one command, below.
- Settings > Actions > General: "Require approval for all external
  contributors".

## Add the runner (once, on the laptop)

Every job here runs on `[self-hosted, shop-launcher]`, so nothing runs until
this runner exists.

1. Merge pull request #5 (it lets the script bring its own Node). The line
   below downloads the script from main and checks it is the new one, so it
   stops with one STOP line if you paste it before the merge.
2. Open Windows PowerShell on the laptop and paste this one line:

```powershell
gh api -X POST repos/cyberpsilosis/shop-launcher/actions/runners/registration-token --jq .token | wsl -u root -- bash -c 'curl -fsLo /root/add-launcher-runner.sh https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/scripts/add-launcher-runner.sh || { curl -fsLo /dev/null https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/README.md && echo STOP: scripts/add-launcher-runner.sh is not on main yet - merge pull request \#5, then paste this again. Nothing changed. || echo STOP: the laptop cannot reach raw.githubusercontent.com - check it is online, then paste this again. Nothing changed.; exit 1; } && { grep -q SCRIPT_REV=3 /root/add-launcher-runner.sh || { rm -f /root/add-launcher-runner.sh; echo STOP: main still has the older runner script - merge pull request \#5 and wait five minutes, then paste this again. Nothing changed.; exit 1; }; } && bash /root/add-launcher-runner.sh'
```

It asks you nothing. `gh` makes a registration token (valid one hour) and
pipes it straight into the script, so the token is never shown, copied or
saved. `wsl -u root` runs the script as root without a password prompt. It
takes one to two minutes, most of it the Node and runner downloads. The
first run can take up to half a minute more while it looks for other
runners on the Linux disk.

Node does not need to be installed. The script downloads Node v24.21.0 from
nodejs.org into `/home/ci-shop-launcher/node`, checks it against the SHA-256
written in the script, and points only this runner at it. Root's PATH, nvm
and the other runners' Node are not used or changed. It needs no `jq`.

Every way it can end:

- `Done: runner laptop-shop-launcher (label shop-launcher) runs as
  ci-shop-launcher.` The runner shows as Idle under Settings > Actions >
  Runners, and the queued `test` runs start.
- `STOP: main still has the older runner script - merge pull request #5 and
  wait five minutes, then paste this again. Nothing changed.` Step 1 was
  skipped, or GitHub still serves the old copy (it caches for up to five
  minutes after a merge).
- `STOP: scripts/add-launcher-runner.sh is not on main yet - ...`: the same
  fix, merge #5.
- `STOP: the laptop cannot reach raw.githubusercontent.com - check it is
  online, then paste this again. Nothing changed.`
- `STOP: WSL is missing curl, sudo; nothing changed. To fix it, paste this one
  line in PowerShell, then paste the setup line again:` and under it the line,
  for example `wsl -u root -- sh -c "apt-get update && apt-get install -y curl
  sudo"`. It names every missing tool at once, so one fix covers them all.
- `STOP: systemd is not running in WSL, ...` and under it the fix line, which
  switches systemd on in `/etc/wsl.conf` and restarts WSL:
  `wsl -u root -- sh -c "printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf"; wsl --shutdown`.
  If `/etc/wsl.conf` already switches it on, the line is only `wsl --shutdown`.
  Restarting WSL also restarts the laptop's other runners.
- `STOP: no registration token came in from gh - ...` or `STOP: what came in
  from gh is not a runner registration token - ...`: run `gh auth status` in
  PowerShell; the account must be admin on this repository.
- Any other `STOP: ...` line says what failed, what it changed so far
  (`nothing changed`, or the one command that undoes it) and what to do next.
  Send that line to the agent.

What the script does (`scripts/add-launcher-runner.sh`):

- Checks every tool it needs (curl, tar, gzip, sha256sum, systemctl, sudo and
  the basic ones) and that systemd runs WSL, before it changes anything.
- Stops with `STOP: ...; nothing changed` if the `ci-shop-launcher` user or
  its home exists, if a shop-launcher runner service is installed, or if a
  runner already registered to this repository is anywhere on the Linux disk
  or in the folder of any installed runner service. The repository address
  matches with or without a trailing `/` or `.git`. It only reads those
  files. It never uses `--replace`, so it cannot take over another runner.
  It walks the whole Linux disk, not the Windows drives under `/mnt`.
- Makes user `ci-shop-launcher`: its own group only, no password, no sudo,
  home mode 750. The other runners' users cannot read its folder.
- Puts Node v24.21.0 (with npm) in `/home/ci-shop-launcher/node`, owned by
  root, after its pinned SHA-256 matches.
- Downloads GitHub's runner, checks its published SHA-256, and puts it in
  `/home/ci-shop-launcher/actions-runner`.
- Registers it as `laptop-shop-launcher`, label `shop-launcher`, writes the
  runner's `.path` with that Node first, checks that `ci-shop-launcher` finds
  it, and starts the runner as a systemd service running as that user. The
  token goes to GitHub's `config.sh` through its environment
  (`ACTIONS_RUNNER_INPUT_TOKEN`), never on a command line, so `ps` cannot
  show it to another user.

To try it on a scratch machine without registering anything:
`sudo LAUNCHER_RUNNER_NO_REGISTER=1 bash scripts/add-launcher-runner.sh`. It
makes the user and the empty runner folder and stops.

To undo: in `/home/ci-shop-launcher/actions-runner` run `sudo ./svc.sh stop`
and `sudo ./svc.sh uninstall`, delete the runner under Settings > Actions >
Runners, then `sudo userdel -r ci-shop-launcher` (that removes its Node too).

## Can a stranger reach the laptop?

The risk: a public repo with a self-hosted runner. GitHub warns that anyone
who can start a workflow there runs code on that machine. Each guard below,
and the test that proves it:

1. **No trigger a stranger can pull.** Workflows start only on
   `workflow_dispatch` (needs write access) or `push` (a fork's push runs in
   the fork, never here). No `pull_request`, `pull_request_target`,
   `issue_comment`, `workflow_run`, `schedule` or anything else.
   *Test:* `scripts/check-triggers.mjs` reads every workflow file and fails on
   any trigger outside that list; `test/triggers.test.mjs` adds
   `pull_request` (and five others) to copies and checks each one fails. CI
   runs the check before the tests.
2. **`launch.yml` is dispatch only**, and its first job refuses any branch
   but `main`. *Test:* adding `push` to it fails the check.
3. **Secrets only from `main`.** Every job that reads a secret sits in
   environment `provision`, which Elijah limits to `main`. *Test:* the check
   fails a job that reads `secrets.` outside it.
4. **Laptop runner only.** *Test:* the check fails any job without
   `self-hosted` (GitHub-hosted jobs do not start on this account anyway).
5. **No secret in a log, summary or artifact.** Logs of a public repo are
   public. Every value is masked with `::add-mask::` before use, every printed
   line also passes a redaction filter for `whsec_`, `re_`, `sb_secret_`,
   `rk_`/`sk_`, `sbp_` and JWTs, and steps that see secrets run with
   `set +x`. Response bodies are never printed. *Test:* the acceptance suite
   greps every line of every run (as GitHub shows it, and raw) plus every
   summary for `whsec_|re_|sb_secret|rk_` and for every value the fakes
   issued: 0 hits. A deploy tool that prints the secrets is redacted too.
6. **Generated secrets touch disk once.** A `mktemp` file under
   `$RUNNER_TEMP`, mode 600 (the launcher refuses any other mode), deleted by
   an `always()` step; the last step empties `$RUNNER_TEMP` and the shop
   checkout, because a self-hosted runner keeps its disk. *Test:*
   `test/secrets-file.test.mjs`, and the workflow-shape test checks the order.
7. **Least reach for child processes.** The shop's install and build get no
   provider token; `wrangler` gets only the two Cloudflare values. *Test:* the
   fake wrangler reports the environment names it received.
8. **Test keys only.** A live Stripe key (`rk_live_`, `sk_live_`) is refused
   before any call. *Test:* in the acceptance suite.
9. **The fakes cannot be pointed at the real thing, or the other way round.**
   API base overrides work only with `LAUNCHER_FAKE_APIS=1` and only for
   `127.0.0.1` or `localhost`; the check fails `launch.yml` if it mentions
   that switch.

What stays: anyone Elijah gives push access to can run code on that runner,
as in his other repositories. The runner is its own Linux user with no sudo
(`scripts/add-launcher-runner.sh`) and holds no provider token at rest.

## Summary JSON (read by the store op, piece 5)

Every run uploads one artifact, `launch-summary-<shop>-<mode>-<run id>`,
holding `summary-<shop>.json`. The same facts go to the job summary page.
Names only: no secret value, project ref or webhook id appears in it.

```json
{
  "schema": "shop-launcher/summary@1",
  "shop": "orb",
  "mode": "apply",
  "ok": true,
  "exitCode": 0,
  "startedAt": "2026-10-23T12:00:00.000Z",
  "finishedAt": "2026-10-23T12:01:10.000Z",
  "writes": 4,
  "resources": [
    { "kind": "supabase_project", "name": "shop-orb", "action": "create", "id": "***" },
    { "kind": "supabase_migration", "name": "20261021120000_orders.sql", "action": "create" },
    { "kind": "resend_key", "name": "shop-orb", "action": "create", "permission": "sending_access" },
    { "kind": "stripe_webhook", "name": "https://orb-shop.elijahedington.workers.dev/api/stripe/webhook",
      "action": "create", "events": ["checkout.session.completed", "checkout.session.async_payment_succeeded"], "id": "***" },
    { "kind": "worker_secrets", "name": "orb-shop", "action": "create", "count": 6 }
  ],
  "secrets": [
    { "name": "NEXT_PUBLIC_SUPABASE_URL", "state": "set" },
    { "name": "SUPABASE_SERVICE_ROLE_KEY", "state": "set" },
    { "name": "RESEND_API_KEY", "state": "set" },
    { "name": "STRIPE_SECRET_KEY", "state": "set" },
    { "name": "STRIPE_WEBHOOK_SECRET", "state": "set" },
    { "name": "CRON_SECRET", "state": "set" }
  ],
  "warnings": [{ "token": "CLOUDFLARE_API_TOKEN", "expiresOn": "2026-11-01T00:00:00Z", "daysLeft": 8 }],
  "missingPermissions": [{ "provider": "supabase", "permission": "organization_projects_read" }],
  "errors": []
}
```

- `action`: `create`, `skip`, `rotate`, `update` or `blocked` (a read failed,
  usually a missing permission; apply then stops before its first write).
- `secrets[].state`: `set` or `unchanged`. In a plan, `set` means "would be
  set".
- `writes`: the launcher's own non-GET calls. A plan is always 0.
- `exitCode`: 0 ok, 1 failed, 2 refused request (bad mode, slug, missing
  value, live key).
- `id` is `"***"` when the resource exists and `null` when it does not.

## Tests

`npm ci && npm test` runs everything against local fake APIs (`test/fake-apis.mjs`,
`test/fake-wrangler.mjs`); no real account is touched. CI (`test.yml`) runs
the trigger check and the tests on every push, on the laptop runner, since
GitHub's hosted runners do not start on this account.

## Live and rollback (piece 3)

- `mode=live` runs only in the `live` job, environment `live` (main only, required reviewer Elijah). GitHub holds that job in "Waiting" until he taps Approve; no runner takes it and no secret is read before then. The `live` environment holds `STRIPE_RK_LIVE__<SHOP>` plus its own copies of `CLOUDFLARE_API_TOKEN` and `GH_PROVISION_TOKEN` (a job sees one environment's secrets).
- Live goes up only on top of a test-key version running the commit the last green smoke proved. It makes a new live webhook endpoint and one new Worker version with the live key, that endpoint's secret and the marker `SHOP_LAUNCHER_LIVE`, then runs smoke check 1. If check 1 fails it rolls back by itself and deletes the new endpoint.
- `mode=rollback`: the `launch` job (provision, no approval) rolls the Worker back to the newest version without the marker, which holds the test key and test webhook secret. Then the `live` job, after Elijah's approval, disables the live endpoint. apply and smoke refuse while the shop is live.
- Night: an approval tapped while the laptop is off queues for the runner and starts when Elijah logs in next morning. GitHub fails a job still queued 24 hours after approval; dispatch again.
- `node scripts/dispatch-dry-run.mjs live orb` prints, from the real launch.yml, which jobs run, wait or skip and which secrets each names.
