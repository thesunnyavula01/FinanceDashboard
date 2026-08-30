import { PhaseStub } from "@/components/terminal/PhaseStub";

export function Leaderboard() {
  return (
    <PhaseStub
      title="Leaderboard"
      phase={6}
      summary="Every member's portfolio ranked by return, with each one's picks open to the whole club. Seeing what everyone else bought is the point."
      items={[
        "Rank, member, NAV, total return, day change and top holding",
        "Return measured against SPY, QQQ and the club average",
        "Click any member to open their portfolio read-only",
      ]}
    />
  );
}
