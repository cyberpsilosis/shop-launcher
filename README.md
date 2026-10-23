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

## Running it

Actions > launch > Run workflow, with a shop slug and a mode. The store's
dispatch op (piece 5) will do the same thing.

- **plan**: GET calls only. Prints `create`, `skip`, `rotate` or `update` for
  every resource, which Worker secrets would be set, token expiry warnings
  (14 days ahead), and any missing Supabase permission by name.
- **apply**: does what plan printed. Run it twice and the second run is all
  `skip` with zero write calls.
- **smoke**, **live**, **rollback**: refused with a message. They are pieces
  2 and 3.

`rotate` means a secret that cannot be read back (a Stripe webhook secret,
a Resend key) is missing from the Worker. apply makes a new one, puts it on
the Worker, and only then deletes the old one. If the deploy fails, apply
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
this runner exists. Open Windows PowerShell on the laptop and paste this one
line:

```powershell
gh api -X POST repos/cyberpsilosis/shop-launcher/actions/runners/registration-token --jq .token | wsl -u root -- bash -c 'curl -fsSLo /tmp/add-launcher-runner.sh https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/scripts/add-launcher-runner.sh && bash /tmp/add-launcher-runner.sh'
```

It asks you nothing. `gh` makes a registration token (valid one hour) and
pipes it straight into the script, so the token is never shown, copied or
saved. `wsl -u root` runs the script as root without a password prompt. It
takes about a minute, most of it the runner download.

What the script does (`scripts/add-launcher-runner.sh`):

- Stops with `STOP: ...; nothing changed` if the `ci-shop-launcher` user or
  its home exists, if a shop-launcher runner service is installed, or if any
  runner folder under `/home` is already registered to this repository. It
  never uses `--replace`, so it cannot take over another runner.
- Makes user `ci-shop-launcher`: its own group only, no password, no sudo,
  home mode 750. The other runners' users cannot read its folder.
- Downloads GitHub's runner, checks its published SHA-256, and puts it in
  `/home/ci-shop-launcher/actions-runner`.
- Registers it as `laptop-shop-launcher`, label `shop-launcher`, and starts
  it as a systemd service running as that user.

When it ends with `Done: runner laptop-shop-launcher (label shop-launcher)
runs as ci-shop-launcher.`, the runner shows as Idle under Settings > Actions
> Runners, and the queued `test` runs start.

To try it on a scratch machine without registering anything:
`sudo LAUNCHER_RUNNER_NO_REGISTER=1 bash scripts/add-launcher-runner.sh`. It
makes the user and the empty runner folder and stops.

To undo: in `/home/ci-shop-launcher/actions-runner` run `sudo ./svc.sh stop`
and `sudo ./svc.sh uninstall`, delete the runner under Settings > Actions >
Runners, then `sudo userdel -r ci-shop-launcher`.

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
