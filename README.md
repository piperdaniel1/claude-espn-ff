# claude-espn-ff

A remote [MCP](https://modelcontextprotocol.io) connector that lets Claude view
and manage one ESPN Fantasy Football team: lineups, free agents, waiver claims
(FAAB bids), drops, trades, and a journal so a scheduled Claude run can keep
continuity from day to day. It deploys as a single Netlify Function and signs
Claude in with OAuth, so you can add it to Claude on your phone and let a
scheduled task run it unattended.

```
Claude (scheduled task or chat)
   │  MCP over HTTPS (OAuth bearer token)
   ▼
Netlify Function  ──  src/http/router.ts (OAuth + MCP)  ──  src/mcp/server.ts (22 tools)
   │                                                           │
   │  cookies espn_s2 / SWID                                   └─ Netlify Blobs (journal)
   ▼
ESPN fantasy v3 API (lm-api-reads / lm-api-writes)
```

The ESPN API is unofficial. Reads and lineup/add/drop/waiver writes follow the
shapes ESPN's own web client sends; trade endpoints are best-effort. Details and
verification status are in [`docs/espn-api-notes.md`](docs/espn-api-notes.md).

## Setup

You need: a Netlify account (any plan; Functions and Blobs are included), the
ESPN league you play in, Node 22 if you want to run things locally, and a
Claude plan that supports custom connectors and scheduled tasks.

### 1. Get your ESPN cookies

ESPN authenticates private leagues with two cookies.

1. Log in at <https://fantasy.espn.com> in a desktop browser and open your league.
2. Open developer tools (F12) → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** → `https://fantasy.espn.com`.
3. Copy the value of `espn_s2` (long, contains `%2B`-style escapes; copy it exactly as shown) and `SWID` (looks like `{1234ABCD-...}`; keep the braces).
4. Note your league id from the URL: `fantasy.espn.com/football/league?leagueId=123456`.

`espn_s2` lasts months but does expire. When it does, the connector reports
`auth_problem: true` and the scheduled run tells you to refresh it.

### 2. Deploy to Netlify

**Option A – Netlify UI.** Push this repo to GitHub, then in Netlify choose
*Add new site → Import an existing project*, pick the repo, keep the detected
settings (`npm run build`, publish `public`), and add the environment variables
below before the first deploy.

**Option B – CLI.**

```bash
npm install
npx netlify-cli login
npx netlify-cli init          # create/link the site
npx netlify-cli env:import .env   # after filling in .env (see .env.example)
npx netlify-cli deploy --prod
```

Environment variables (Site configuration → Environment variables):

| Variable | Required | Notes |
| --- | --- | --- |
| `ESPN_S2` | yes | Cookie value from step 1 |
| `ESPN_SWID` | yes | Cookie value with braces |
| `ESPN_LEAGUE_ID` | yes | Numeric league id |
| `CONNECTOR_PASSWORD` | yes | Password you will type when connecting Claude (8+ chars) |
| `CONNECTOR_SECRET` | strongly recommended | Random 32+ chars used to sign tokens: `openssl rand -base64 48` |
| `ESPN_TEAM_ID` | no | Only if you own several teams in the league or auto-detection fails |
| `ESPN_SEASON` | no | Defaults to the current NFL season |
| `TIMEZONE` | no | IANA zone for all displayed times, default `America/Denver` |
| `PUBLIC_URL` | no | Only when serving behind a custom domain whose URL differs from the request URL |
| `DEV_BEARER_TOKEN` | no | Static bearer token for local tooling; leave unset in production unless you need it |
| `ALLOWED_REDIRECT_HOSTS` | no | Extra OAuth redirect hosts (comma separated); Claude's hosts and loopback are always allowed |

After deploying, open `https://<your-site>.netlify.app/health`. It should show
`"ok": true` with your league id and season. The landing page at `/` repeats
the Claude setup steps.

### 3. Check it against your league (optional but recommended)

```bash
cp .env.example .env   # fill in the values
npm install
npm run smoke          # read-only: league, roster, lineup recommendation, settings
npm run smoke -- fa RB WR
npm run smoke -- transactions
```

If `npm run smoke` prints your roster, the cookies and league id are right.

### 4. Add the connector to Claude

1. In Claude (web or app) go to **Customize → Connectors → Add custom connector**.
2. Name it, e.g. `ESPN Fantasy Football`, and enter the URL `https://<your-site>.netlify.app/mcp`.
3. Leave the OAuth client settings on their defaults (Claude registers itself automatically) and click **Add**, then **Connect**.
4. A sign-in page from your site opens; enter `CONNECTOR_PASSWORD`.

The connector can now be toggled on in any chat. Try: *"Call get_context and
summarise my team."*

### 5. Create the scheduled task

Follow [`prompts/README.md`](prompts/README.md). The prompt to paste is
[`prompts/scheduled-task.md`](prompts/scheduled-task.md); the recommended
schedule is daily at 10:07 AM Mountain Time with only this connector enabled.

## Tools

Read-only tools:

| Tool | What it returns |
| --- | --- |
| `get_context` | Date/time, NFL week, phase, league rules, my record and standing, this week's matchup, lineup problems, lock times, pending transactions, recent journal. Call first. |
| `get_my_roster` | Every rostered player with slot, lock status, injury, projection, game, season stats, ownership |
| `get_lineup_recommendation` | Projected-optimal lineup (Hungarian assignment over eligibility, locks, byes, injuries) with the exact moves |
| `get_matchup` | My matchup for a week with both lineups |
| `get_standings` | All teams, records, FAAB left, waiver priority, my full schedule |
| `get_team_roster` | Any team's roster |
| `get_free_agents` | Available players filtered by position, sortable by week/season projection, points, ownership |
| `search_players` | Name search across all NFL players with league availability |
| `get_player` | Weekly history and details for player ids |
| `get_transactions` | Pending/recent waiver claims, adds, drops, trades; flags trades awaiting my response |
| `get_league_activity` | League-wide adds/drops/trades feed |
| `get_nfl_schedule` | Kickoff times and bye teams for a week |
| `read_journal` | Notes left by previous runs |

Write tools (all accept `dry_run: true` and validate against the live roster
before sending anything):

| Tool | What it does |
| --- | --- |
| `set_lineup` | Moves players between slots in one transaction |
| `apply_recommended_lineup` | Computes and applies the optimal lineup |
| `add_free_agent` | Instant add of a free agent, optional drop |
| `claim_waiver_player` | Waiver claim with FAAB bid, optional drop |
| `drop_player` | Release a player |
| `cancel_pending_transaction` | Cancel my pending claim or trade proposal |
| `propose_trade` | Send a trade proposal |
| `respond_to_trade` | Accept or decline a proposal made to me |
| `append_journal` | Record a note for future runs |

## Security model

* The ESPN cookies never leave the Netlify environment; Claude only sees tool
  results.
* Claude signs in with OAuth 2.1 (dynamic client registration, PKCE S256,
  rotating refresh tokens) implemented in `src/auth/oauth.ts`. The only user is
  whoever knows `CONNECTOR_PASSWORD`. Tokens are HMAC-signed with
  `CONNECTOR_SECRET`, so no database is needed; Netlify Blobs adds replay
  protection for codes and refresh tokens when available.
* Only Claude's callback (`https://claude.ai/api/mcp/auth_callback`),
  Anthropic hosts and loopback addresses can be registered as redirect URIs.
* Rotating `CONNECTOR_PASSWORD` or `CONNECTOR_SECRET` invalidates all tokens;
  remove and re-add the connector in Claude afterwards.
* `DEV_BEARER_TOKEN`, if set, is accepted as a plain bearer token. Use it for
  local testing or Claude's "request headers" authentication; unset it when
  you do not need it.

## Local development

```bash
npm install
cp .env.example .env            # fill in values
npm test                        # unit + end-to-end tests against a mocked ESPN
npm run typecheck
npm run dev                     # netlify dev on http://localhost:8888
npm run mcp-client -- http://localhost:8888 tools
npm run mcp-client -- http://localhost:8888 get_context
npm run mcp-client -- http://localhost:8888 set_lineup '{"moves":[{"player_id":123,"to_slot":"BE"}],"dry_run":true}'
```

`npm run mcp-client` uses `DEV_BEARER_TOKEN` when set, otherwise it mints a
token from `CONNECTOR_SECRET`. `npm run token -- https://<site>` prints a
bearer token you can use with curl or MCP Inspector against a deployment.

Tests live in `tests/`. They cover the OAuth flow end to end, payload
builders, the lineup optimiser, the ESPN parsing layer (against a synthetic
league in `tests/fixtures/`), and the MCP tools through a real MCP client.

## Operations and limits

* **Cookie expiry:** tools return `auth_problem: true`; refresh `ESPN_S2`
  (and `ESPN_SWID` if it changed) in Netlify and redeploy.
* **Function timeout:** Netlify synchronous functions default to 10 seconds.
  Each tool makes at most a few ESPN calls (~1–3 s total). If you see timeouts,
  Netlify support can raise the limit to 26 seconds on paid plans.
* **Journal storage:** Netlify Blobs store `espn-ff-connector`, key
  `journal:<league>:<season>`, last 250 entries. If Blobs is unavailable the
  journal falls back to memory and `read_journal` says so.
* **No undo:** drops release players to the league immediately. The scheduled
  prompt includes drop rules for this reason.
* **Unverified ESPN operations:** trade propose/accept/decline, cancelling a
  pending transaction and `FUTURE_ROSTER` have been validated against ESPN's
  payload parser only, not observed end to end. The tools tell Claude to
  confirm with `get_transactions` afterwards.

## Repository layout

```
netlify/functions/mcp.mts     Netlify entry point (routes /, /health, /mcp, /oauth/*, /.well-known/*)
src/http/router.ts            Request routing: discovery, OAuth, bearer check, MCP serving
src/auth/                     Stateless OAuth server and HMAC helpers
src/espn/client.ts            ESPN HTTP client (cookies, retries for reads only, error parsing)
src/espn/league.ts            Normalised league/roster/player model and write validation
src/espn/lineup.ts            Lineup optimiser
src/espn/transactions.ts      ESPN transaction payload builders
src/mcp/server.ts             MCP tool definitions
src/journal/store.ts          Netlify Blobs / in-memory key-value store and journal
scripts/                      smoke (read-only ESPN check), mcp-client, mint-token
prompts/                      Scheduled task prompt and scheduling guide
docs/espn-api-notes.md        Endpoint, filter and payload reference
tests/                        Vitest suite with a synthetic ESPN league fixture
```
