export type FixtureLifecycleState =
  | "scheduled"
  | "live"
  | "live_break"
  | "interrupted"
  | "suspended"
  | "finished"
  | "postponed"
  | "cancelled"
  | "abandoned"
  | "unknown";

export type FixtureResultType =
  | "regular"
  | "after_extra_time"
  | "penalties"
  | "awarded"
  | "walkover"
  | null;

export type FixtureLifecycle = {
  providerStatusShort: string;
  providerStatusLong: string | null;
  lifecycleState: FixtureLifecycleState;
  resultType: FixtureResultType;
  isLive: boolean;
  isActivelyPlaying: boolean;
  isPaused: boolean;
  isFinished: boolean;
  isScheduled: boolean;
  isPostponed: boolean;
  isCancelled: boolean;
  displayStatus: string;
};

type StatusInput =
  | string
  | null
  | undefined
  | { short?: unknown; long?: unknown };

type LifecycleDefinition = Omit<
  FixtureLifecycle,
  "providerStatusShort" | "providerStatusLong"
>;

const scheduled = (displayStatus: string): LifecycleDefinition => ({
  lifecycleState: "scheduled",
  resultType: null,
  isLive: false,
  isActivelyPlaying: false,
  isPaused: false,
  isFinished: false,
  isScheduled: true,
  isPostponed: false,
  isCancelled: false,
  displayStatus,
});

const live = (
  displayStatus: string,
  options: { paused?: boolean; state?: FixtureLifecycleState } = {},
): LifecycleDefinition => ({
  lifecycleState: options.state ?? "live",
  resultType: null,
  isLive: true,
  isActivelyPlaying: !options.paused,
  isPaused: options.paused ?? false,
  isFinished: false,
  isScheduled: false,
  isPostponed: false,
  isCancelled: false,
  displayStatus,
});

const terminal = (
  displayStatus: string,
  resultType: Exclude<FixtureResultType, null>,
): LifecycleDefinition => ({
  lifecycleState: "finished",
  resultType,
  isLive: false,
  isActivelyPlaying: false,
  isPaused: false,
  isFinished: true,
  isScheduled: false,
  isPostponed: false,
  isCancelled: false,
  displayStatus,
});

const definitions: Readonly<Record<string, LifecycleDefinition>> = {
  TBD: scheduled("DA DEFINIRE"),
  NS: scheduled("NON INIZIATA"),
  "1H": live("1° TEMPO"),
  HT: live("INTERVALLO", { paused: true, state: "live_break" }),
  "2H": live("2° TEMPO"),
  ET: live("SUPPLEMENTARI"),
  BT: live("INTERVALLO SUPPLEMENTARI", {
    paused: true,
    state: "live_break",
  }),
  P: live("RIGORI"),
  PEN_LIVE: live("RIGORI"),
  LIVE: live("LIVE"),
  INT: live("PARTITA INTERROTTA", {
    paused: true,
    state: "interrupted",
  }),
  SUSP: {
    lifecycleState: "suspended",
    resultType: null,
    isLive: false,
    isActivelyPlaying: false,
    isPaused: true,
    isFinished: false,
    isScheduled: false,
    isPostponed: false,
    isCancelled: false,
    displayStatus: "PARTITA SOSPESA",
  },
  FT: terminal("TERMINATA", "regular"),
  AET: terminal("TERMINATA DOPO I SUPPLEMENTARI", "after_extra_time"),
  PEN: terminal("TERMINATA AI RIGORI", "penalties"),
  PEN_FT: terminal("TERMINATA AI RIGORI", "penalties"),
  PST: {
    lifecycleState: "postponed",
    resultType: null,
    isLive: false,
    isActivelyPlaying: false,
    isPaused: false,
    isFinished: false,
    isScheduled: false,
    isPostponed: true,
    isCancelled: false,
    displayStatus: "POSTICIPATA",
  },
  CANC: {
    lifecycleState: "cancelled",
    resultType: null,
    isLive: false,
    isActivelyPlaying: false,
    isPaused: false,
    isFinished: false,
    isScheduled: false,
    isPostponed: false,
    isCancelled: true,
    displayStatus: "ANNULLATA",
  },
  ABD: {
    lifecycleState: "abandoned",
    resultType: null,
    isLive: false,
    isActivelyPlaying: false,
    isPaused: false,
    isFinished: false,
    isScheduled: false,
    isPostponed: false,
    isCancelled: false,
    displayStatus: "PARTITA ABBANDONATA",
  },
  AWD: terminal("ASSEGNATA A TAVOLINO", "awarded"),
  WO: terminal("VITTORIA A TAVOLINO", "walkover"),
};

function statusParts(input: StatusInput, statusLong?: unknown) {
  if (input != null && typeof input === "object") {
    return {
      short: String(input.short ?? "").trim().toUpperCase(),
      long: String(input.long ?? "").trim() || null,
    };
  }
  return {
    short: String(input ?? "").trim().toUpperCase(),
    long: String(statusLong ?? "").trim() || null,
  };
}

/**
 * Unica semantica backend degli status API-Football.
 *
 * Non modifica il payload del provider e non deduce date o transizioni dalla
 * presenza nel feed live. Traduce esclusivamente status.short/status.long in
 * proprietà di dominio stabili e serializzabili.
 */
export function normalizeFixtureStatus(
  input: StatusInput,
  statusLong?: unknown,
): FixtureLifecycle {
  const provider = statusParts(input, statusLong);
  const definition = definitions[provider.short];
  if (definition) {
    return {
      providerStatusShort: provider.short,
      providerStatusLong: provider.long,
      ...definition,
    };
  }
  return {
    providerStatusShort: provider.short,
    providerStatusLong: provider.long,
    lifecycleState: "unknown",
    resultType: null,
    isLive: false,
    isActivelyPlaying: false,
    isPaused: false,
    isFinished: false,
    isScheduled: false,
    isPostponed: false,
    isCancelled: false,
    displayStatus:
      provider.long ?? (provider.short || "STATO SCONOSCIUTO"),
  };
}

export function fixtureLifecycleOf(fixture: any): FixtureLifecycle {
  return normalizeFixtureStatus(fixture?.fixture?.status);
}

/**
 * Una ripresa da INT/SUSP non è un nuovo calcio d'inizio. Il kickoff nasce
 * solo dalla prima osservazione attivamente giocata o da uno stato che non era
 * ancora iniziato/posticipato verso uno stato di gioco attivo.
 */
export function isFixtureKickoffTransition(
  previous: FixtureLifecycle | null | undefined,
  current: FixtureLifecycle,
): boolean {
  if (!current.isActivelyPlaying) return false;
  if (previous == null) {
    return current.providerStatusShort === "1H" ||
      current.providerStatusShort === "LIVE";
  }
  return previous.isScheduled || previous.isPostponed;
}

/** Aggiunge il DTO normalizzato senza alterare i campi originali provider. */
export function withFixtureLifecycle<T = any>(fixture: T): T {
  if (fixture == null || typeof fixture !== "object") return fixture;
  const row = fixture as any;
  if (row?.fixture?.status == null) return fixture;
  return {
    ...row,
    fixture: {
      ...row.fixture,
      lifecycle: normalizeFixtureStatus(row.fixture.status),
    },
  } as T;
}

export function withFixtureLifecycles<T = any>(payload: T): T {
  if (payload == null || typeof payload !== "object") return payload;
  const root = payload as any;
  if (!Array.isArray(root.response)) return payload;
  return {
    ...root,
    response: root.response.map((row: any) => withFixtureLifecycle(row)),
  } as T;
}
