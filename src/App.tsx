import { Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { StatusRail } from "@/components/terminal/StatusRail";
import { FunctionNav } from "@/components/terminal/FunctionNav";
import { CommandBar } from "@/components/terminal/CommandBar";
import { Positions } from "@/routes/Positions";
import { Trade } from "@/routes/Trade";
import { Leaderboard } from "@/routes/Leaderboard";
import { Sectors } from "@/routes/Sectors";
import { Admin } from "@/routes/Admin";
import { NotFound } from "@/routes/NotFound";

export function App() {
  // Doubles as the SPA-to-Worker heartbeat: if this query fails, the rail
  // reports the API as unreachable instead of showing a stale session state.
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <div className="flex h-full flex-col bg-canvas">
      <StatusRail
        appName={data?.app ?? "FINANCE CLUB TERMINAL"}
        session={data?.session.state ?? "CLOSED"}
        sessionLabel={data?.session.label ?? "Connecting"}
        authoritative={data?.session.authoritative ?? true}
        connected={!isError}
      />

      <FunctionNav />

      <main className="min-h-0 flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Positions />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/sectors" element={<Sectors />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <CommandBar />
    </div>
  );
}
