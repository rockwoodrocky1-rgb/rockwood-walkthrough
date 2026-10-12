"use client";
import { useEffect, useState } from "react";
import type { Session as AuthSession } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { configureStorage } from "./storage";
import { Header, Notice } from "./ui";
import App from "./App";
import type { WorkspaceAccess } from "./cloud";

type Props = { logoAvailable: boolean; initialLiveAiEnabled: boolean };
export default function CloudGate(props: Props) {
  const [client] = useState(getSupabase);
  const [access, setAccess] = useState<WorkspaceAccess>();
  const [checking, setChecking] = useState(!!client);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!client) return;
    let generation = 0;
    let alive = true;
    let establishedUser = "";
    async function resolve(session: AuthSession | null) {
      if (session?.user.id === establishedUser) return;
      establishedUser = "";
      const current = ++generation;
      setAccess(undefined);
      setSignedIn(!!session);
      setChecking(!!session);
      if (!session) return;
      try {
        const {
          data: { user },
          error: userError,
        } = await client!.auth.getUser();
        if (userError || !user || !user.email_confirmed_at || user.is_anonymous)
          throw new Error("Please sign in with a verified email address.");
        const claim = await client!.rpc("claim_workspace_access");
        if (claim.error)
          throw new Error(
            "Rockwood access could not be checked. Please retry when connected.",
          );
        const membership = await client!
          .from("workspace_members")
          .select("workspace_id,role,workspaces(name)")
          .eq("user_id", user.id)
          .limit(2);
        if (membership.error)
          throw new Error("Could not load your workspace. Please retry.");
        if (!membership.data?.length)
          throw new Error(
            "Your account is signed in, but a Rockwood owner still needs to give you workspace access.",
          );
        if (membership.data.length !== 1)
          throw new Error(
            "This account belongs to multiple workspaces. Ask the administrator to configure the Rockwood workspace.",
          );
        const member = membership.data[0];
        const projects = await client!
          .from("projects")
          .select("id,name,type,stage,areas,image,number")
          .eq("workspace_id", member.workspace_id)
          .order("number");
        if (projects.error || !projects.data?.length)
          throw new Error("No projects are available in this workspace yet.");
        if (!alive || current !== generation) return;
        configureStorage(`${member.workspace_id}-${user.id}`);
        establishedUser = user.id;
        setMessage("");
        const workspace = member.workspaces as unknown as {
          name: string;
        } | null;
        setAccess({
          client: client!,
          workspaceId: member.workspace_id,
          workspaceName: workspace?.name ?? "Rockwood Development",
          userId: user.id,
          email: user.email ?? "",
          role: member.role,
          projects: projects.data,
          signOut: async () => {
            const result = await client!.auth.signOut({ scope: "local" });
            if (result.error)
              throw new Error("Could not sign out. Please retry.");
            setAccess(undefined);
          },
        });
      } catch (error) {
        if (alive && current === generation)
          setMessage(
            error instanceof Error
              ? error.message
              : "Could not connect to Rockwood.",
          );
      } finally {
        if (alive && current === generation) setChecking(false);
      }
    }
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (
        event === "INITIAL_SESSION" ||
        event === "SIGNED_IN" ||
        event === "SIGNED_OUT"
      ) {
        // SDK callbacks must finish before issuing another Auth request.
        setTimeout(() => {
          if (alive) void resolve(session);
        }, 0);
      }
    });
    return () => {
      alive = false;
      generation++;
      data.subscription.unsubscribe();
    };
  }, [client, attempt]);
  if (!client) return <App {...props} />;
  if (access)
    return (
      <App
        key={`${access.workspaceId}:${access.userId}`}
        {...props}
        cloud={access}
      />
    );
  return (
    <>
      <Header
        logoAvailable={props.logoAvailable}
        home={() => {}}
        storageLabel="Private workspace"
      />
      <main className="page auth-page">
        <p className="eyebrow">ROCKWOOD DEVELOPMENT</p>
        <h1>
          Your fieldwork.
          <br />
          One shared place.
        </h1>
        <p>Sign in to open your team’s projects, photos, notes, and reports.</p>
        {checking ? (
          <Notice>Connecting to Rockwood…</Notice>
        ) : (
          <>
            {message && <Notice tone="warning">{message}</Notice>}
            {signedIn ? (
              <div className="button-row">
                <button
                  className="button primary"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Retry connection
                </button>
                <button
                  className="button"
                  onClick={() => void client.auth.signOut({ scope: "local" })}
                >
                  Use another account
                </button>
              </div>
            ) : (
              <form
                className="auth-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  setMessage("");
                  try {
                    const result = await client.auth.signInWithOtp({
                      email: email.trim(),
                      options: {
                        emailRedirectTo: `${location.origin}/`,
                        shouldCreateUser: true,
                      },
                    });
                    if (result.error) throw result.error;
                    setSent(true);
                  } catch {
                    setMessage(
                      "The sign-in email could not be sent. Wait a minute and retry. If this continues, ask the Rockwood administrator to check email delivery and workspace access.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setSent(false);
                    }}
                    placeholder="you@company.com"
                  />
                </label>
                <button className="button primary" disabled={busy}>
                  {busy
                    ? "Sending…"
                    : sent
                      ? "Send another sign-in link"
                      : "Email me a sign-in link"}
                </button>
                {sent && (
                  <Notice tone="success">
                    Check your email and open the Rockwood sign-in link. Only
                    accounts approved by a workspace owner can access project
                    data.
                  </Notice>
                )}
              </form>
            )}
          </>
        )}
        <p className="small muted">
          Workspace access is managed by Rockwood. Signing in does not grant
          Supabase dashboard access.
        </p>
      </main>
    </>
  );
}
