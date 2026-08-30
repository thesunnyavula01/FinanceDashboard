import { PhaseStub } from "@/components/terminal/PhaseStub";

export function Sectors() {
  return (
    <PhaseStub
      title="Sector exposure"
      phase={5}
      summary="Where the money actually sits. Sectors come from Finnhub, looked up once per ticker and then cached permanently."
      items={[
        "Exposure by GICS sector, with ETFs bucketed separately",
        "Concentration warning when one sector passes 40 percent",
        "Equity curve against SPY, QQQ and the club average",
        "Club-wide sector view so the group can see its collective bias",
      ]}
    />
  );
}
