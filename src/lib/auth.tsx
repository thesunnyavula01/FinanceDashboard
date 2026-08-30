import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
  inviteCode: string;
}

interface AuthContextValue {
  session: Session | null;
  /** True until the stored session has been read; routes must wait for this. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Surfaces a readable message instead of a raw fetch failure. */
class AuthProblem extends Error {}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) {
      // Supabase says "Invalid login credentials" for both a wrong password and
      // an unknown email, which is the right behaviour — it just needs saying
      // in words a member can act on.
      throw new AuthProblem(
        /invalid login/i.test(error.message)
          ? "That email and password do not match an account."
          : error.message,
      );
    }
  }, []);

  /**
   * Signup goes through the Worker, not Supabase directly: the invite code has
   * to be checked and the portfolio created in the same operation. On success
   * we sign in immediately, so there is no confirmation step at all.
   */
  const signUp = useCallback(async (input: SignUpInput) => {
    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        displayName: input.displayName.trim(),
        inviteCode: input.inviteCode.trim(),
      }),
    });

    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new AuthProblem(body?.error ?? `Signup failed (${response.status}).`);
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: input.email.trim().toLowerCase(),
      password: input.password,
    });
    if (error) {
      throw new AuthProblem(
        "Your account was created, but signing in failed. Try signing in.",
      );
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ session, loading, signIn, signUp, signOut }),
    [session, loading, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
