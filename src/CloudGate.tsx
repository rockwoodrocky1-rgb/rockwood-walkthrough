"use client";
import { LanguageProvider } from "./i18n";
import FieldGate from "./FieldGate";
export default function CloudGate(props: {
  logoAvailable: boolean;
  initialLiveAiEnabled: boolean;
}) {
  return (
    <LanguageProvider>
      <FieldGate {...props} />
    </LanguageProvider>
  );
}
