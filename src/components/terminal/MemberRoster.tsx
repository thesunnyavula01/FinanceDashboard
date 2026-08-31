import { useState } from "react";
import { Panel } from "./Panel";
import { DataGrid, type Column } from "./DataGrid";
import { Value } from "./Value";
import { ActionButton, Feedback, type Outcome } from "./AdminControls";
import { useSetRole } from "@/hooks/useAdmin";
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
}: {
  members: AdminMember[];
  currentUserId: string | undefined;
}) {
  const setRole = useSetRole();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const officers = members.filter((member) => member.role === "admin").length;

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
      sortValue: (m) => m.joinedAt,
      render: (m) => <span className="num text-ink-faint">{stampET(m.joinedAt)}</span>,
    },
    {
      key: "startingCash",
      header: "Funded with",
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
