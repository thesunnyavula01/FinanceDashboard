import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Panel } from "@/components/terminal/Panel";
import { Corrections } from "@/components/terminal/Corrections";
import { MemberRoster } from "@/components/terminal/MemberRoster";
import {
  ActionButton,
  ArmedButton,
  Feedback,
  Field,
  Readout,
  type Outcome,
} from "@/components/terminal/AdminControls";
import {
  useAdminOverview,
  useCreateSeason,
  useForceSnapshot,
  useForceSweep,
  useResetSeason,
  useRotateInvite,
  useSyncUniverse,
  useUpdateSeason,
} from "@/hooks/useAdmin";
import { useAuth } from "@/lib/auth";
import { api, ApiError } from "@/lib/api";
import { money, stampET } from "@/lib/format";

/**
 * F5 — the officers' console.
 *
 * Everything a club officer needs to run a season, on one screen, in the order
 * they will need it: the season at the top left, the code that lets people in
 * next to it, the two structural actions on the right, then the roster, then
 * the blotter they will correct a fat-fingered fill out of.
 *
 * The screen's one alarm is arming: a control that cannot be undone takes two
 * deliberate presses and turns red in between, and everything reversible is a
 * single click. Spending that signal on the wrong controls would train an
 * officer to click through it.
 */
export function Admin() {
  const { session } = useAuth();

  // The role comes from /auth/me, which reads it out of the database rather
  // than the session token — a token minted before a demotion would keep
  // asserting "admin" for the rest of its hour. Every route behind this screen
  // does the same check server-side; this only decides what to draw.
  const { data: me, isPending: rolePending } = useQuery({
    queryKey: ["me", session?.user.id],
    queryFn: api.me,
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });

  const isAdmin = me?.role === "admin";
  const { overview, activeSeason, isLoading, isError, error } = useAdminOverview(isAdmin);

  if (rolePending) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label pulse-dot">Loading the console</span>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-ink-dim">
          This screen is for club officers. Ask one of them if you need something changed.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label pulse-dot">Loading the console</span>
      </div>
    );
  }

  if (isError || !overview) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-loss">
          {error instanceof ApiError ? error.message : "Could not load the console."}
        </p>
      </div>
    );
  }

  const roster = overview.members
    .filter((member) => member.portfolioId)
    .map((member) => ({ id: member.portfolioId!, name: member.displayName }));

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-auto p-2.5">
      <div className="grid gap-2.5 lg:grid-cols-3">
        <SeasonPanel season={activeSeason} />
        <InvitePanel invite={overview.invite} universe={overview.universe} />
        <LifecyclePanel season={activeSeason} members={overview.members.length} />
      </div>

      <MemberRoster members={overview.members} currentUserId={session?.user.id} />

      <Corrections portfolios={roster} />
    </div>
  );
}

/**
 * The active season: what it is called, what it funds a new member with, and
 * whether anyone can trade right now.
 *
 * Changing the starting cash changes what a member who joins *from now on* is
 * given. It does not touch anybody who already has a portfolio, and the panel
 * says so — otherwise the obvious reading is that this number is everyone's
 * baseline, and an officer would be one keystroke from restating the whole
 * club's return.
 */
function SeasonPanel({ season }: { season: ReturnType<typeof useAdminOverview>["activeSeason"] }) {
  const update = useUpdateSeason();
  const [name, setName] = useState(season?.name ?? "");
  const [cash, setCash] = useState(season ? String(season.startingCash) : "");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The fields follow the season when it is replaced under them — after a
  // rollover, an editor still holding last season's name would save it back
  // over the new one.
  useEffect(() => {
    setName(season?.name ?? "");
    setCash(season ? String(season.startingCash) : "");
  }, [season?.id, season?.name, season?.startingCash]);

  if (!season) {
    return (
      <Panel title="Season">
        <p className="text-ink-dim">
          There is no active season. Start one on the right — nobody can sign up or trade until
          there is.
        </p>
      </Panel>
    );
  }

  const changed = name.trim() !== season.name || Number(cash) !== season.startingCash;

  function save() {
    setOutcome(null);
    update.mutate(
      {
        id: season!.id,
        changes: { name: name.trim(), startingCash: Number(cash) },
      },
      {
        onSuccess: () => setOutcome({ tone: "ok", text: "Season saved." }),
        onError: (err) =>
          setOutcome({
            tone: "error",
            text: err instanceof ApiError ? err.message : "Could not save the season.",
          }),
      },
    );
  }

  function toggleLock() {
    setOutcome(null);
    update.mutate(
      { id: season!.id, changes: { tradingLocked: !season!.tradingLocked } },
      {
        onSuccess: () =>
          setOutcome({
            tone: "ok",
            text: season!.tradingLocked
              ? "Trading is open. Orders will fill again."
              : "Trading is locked. Orders are refused until you unlock it.",
          }),
        onError: (err) =>
          setOutcome({
            tone: "error",
            text: err instanceof ApiError ? err.message : "Could not change the lock.",
          }),
      },
    );
  }

  return (
    <Panel
      title="Season"
      meta={
        season.tradingLocked ? (
          <span className="text-loss">Locked</span>
        ) : (
          <span className="text-gain">Open</span>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <Readout label="Started">{stampET(season.startsAt)}</Readout>
          <Readout label="Trading">
            {season.tradingLocked ? "Locked by an officer" : "Open"}
          </Readout>
        </div>

        <Field id="season-name" label="Name" value={name} onChange={setName} />

        <Field
          id="season-cash"
          label="Starting cash"
          value={cash}
          onChange={setCash}
          numeric
          prefix="$"
          hint="What a member who joins from now on is funded with. Members already trading keep the amount they were given."
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <ActionButton
            tone="accent"
            onClick={save}
            disabled={!changed}
            pending={update.isPending}
          >
            Save
          </ActionButton>
          <ActionButton onClick={toggleLock} pending={update.isPending}>
            {season.tradingLocked ? "Unlock trading" : "Lock trading"}
          </ActionButton>
        </div>

        <Feedback outcome={outcome} />
      </div>
    </Panel>
  );
}

/**
 * The invite code, and the three jobs the cron normally does.
 *
 * The code is shown in full rather than masked. It is a door code an officer
 * reads out at a meeting, not a password — hiding it would only mean they
 * cannot do the one thing they came here for.
 */
function InvitePanel({
  invite,
  universe,
}: {
  invite: { code: string | null; source: string; updatedAt: string | null };
  universe: { count: number; syncedAt: string | null };
}) {
  const rotate = useRotateInvite();
  const sync = useSyncUniverse();
  const sweep = useForceSweep();
  const snapshot = useForceSnapshot();
  const [custom, setCustom] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function report(err: unknown, fallback: string) {
    setOutcome({ tone: "error", text: err instanceof ApiError ? err.message : fallback });
  }

  function runRotate(code?: string) {
    setOutcome(null);
    rotate.mutate(code, {
      onSuccess: (result) => {
        setCustom("");
        setOutcome({
          tone: "ok",
          text: `New code is ${result.code}. The old one stopped working just now.`,
        });
      },
      onError: (err) => report(err, "Could not rotate the code."),
    });
  }

  return (
    <Panel title="Invite code">
      <div className="flex flex-col gap-3">
        <div>
          <div className="border border-line bg-canvas px-2 py-1.5">
            <span className="num text-lede tracking-[0.15em] text-accent">
              {invite.code ?? "Not set"}
            </span>
          </div>
          <p className="mt-1 text-[0.6875rem] text-ink-faint">
            {invite.source === "environment"
              ? "This is the code the server was deployed with. Rotating it moves the club onto a code you can change from here."
              : invite.updatedAt
                ? `Rotated ${stampET(invite.updatedAt)}.`
                : "Anyone with this code can create an account."}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-1.5">
          <div className="min-w-[9rem] flex-1">
            <Field
              id="invite-custom"
              label="Set a specific code"
              value={custom}
              onChange={setCustom}
              placeholder="Leave blank to generate"
            />
          </div>
          <ArmedButton
            label={custom.trim() ? "Set code" : "Rotate"}
            armedLabel="Replace it"
            onConfirm={() => runRotate(custom.trim() || undefined)}
            pending={rotate.isPending}
          />
        </div>

        <Feedback outcome={outcome} />

        <div className="border-t border-line pt-2">
          <Readout label="Tradable symbols">
            {universe.count > 0 ? universe.count.toLocaleString("en-US") : "Never synced"}
          </Readout>
          <Readout label="Last sync">
            {universe.syncedAt ? stampET(universe.syncedAt) : "—"}
          </Readout>

          {/*
            All three run on a cron already. They are here for the morning
            someone asks why a newly listed ticker is missing, or why a limit
            order has not filled yet — the answer is usually "wait a minute",
            and this is how you check without waiting one.

            None is armed, because none can do damage: a resync rewrites a list,
            a sweep does what the next minute would do anyway, and the snapshot
            upserts on (portfolio_id, as_of), so pressing it twice writes the
            same row twice rather than doubling the club's history.
          */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <ActionButton
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: (result) =>
                    setOutcome({
                      tone: "ok",
                      text: `Synced ${result.count.toLocaleString("en-US")} tradable symbols.`,
                    }),
                  onError: (err) => report(err, "Could not sync the asset list."),
                })
              }
              pending={sync.isPending}
            >
              Sync symbols
            </ActionButton>
            <ActionButton
              onClick={() =>
                sweep.mutate(undefined, {
                  onSuccess: (result) =>
                    setOutcome({
                      tone: "ok",
                      text: `Sweep: ${result.filled} filled, ${result.expired} expired, ${result.resting} still resting.`,
                    }),
                  onError: (err) => report(err, "Could not run the sweep."),
                })
              }
              pending={sweep.isPending}
            >
              Sweep orders
            </ActionButton>
            <ActionButton
              onClick={() =>
                snapshot.mutate(undefined, {
                  onSuccess: (result) =>
                    setOutcome({
                      tone: result.ran ? "ok" : "error",
                      text: result.ran
                        ? `Snapshot ${result.asOf}: ${result.portfolios} portfolios recorded.`
                        : (result.reason ?? "Nothing to record."),
                    }),
                  onError: (err) => report(err, "Could not run the snapshot."),
                })
              }
              pending={snapshot.isPending}
            >
              Snapshot now
            </ActionButton>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * The two actions that restructure the club.
 *
 * Both are armed, and the reset also demands the season's name typed out. That
 * is not friction for its own sake: a reset deletes every fill and position in
 * the season, and the only confirmation worth anything is one the officer has
 * to produce themselves.
 */
function LifecyclePanel({
  season,
  members,
}: {
  season: ReturnType<typeof useAdminOverview>["activeSeason"];
  members: number;
}) {
  const create = useCreateSeason();
  const reset = useResetSeason();
  const [name, setName] = useState("");
  const [cash, setCash] = useState("100000");
  const [confirm, setConfirm] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function report(err: unknown, fallback: string) {
    setOutcome({ tone: "error", text: err instanceof ApiError ? err.message : fallback });
  }

  return (
    <Panel title="Season lifecycle">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Field
            id="new-season-name"
            label="New season name"
            value={name}
            onChange={setName}
            placeholder="2027-2028 Season"
          />
          <Field
            id="new-season-cash"
            label="Starting cash"
            value={cash}
            onChange={setCash}
            numeric
            prefix="$"
            hint={
              season
                ? `Ends ${season.name} and funds all ${members} member${
                    members === 1 ? "" : "s"
                  } in the new one. Nothing from the old season is deleted.`
                : `Funds all ${members} member${members === 1 ? "" : "s"} immediately.`
            }
          />
          <div>
            <ArmedButton
              label="Start season"
              armedLabel={season ? "End and start" : "Start it"}
              onConfirm={() => {
                setOutcome(null);
                create.mutate(
                  { name: name.trim(), startingCash: Number(cash) },
                  {
                    onSuccess: (result) => {
                      setName("");
                      setOutcome({
                        tone: "ok",
                        text: `${result.name} is live with ${result.portfolios} portfolio${
                          result.portfolios === 1 ? "" : "s"
                        }.`,
                      });
                    },
                    onError: (err) => report(err, "Could not start the season."),
                  },
                );
              }}
              disabled={name.trim().length === 0 || !(Number(cash) > 0)}
              pending={create.isPending}
            />
          </div>
        </div>

        {season && (
          <div className="border-t border-line pt-2">
            <Field
              id="reset-confirm"
              label="Reset this season"
              value={confirm}
              onChange={setConfirm}
              placeholder={season.name}
              hint={`Deletes every fill, position and resting order in ${season.name} and re-funds everyone at ${money(
                season.startingCash,
              )}. Type the season's name to enable it.`}
            />
            <div className="mt-2">
              <ArmedButton
                label="Reset season"
                armedLabel="Delete it all"
                onConfirm={() => {
                  setOutcome(null);
                  reset.mutate(
                    { id: season.id, confirm: confirm.trim() },
                    {
                      onSuccess: (result) => {
                        setConfirm("");
                        setOutcome({
                          tone: "ok",
                          text: `Reset ${result.portfolios} portfolio${
                            result.portfolios === 1 ? "" : "s"
                          }, removing ${result.tradesDeleted} fill${
                            result.tradesDeleted === 1 ? "" : "s"
                          }.`,
                        });
                      },
                      onError: (err) => report(err, "Could not reset the season."),
                    },
                  );
                }}
                disabled={confirm.trim() !== season.name}
                pending={reset.isPending}
              />
            </div>
          </div>
        )}

        <Feedback outcome={outcome} />
      </div>
    </Panel>
  );
}
