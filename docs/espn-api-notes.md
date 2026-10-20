# ESPN fantasy API notes

ESPN has no public fantasy API. Everything here comes from the web client's
traffic and community reverse engineering (notably `cwendt94/espn-api`,
`ryanjadhav/espn-fantasy` and `gagandaroach/fantasy-yolo`). It can change
without notice; `npm run smoke` is the quickest way to see whether reads still
work after an ESPN change.

## Hosts and auth

| Purpose | Base URL |
| --- | --- |
| Reads | `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}` |
| Writes | `https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}/transactions/` |
| Season-level | `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}` |

Private leagues need the `espn_s2` and `SWID` cookies from a logged-in
browser. `SWID` keeps its braces. A 401 (or a body containing
`AUTH_LEAGUE_NOT_VISIBLE` / "You are not authorized to view this League")
means the cookies are missing, expired or for an account outside the league.

Headers sent: `accept: application/json`, `cookie`, `x-fantasy-source: kona`,
`x-fantasy-platform: espn-fantasy-web`, a browser `user-agent`, and
`x-fantasy-filter` (JSON) where a filter applies.

## Read views used

| View(s) | Used for |
| --- | --- |
| `mTeam`, `mRoster`, `mSettings`, `mMatchupScore`, `mStatus` (one call) | League snapshot: teams, owners, records, rosters with stats, settings, schedule, status |
| `kona_player_info` + filter | Free agents / waivers, player lookups by id |
| `mTransactions2`, `mPendingTransactions` + filter | Waiver claims, adds/drops, trades (current and next scoring period) |
| `/communication/?view=kona_league_communication` + filter | Activity feed |
| `?view=proTeamSchedules_wl` (season-level) | NFL schedule, kickoff times, bye weeks |
| `/players?view=players_wl` (season-level) + `{"filterActive":{"value":true}}` | Player universe for name search |

### Free agent filter

```json
{"players":{"filterStatus":{"value":["FREEAGENT","WAIVERS"]},
            "filterSlotIds":{"value":[0,2,4,6,16,17]},
            "limit":100,"offset":0,
            "sortPercOwned":{"sortPriority":1,"sortAsc":false},
            "filterRanksForScoringPeriodIds":{"value":[7]},
            "filterStatsForTopScoringPeriodIds":{"value":2,"additionalValue":["002026","102026","002025","1120267","022026"]}}}
```

`additionalValue` codes: `00{season}` actual season, `10{season}` projected
season, `11{season}{week}` projected week, `02{season}` last 7 days.

### Stats array

`player.stats[]` entries are keyed by `seasonId`, `scoringPeriodId`,
`statSourceId` (0 actual, 1 projected) and `statSplitTypeId` (0 season total,
1 single scoring period). `appliedTotal` is fantasy points under the league's
scoring; `appliedAverage` is per game. The projected season total
(`statSourceId 1`, `statSplitTypeId 0`) behaves like a rest-of-season number
once the season is under way (it can be lower than points already scored), so
the tools expose it as `ros_proj`.

Live scores: `schedule[].home.totalPoints` stays 0 until a matchup period is
over. For the current week the tools sum the starters' actual points from
`mRoster` (and use `totalPointsLive` when ESPN includes it).

### Ids

Lineup slots: 0 QB, 2 RB, 4 WR, 6 TE, 16 D/ST, 17 K, 20 Bench, 21 IR, 23 FLEX
(3 RB/WR, 5 WR/TE, 7 OP also exist). Positions (`defaultPositionId`): 1 QB,
2 RB, 3 WR, 4 TE, 5 K, 16 D/ST. Pro team ids are in `src/espn/constants.ts`.

## Writes

All writes are a `POST` to the write host with `content-type: application/json`
and this envelope. ESPN deserialises strictly: unknown keys, `null`s and
unknown `executionType` values return 400, so the builders in
`src/espn/transactions.ts` only ever emit known keys.

```json
{"isLeagueManager":false,"isActingAsTeamOwner":false,"teamId":3,"type":"ROSTER",
 "memberId":"{SWID}","scoringPeriodId":7,"executionType":"EXECUTE","items":[...]}
```

| Operation | `type` | Items | Verified? |
| --- | --- | --- | --- |
| Lineup change (current week) | `ROSTER` | `LINEUP` items with `fromLineupSlotId`/`toLineupSlotId` | Yes (community captures of 200 + `status: EXECUTED`) |
| Lineup change (future week) | `FUTURE_ROSTER` | same | Shape only (passes ESPN's parser) |
| Add free agent (+ optional drop) | `FREEAGENT` | `ADD` (`toTeamId`) and `DROP` (`fromTeamId`) | Yes |
| Drop only | `ROSTER` | `DROP` | Yes |
| Waiver claim | `WAIVER` | `ADD` (+ `DROP`), `bidAmount` in the envelope for FAAB | Shape verified; end-to-end claim with a bid not captured |
| Cancel pending claim/proposal | same type, `executionType: "CANCEL"`, `relatedTransactionId` | none | Shape only |
| Propose trade | `TRADE_PROPOSAL` | `TRADE` items with `fromTeamId`/`toTeamId` for every player, optional `comment`, `expirationDate` | Shape only |
| Accept / decline trade | `TRADE_ACCEPT` / `TRADE_DECLINE` + `relatedTransactionId` | optional `DROP` items when accepting | Shape only |

Responses carry `id`, `status` (`EXECUTED`, `PENDING`, `FAILED_ROSTERLOCK`, …)
and sometimes `isPending`. Errors come back as
`{"messages":[...],"details":[{"type":"TRAN_ROSTER_LIMIT_EXCEEDED_ONE",...}]}`;
`details[].type` is the machine-readable rule (`TRAN_ROSTER_LIMIT_EXCEEDED_*`,
`TRAN_ROSTER_POSITION_LIMIT_EXCEEDED*`, `TRAN_ROSTER_SLOT_LIMIT_EXCEEDED*`).

Rules the client follows:

* Writes are never retried (no idempotency key exists). A timeout is reported as
  `outcome: "unknown"` and the roster is re-read.
* Both halves of a swap go in one transaction so ESPN never sees an over-full slot.
* There is no dry run on ESPN's side; `dry_run` in the tools is client-side
  validation plus the payload that would be sent.

## Things to watch

* `scoringPeriodId` for writes is `status.latestScoringPeriod` (equal to the
  current week in season).
* Lineup locks follow `rosterSettings.lineupLocktimeType`: `INDIVIDUAL_GAME`
  locks each player at kickoff; `FIRST_GAME_OF_WEEK` locks everyone at the
  first kickoff.
* Players move to waivers when dropped and clear after `waiverHours`; the
  league processes claims on `waiverProcessDays`. `status.waiverNextExecutionDate`
  gives the next run when ESPN populates it.
