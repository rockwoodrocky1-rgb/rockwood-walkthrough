"use client";
import { useEffect, useRef, useState } from "react";
import { participantSchema, type Participant } from "../shared/participant";
import { getSupabase } from "./supabase";
import { configureStorage } from "./storage";
import type { WorkspaceAccess } from "./cloud";
import { Header, Notice } from "./ui";
import { useLanguage } from "./i18n";
import App from "./App";

type Props = { logoAvailable: boolean; initialLiveAiEnabled: boolean };
export default function FieldGate(props: Props) {
  const { t } = useLanguage();
  const [client] = useState(getSupabase);
  const activeIdentity = useRef("");
  const [access, setAccess] = useState<WorkspaceAccess>();
  const [participant, setParticipant] = useState<Participant>();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(true);
  // Restore this browser's write identity. Shared property reports are readable
  // by everyone in the workspace; a typed phone never claims another identity.
  useEffect(() => {
    let alive = true;
    async function restore() {
      try {
        if (client) {
          const auth = await client.auth.getSession();
          if (!auth.data.session) return;
          const result = await client
            .from("field_contacts")
            .select("name,phone")
            .eq("user_id", auth.data.session.user.id)
            .maybeSingle();
          if (result.data && alive) {
            const person = participantSchema.parse(result.data);
            const cloud = await loadAccess(person);
            if (alive) {
              setParticipant(person);
              setAccess(cloud);
            }
          }
        } else {
          const stored = sessionStorage.getItem("rockwood-field-demo-v1");
          if (stored) {
            const data = JSON.parse(stored);
            const person = participantSchema.parse(data.person);
            if (
              typeof data.id === "string" &&
              /^[a-f0-9-]{36}$/.test(data.id)
            ) {
              configureStorage(`field-demo-${data.id}`);
              if (alive) setParticipant(person);
            }
          }
        }
      } catch {
        /* A fresh form remains usable when a previous session expired. */
      } finally {
        if (alive) setChecking(false);
      }
    }
    const listener = client?.auth.onAuthStateChange((event, session) => {
      if (
        event === "SIGNED_OUT" ||
        (event === "SIGNED_IN" &&
          activeIdentity.current &&
          session?.user.id !== activeIdentity.current)
      ) {
        activeIdentity.current = "";
        setAccess(undefined);
        setParticipant(undefined);
      }
    });
    void restore();
    return () => {
      alive = false;
      listener?.data.subscription.unsubscribe();
    };
    // loadAccess reads the same immutable client; restore runs only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  async function loadAccess(person: Participant): Promise<WorkspaceAccess> {
    const auth = await client!.auth.getSession();
    const user = auth.data.session?.user;
    if (!user)
      throw new Error("Could not open your session. Please try again.");
    const membership = await client!
      .from("workspace_members")
      .select("workspace_id,role,workspaces(name)")
      .eq("user_id", user.id)
      .limit(2);
    if (membership.error || membership.data?.length !== 1)
      throw new Error(
        "Name and phone entry is not connected yet. Your details have not been submitted.",
      );
    const member = membership.data[0];
    const projects = await client!
      .from("projects")
      .select("id,name,type,stage,areas,image,number")
      .eq("workspace_id", member.workspace_id)
      .order("number");
    if (projects.error || !projects.data?.length)
      throw new Error("Could not load projects. Please try again.");
    activeIdentity.current = user.id;
    configureStorage(`${member.workspace_id}-${user.id}`);
    return {
      client: client!,
      workspaceId: member.workspace_id,
      workspaceName: "Rockwood Development",
      userId: user.id,
      email: user.email ?? "",
      role: member.role,
      participant: person,
      projects: projects.data,
      signOut: async () => {
        const result = await client!.auth.signOut({ scope: "local" });
        if (result.error)
          throw new Error("Could not end this session. Please try again.");
        setParticipant(undefined);
        setAccess(undefined);
        setName("");
        setPhone("");
        history.replaceState(null, "", location.pathname);
      },
    };
  }
  async function enter() {
    const result = participantSchema.safeParse({ name, phone });
    if (!result.success) {
      setMessage(
        "Enter your name and a valid phone number, including the country code if needed.",
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (client) {
        const auth = await client.auth.getSession();
        if (!auth.data.session) {
          const opened = await client.auth.signInAnonymously();
          if (opened.error)
            throw new Error(
              "Name and phone entry is not connected yet. Your details have not been submitted.",
            );
        }
        const registered = await client.rpc("register_field_contact", {
          contact_name: result.data.name,
          contact_phone: result.data.phone,
        });
        if (registered.error)
          throw new Error(
            "Could not save your contact details. Please try again.",
          );
        setAccess(await loadAccess(result.data));
      } else {
        const id = crypto.randomUUID();
        configureStorage(`field-demo-${id}`);
        sessionStorage.setItem(
          "rockwood-field-demo-v1",
          JSON.stringify({ id, person: result.data }),
        );
      }
      setParticipant(result.data);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (participant)
    return (
      <App
        {...props}
        participant={participant}
        cloud={access}
        leaveParticipant={() => {
          sessionStorage.removeItem("rockwood-field-demo-v1");
          setParticipant(undefined);
          setName("");
          setPhone("");
          history.replaceState(null, "", location.pathname);
        }}
      />
    );
  return (
    <>
      <Header
        logoAvailable={props.logoAvailable}
        home={() => {}}
        storageLabel="Site walkthrough"
      />
      <main className="page auth-page field-entry">
        <h1>{t("Start your visit")}</h1>
        {checking ? (
          <Notice>{t("Opening your session…")}</Notice>
        ) : (
          <form
            noValidate
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void enter();
            }}
          >
            <label>
              {t("Your name")}
              <input
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Full name")}
              />
            </label>
            <label>
              {t("Phone number")}
              <input
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                required
                maxLength={32}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (305) 555-0123"
              />
            </label>
            {message && <Notice tone="warning">{t(message)}</Notice>}
            <button className="button primary" disabled={busy}>
              {t(busy ? "Opening…" : "Continue")}
            </button>
            <p className="entry-access-note">
              {t("Your name appears on reports. Everyone on the team can view them.")}
            </p>
          </form>
        )}
        {!client && (
          <Notice>
            {t(
              "Branch preview: reports stay in this browser until shared storage is connected.",
            )}
          </Notice>
        )}
      </main>
    </>
  );
}
