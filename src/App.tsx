import { Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StatusRail } from "@/components/terminal/StatusRail";
import { FunctionNav } from "@/components/terminal/FunctionNav";
import { CommandBar } from "@/components/terminal/CommandBar";
import { Login } from "@/routes/Login";
import { Positions } from "@/routes/Positions";
import { Trade } from "@/routes/Trade";
import { Leaderboard } from "@/routes/Leaderboard";
import { Sectors } from "@/routes/Sectors";
import { Admin } from "@/routes/Admin";
import { Legal } from "@/routes/Legal";
import { NotFound } from "@/routes/NotFound";

export function App() {
  const { session, loading, signOut } = useAuth();

  // Doubles as the SPA-to-Worker heartbeat: if this query fails, the rail
  // reports the API as unreachable instead of showing a stale session state.
  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: me } = useQuery({
    queryKey: ["me", session?.user.id],
    queryFn: api.me,
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });

  // Reading the stored session is fast but not instant. Rendering the login
  // screen first and then yanking it away would flash on every reload.
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <span className="label pulse-dot">Loading</span>
      </div>
    );
  }

  // Signed out, every address is the login screen — with one exception. The
  // terms and the privacy policy have to be readable *before* there is an
  // account to agree to them with, and the sign-up form links straight to them.
  if (!session) {
    return (
      <Routes>
        <Route path="/legal" element={<Legal />} />
        <Route path="/legal/:doc" element={<Legal />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <StatusRail
        appName={health?.app ?? "FINANCE CLUB TERMINAL"}
        session={health?.session.state ?? "CLOSED"}
        sessionLabel={health?.session.label ?? "Connecting"}
        authoritative={health?.session.authoritative ?? true}
        connected={!isError}
        displayName={me?.displayName}
        role={me?.role}
        onSignOut={signOut}
      />

      <FunctionNav isAdmin={me?.role === "admin"} />

      <main className="min-h-0 flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Positions />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/sectors" element={<Sectors />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/legal" element={<Legal />} />
          <Route path="/legal/:doc" element={<Legal />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <CommandBar isAdmin={me?.role === "admin"} />
    </div>
  );
}
