import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Fonts are bundled rather than loaded from Google, so the terminal renders
// identically on a school network that blocks third-party font hosts.
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import "./styles/terminal.css";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Quotes carry their own 20s interval. Everything else is fresh enough
      // for a minute and should not refetch on every window focus.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
