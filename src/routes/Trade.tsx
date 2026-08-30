import { PhaseStub } from "@/components/terminal/PhaseStub";

export function Trade() {
  return (
    <PhaseStub
      title="Order entry"
      phase={4}
      summary="Where members place orders. Every fill is priced by the Worker at the moment it executes, so a client cannot post its own price."
      items={[
        "Ticker autocomplete backed by Alpaca's tradable asset list",
        "Buy, sell, short and cover, entered in shares or dollars",
        "Live cost preview and resulting buying power before you confirm",
        "Reg T check on shorts: 1.5x the position is held as margin",
        "Trade blotter with realised P/L on every closing fill",
      ]}
    />
  );
}
