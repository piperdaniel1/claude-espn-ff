/**
 * Partial typings for the ESPN fantasy v3 API responses we consume.
 * Only fields we read are declared; everything else is passed through as unknown.
 */

export interface RawStat {
  id?: string;
  seasonId: number;
  scoringPeriodId: number;
  statSourceId: number; // 0 actual, 1 projected
  statSplitTypeId: number; // 0 season, 1 scoring period, 2 last 7 days?
  appliedTotal?: number;
  appliedAverage?: number;
  appliedStats?: Record<string, number>;
  stats?: Record<string, number>;
  externalId?: string;
  proTeamId?: number;
}

export interface RawRanking {
  positionalRanking?: number;
  totalRanking?: number;
  totalRating?: number;
}

export interface RawPlayer {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId?: number;
  proTeamId?: number;
  eligibleSlots?: number[];
  injuryStatus?: string;
  injured?: boolean;
  active?: boolean;
  droppable?: boolean;
  universeId?: number;
  lastNewsDate?: number;
  seasonOutlook?: string;
  jersey?: string;
  ownership?: {
    percentOwned?: number;
    percentStarted?: number;
    percentChange?: number;
    auctionValueAverage?: number;
    averageDraftPosition?: number;
  };
  draftRanksByRankType?: Record<string, { rank?: number; auctionValue?: number }>;
  stats?: RawStat[];
}

export interface RawPlayerPoolEntry {
  id: number;
  onTeamId?: number;
  status?: string; // FREEAGENT | WAIVERS | ONTEAM
  lineupLocked?: boolean;
  rosterLocked?: boolean;
  tradeLocked?: boolean;
  keeperValue?: number;
  appliedStatTotal?: number;
  ratings?: Record<string, RawRanking>;
  player: RawPlayer;
}

export interface RawRosterEntry {
  playerId: number;
  lineupSlotId: number;
  acquisitionType?: string;
  acquisitionDate?: number;
  injuryStatus?: string;
  status?: string;
  playerPoolEntry?: RawPlayerPoolEntry;
}

export interface RawTeamRecord {
  wins?: number;
  losses?: number;
  ties?: number;
  pointsFor?: number;
  pointsAgainst?: number;
  percentage?: number;
  streakLength?: number;
  streakType?: string;
}

export interface RawTeam {
  id: number;
  abbrev?: string;
  name?: string;
  location?: string;
  nickname?: string;
  logo?: string;
  owners?: string[];
  primaryOwner?: string;
  divisionId?: number;
  playoffSeed?: number;
  rankCalculatedFinal?: number;
  currentProjectedRank?: number;
  draftDayProjectedRank?: number;
  waiverRank?: number;
  points?: number;
  pointsAdjusted?: number;
  record?: { overall?: RawTeamRecord; home?: RawTeamRecord; away?: RawTeamRecord; division?: RawTeamRecord };
  roster?: { entries: RawRosterEntry[]; appliedStatTotal?: number };
  transactionCounter?: {
    acquisitionBudgetSpent?: number;
    acquisitions?: number;
    drops?: number;
    trades?: number;
    moveToActive?: number;
    moveToIR?: number;
    paid?: number;
    misc?: number;
    matchupAcquisitionTotals?: Record<string, number>;
  };
  valuesByStat?: Record<string, number>;
}

export interface RawMember {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  isLeagueManager?: boolean;
}

export interface RawMatchupSide {
  teamId: number;
  totalPoints?: number;
  totalPointsLive?: number;
  totalProjectedPointsLive?: number;
  adjustment?: number;
  pointsByScoringPeriod?: Record<string, number>;
  rosterForCurrentScoringPeriod?: { entries: RawRosterEntry[]; appliedStatTotal?: number };
  rosterForMatchupPeriod?: { entries: RawRosterEntry[]; appliedStatTotal?: number };
}

export interface RawScheduleItem {
  id: number;
  matchupPeriodId: number;
  home?: RawMatchupSide;
  away?: RawMatchupSide;
  winner?: string; // HOME | AWAY | TIE | UNDECIDED
  playoffTierType?: string; // NONE | WINNERS_BRACKET | LOSERS_CONSOLATION_LADDER | ...
}

export interface RawSettings {
  name?: string;
  size?: number;
  isPublic?: boolean;
  acquisitionSettings?: {
    acquisitionBudget?: number;
    acquisitionLimit?: number;
    acquisitionType?: string; // WAIVERS_CONTINUOUS | WAIVERS_TRADITIONAL | FREEAGENCY...
    isUsingAcquisitionBudget?: boolean;
    matchupAcquisitionLimit?: number;
    matchupLimitPerScoringPeriod?: boolean;
    minimumBid?: number;
    waiverHours?: number;
    waiverProcessDays?: string[];
    waiverProcessHour?: number;
    waiverOrderReset?: boolean;
    finalPlaceTransactionEligible?: number;
  };
  rosterSettings?: {
    lineupSlotCounts?: Record<string, number>;
    positionLimits?: Record<string, number>;
    rosterLocktimeType?: string;
    lineupLocktimeType?: string; // INDIVIDUAL_GAME | FIRST_GAME_OF_WEEK | ...
    isUsingUndroppableList?: boolean;
    isBenchUnlimited?: boolean;
    moveLimit?: number;
    universeIds?: number[];
  };
  scheduleSettings?: {
    matchupPeriodCount?: number;
    matchupPeriodLength?: number;
    matchupPeriods?: Record<string, number[]>;
    playoffMatchupPeriodLength?: number;
    playoffTeamCount?: number;
    playoffSeedingRule?: string;
    playoffSeedingRuleBy?: number;
    periodTypeId?: number;
    divisions?: { id: number; name?: string; size?: number }[];
  };
  scoringSettings?: {
    scoringType?: string;
    playerRankType?: string;
    homeTeamBonus?: number;
    matchupTieRule?: string;
    scoringItems?: { statId: number; points: number; isReverseItem?: boolean; pointsOverrides?: Record<string, number> }[];
  };
  tradeSettings?: {
    allowOutOfUniverse?: boolean;
    deadlineDate?: number;
    max?: number;
    revisionHours?: number;
    vetoVotesRequired?: number;
  };
  draftSettings?: { date?: number; type?: string; auctionBudget?: number; keeperCount?: number };
}

export interface RawStatus {
  currentMatchupPeriod?: number;
  latestScoringPeriod?: number;
  firstScoringPeriod?: number;
  finalScoringPeriod?: number;
  isActive?: boolean;
  isFull?: boolean;
  previousSeasons?: number[];
  standingsUpdateDate?: number;
  transactionScoringPeriod?: number;
  waiverLastExecutionDate?: number;
  waiverNextExecutionDate?: number;
  waiverProcessStatus?: Record<string, number>;
  activatedDate?: number;
  createdAsLeagueType?: number;
  currentLeagueType?: number;
}

export interface RawTransactionItem {
  playerId: number;
  type: string; // ADD | DROP | LINEUP | TRADE
  fromTeamId?: number;
  toTeamId?: number;
  fromLineupSlotId?: number;
  toLineupSlotId?: number;
  isKeeper?: boolean;
  overallPickNumber?: number;
}

export interface RawTransaction {
  id: string;
  type: string;
  status?: string; // EXECUTED | PENDING | CANCELED | FAILED_* | ...
  teamId?: number;
  memberId?: string;
  scoringPeriodId?: number;
  bidAmount?: number;
  proposedDate?: number;
  processDate?: number;
  executionType?: string;
  expirationDate?: number;
  isPending?: boolean;
  isActingAsTeamOwner?: boolean;
  isLeagueManager?: boolean;
  rating?: number;
  relatedTransactionId?: string;
  subOrder?: number;
  items?: RawTransactionItem[];
  teamsVotedToVeto?: number[];
  comment?: string;
}

export interface RawLeague {
  id: number;
  seasonId: number;
  scoringPeriodId: number;
  segmentId?: number;
  gameId?: number;
  status?: RawStatus;
  settings?: RawSettings;
  teams?: RawTeam[];
  members?: RawMember[];
  schedule?: RawScheduleItem[];
  players?: RawPlayerPoolEntry[];
  transactions?: RawTransaction[];
  pendingTransactions?: RawTransaction[];
  draftDetail?: unknown;
}

export interface RawProGame {
  id: number;
  date: number;
  homeProTeamId: number;
  awayProTeamId: number;
  scoringPeriodId: number;
  startTimeTBD?: boolean;
  statsOfficial?: boolean;
  validForLocking?: boolean;
}

export interface RawProTeam {
  id: number;
  abbrev?: string;
  location?: string;
  name?: string;
  byeWeek?: number;
  proGamesByScoringPeriod?: Record<string, RawProGame[]>;
}

export interface RawProSchedule {
  settings?: { proTeams?: RawProTeam[] };
}

export interface RawActivityMessage {
  id?: string;
  messageTypeId: number;
  targetId?: number; // player id
  from?: number; // team id (or 0)
  to?: number; // team id
  for?: number;
  date?: number;
  author?: string;
}

export interface RawActivityTopic {
  id: string;
  date?: number;
  type?: string;
  messages?: RawActivityMessage[];
}

export interface RawActivityFeed {
  topics?: RawActivityTopic[];
}

export interface RawPlayersWl {
  id: number;
  fullName?: string;
  defaultPositionId?: number;
  proTeamId?: number;
  active?: boolean;
  injured?: boolean;
  injuryStatus?: string;
}
