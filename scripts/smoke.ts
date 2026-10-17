/**
 * Read-only smoke test against the real ESPN API using the .env settings.
 *
 *   npm run smoke                 # context + roster + lineup recommendation
 *   npm run smoke -- fa RB WR     # top free agents at positions
 *   npm run smoke -- transactions # pending/recent transactions
 *   npm run smoke -- search "jefferson"
 *   npm run smoke -- raw          # dump the raw league JSON (debugging)
 *
 * Nothing here writes to ESPN.
 */

import { loadConfig } from "../src/config.ts";
import { EspnClient } from "../src/espn/client.ts";
import { LeagueService } from "../src/espn/league.ts";
import { planLineup } from "../src/espn/lineup.ts";

const [, , command = "overview", ...rest] = process.argv;

function print(label: string, data: unknown) {
  console.log(`\n=== ${label}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const config = loadConfig(process.env);
  const client = new EspnClient({ season: config.espn.season, leagueId: config.espn.leagueId, credentials: { s2: config.espn.s2, swid: config.espn.swid } });
  const league = new LeagueService({ client, swid: config.espn.swid, teamIdOverride: config.espn.teamId, timezone: config.timezone });

  if (command === "raw") {
    const raw = await client.leagueGet({ views: ["mTeam", "mRoster", "mSettings", "mMatchupScore", "mStatus"] });
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  const snap = await league.getSnapshot();
  console.log(`League: ${snap.leagueName} (${snap.leagueId}) season ${snap.season}, week ${snap.scoringPeriodId}`);
  console.log(`My team: ${snap.myTeam.name} (id ${snap.myTeam.id}) record ${snap.myTeam.record.wins}-${snap.myTeam.record.losses}, FAAB left: ${snap.myTeam.faabRemaining ?? "n/a"}`);
  console.log(`Teams: ${snap.teams.map((t) => `${t.id}=${t.name}`).join(", ")}`);

  if (command === "overview") {
    print(
      "roster",
      snap.myTeam.roster.map((p) => ({ slot: p.slot, name: p.name, pos: p.position, team: p.proTeam, status: p.injuryStatus, proj: p.projectedWeek, game: p.game.bye ? "BYE" : `${p.game.home ? "vs" : "@"} ${p.game.opponent} ${p.game.kickoff}`, locked: p.locked })),
    );
    const plan = planLineup(league.lineupCandidates(snap), snap.settings.startingSlotCounts);
    print("lineup recommendation", { unchanged: plan.unchanged, current: plan.currentProjectedTotal, recommended: plan.projectedTotal, moves: plan.moves, warnings: plan.warnings });
    print("settings", snap.settings);
  } else if (command === "fa") {
    const res = await league.getFreeAgents({ positions: rest.length ? rest : undefined, limit: 15, sort: "projected_week" });
    print(`free agents (${rest.join(",") || "all"})`, res.players.map((p) => ({ id: p.id, name: p.name, pos: p.position, team: p.proTeam, proj: p.projectedWeek, owned: p.percentOwned, availability: p.availability })));
  } else if (command === "transactions") {
    print("transactions", await league.getTransactions());
    print("activity", await league.getRecentActivity(10));
  } else if (command === "search") {
    print(`search "${rest.join(" ")}"`, await league.searchPlayers(rest.join(" ")));
  } else {
    console.error(`Unknown command ${command}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nSmoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
