"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Language } from "../shared/participant";
import spanish from "./locales/es.json";
export function translate(
  language: Language,
  message: string,
  values: Record<string, string | number> = {},
) {
  const key = message.replace(/\s+/g, " ").trim();
  if (
    language === "es" &&
    /was interrupted or took too long|Could not reach the site to/.test(message)
  )
    return "Se interrumpió la conexión o se agotó el tiempo de espera. Tu recorrido está guardado. Mantén la página abierta e inténtalo de nuevo.";
  const text =
    language === "es"
      ? ((spanish as Record<string, string>)[key] ?? message)
      : message;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    String(values[name] ?? match),
  );
}
const Context = createContext({
  language: "en" as Language,
  locale: "en-US",
  setLanguage: (value: Language) => {
    void value;
  },
  t: (text: string, values?: Record<string, string | number>) =>
    translate("en", text, values),
});
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>("en");
  useEffect(() => {
    // Read the browser preference after hydration; no per-user state is cached on the server.
    try {
      if (localStorage.getItem("rockwood-language-v1") === "es") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLanguage("es");
      }
    } catch {
      /* The toggle works even when persistence is unavailable. */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = "Rockwood Cam";
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      locale: language === "es" ? "es-US" : "en-US",
      setLanguage: (next: Language) => {
        setLanguage(next);
        try {
          localStorage.setItem("rockwood-language-v1", next);
        } catch {
          /* Optional preference only. */
        }
      },
      t: (text: string, values?: Record<string, string | number>) =>
        translate(language, text, values),
    }),
    [language],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useLanguage() {
  return useContext(Context);
}
export function LanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <div
      className="language-toggle"
      role="group"
      aria-label="Language / Idioma"
    >
      <button
        type="button"
        lang="en"
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        English
      </button>
      <button
        type="button"
        lang="es"
        aria-pressed={language === "es"}
        onClick={() => setLanguage("es")}
      >
        Español
      </button>
    </div>
  );
}
