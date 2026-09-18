import { useState } from "react";
import { Panel } from "./Panel";
import { DataGrid, type Column } from "./DataGrid";
import { Value } from "./Value";
import { ActionButton, Feedback, type Outcome } from "./AdminControls";
import { useFundMissingMembers, useSetRole } from "@/hooks/useAdmin";
import { ApiError, type AdminMember } from "@/lib/api";
import { money, stampET } from "@/lib/format";

/**
 * Who is in the club, and who can run it.
 *
 * The only action here is the role, and it is deliberately not armed: making
 * someone an officer is reversible in one click, and treating it as dangerous
 * would spend the console's one alarm on the thing that is not.
 *
 * The database refuses to remove the last officer. This screen does not
 * duplicate that check — two officers demoting each other from two laptops
 * would both read "there is another admin" and both be right until they
 * committed. The refusal comes back as a sentence and is shown as one.
 */
export function MemberRoster({
  members,
  currentUserId,
  activeSeasonId,
}: {
  members: AdminMember[];
  currentUserId: string | undefined;
  /** The season a repaired member would be funded into. Null with no season. */
  activeSeasonId?: string | null;
}) {
  const setRole = useSetRole();
  const fundMissing = useFundMissingMembers();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const officers = members.filter((member) => member.role === "admin").length;

  // A member with no portfolio in the active season is not a row that renders
  // badly on the leaderboard — they are not a row. This panel was already the
  // only place in the app that said so; it can now do something about it.
  const unfunded = members.filter((member) => member.portfolioId === null);

  function fundEveryone() {
    if (!activeSeasonId) return;
    setOutcome(null);

    fundMissing.mutate(activeSeasonId, {
      onSuccess: (result) =>
        setOutcome({
          tone: "ok",
          text:
            result.created === 0
              ? "Every member already had a portfolio in this season. Nothing changed."
              : `${result.created} member${result.created === 1 ? "" : "s"} funded. They are on the leaderboard now.`,
        }),
      onError: (err) =>
        setOutcome({
          tone: "error",
          text: err instanceof ApiError ? err.message : "Could not fund the missing members.",
        }),
    });
  }

  function changeRole(member: AdminMember) {
    const next = member.role === "admin" ? "member" : "admin";
    setWorking(member.userId);
    setOutcome(null);

    setRole.mutate(
      { userId: member.userId, role: next },
      {
        onSuccess: () => {
          setWorking(null);
          setOutcome({
            tone: "ok",
            text:
              next === "admin"
                ? `${member.displayName} can now run the club.`
                : `${member.displayName} is back to a regular member.`,
          });
        },
        onError: (err) => {
          setWorking(null);
          setOutcome({
            tone: "error",
            text: err instanceof ApiError ? err.message : "Could not change that role.",
          });
        },
      },
    );
  }

  const columns: Column<AdminMember>[] = [
    {
      key: "displayName",
      header: "Member",
      width: "14rem",
      sortValue: (m) => m.displayName,
      render: (m) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate text-ink">{m.displayName}</span>
          {m.userId === currentUserId && <span className="keycap">YOU</span>}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "6rem",
      sortValue: (m) => m.role,
      render: (m) => (
        <span className={m.role === "admin" ? "label text-accent" : "label label-ink"}>
          {m.role === "admin" ? "Officer" : "Member"}
        </span>
      ),
    },
    {
      key: "joinedAt",
      header: "Joined",
      width: "7rem",
      hideOnMobile: true,
      sortValue: (m) => m.joinedAt,
      render: (m) => <span className="num text-ink-faint">{stampET(m.joinedAt)}</span>,
    },
    {
      key: "startingCash",
      header: "Funded with",
      hideOnMobile: true,
      align: "right",
      width: "8rem",
      sortValue: (m) => m.startingCash ?? 0,
      // The member's own baseline, not the season's — an officer changing the
      // season default does not restate what anyone already trading was given,
      // and this column is where that becomes visible.
      render: (m) =>
        m.startingCash === null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Value value={m.startingCash} dim>
            {money(m.startingCash)}
          </Value>
        ),
    },
    {
      key: "cash",
      header: "Cash",
      align: "right",
      width: "8rem",
      sortValue: (m) => m.cash ?? 0,
      render: (m) =>
        m.cash === null ? (
          <span className="text-loss">No portfolio</span>
        ) : (
          <Value value={m.cash}>{money(m.cash)}</Value>
        ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "10rem",
      render: (m) => (
        <ActionButton
          onClick={() => changeRole(m)}
          pending={working === m.userId}
          // The database says no, but a button that is obviously going to fail
          // is worse than one that is not there to press.
          disabled={m.role === "admin" && officers <= 1}
          title={
            m.role === "admin" && officers <= 1
              ? "The club needs at least one officer. Promote someone else first."
              : undefined
          }
        >
          {m.role === "admin" ? "Make member" : "Make officer"}
        </ActionButton>
      ),
    },
  ];

  return (
    <Panel
      title="Members"
      meta={
        <span className="text-ink-dim">
          {members.length} member{members.length === 1 ? "" : "s"} · {officers} officer
          {officers === 1 ? "" : "s"}
        </span>
      }
      flush
    >
      {/*
        The result line sits under the header rather than in it: the panel's
        meta slot is styled as a label and uppercases what it holds, which is
        right for a count and wrong for a sentence.
      */}
      {/*
        Named, counted, and repairable in one press. A member without a
        portfolio is silently absent from F3 — which reads to everyone else as
        someone being deleted off the leaderboard — so the officer sees the
        count, the names are already red in the Cash column, and the fix is
        here rather than in the SQL editor.
      */}
      {unfunded.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-accent-dim bg-accent-wash px-2.5 py-1.5">
          <span className="label shrink-0 text-accent">Not on the leaderboard</span>
          <span className="text-ink-dim">
            {unfunded.length === 1
              ? `${unfunded[0]!.displayName} has no portfolio in this season, so they have no row in the standings.`
              : `${unfunded.length} members have no portfolio in this season, so they have no row in the standings.`}
          </span>
          <ActionButton
            tone="accent"
            onClick={fundEveryone}
            pending={fundMissing.isPending}
            disabled={!activeSeasonId}
            title={activeSeasonId ? undefined : "Start a season first."}
          >
            Fund {unfunded.length === 1 ? "them" : "them all"}
          </ActionButton>
        </div>
      )}

      {outcome && (
        <div className="border-b border-line px-2.5 py-1">
          <Feedback outcome={outcome} />
        </div>
      )}

      <DataGrid
        columns={columns}
        rows={members}
        rowKey={(m) => m.userId}
        defaultSort="joinedAt"
        defaultDirection="asc"
        empty="Nobody has signed up yet. Share the invite code."
      />
    </Panel>
  );
}
