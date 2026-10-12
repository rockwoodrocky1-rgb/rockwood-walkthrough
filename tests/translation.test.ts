import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { participantSchema } from "../shared/participant";
import {
  applyEnglishText,
  reportTextSlots,
  translateReportContent,
} from "../server/translation";
import { createSample } from "../src/sample";
import { projects } from "../shared/model";
import { cloudRowSchema, canEditSession } from "../src/cloud";
import { translate } from "../src/i18n";
import { shareToken, validShareToken } from "../server/report-share";
import { POST } from "../app/api/translate-report/route";

describe("Contact entry and bilingual reports", () => {
  it("accepts real-world contact formatting without treating it as verified identity", () => {
    expect(
      participantSchema.parse({
        name: "  Ana García ",
        phone: "+1 (305) 555-0123",
      }),
    ).toEqual({ name: "Ana García", phone: "+13055550123" });
    for (const phone of ["", "123", "+1--bad", "1234567890123456", "<script>"])
      expect(participantSchema.safeParse({ name: "Ana", phone }).success).toBe(
        false,
      );
  });
  it("translates controls and template values, leaving unknown source evidence untouched", () => {
    expect(translate("es", "Start walkthrough")).toBe("Iniciar recorrido");
    expect(translate("es", "Open {project}", { project: "Coral Gables" })).toBe(
      "Abrir Coral Gables",
    );
    expect(translate("en", "Start walkthrough")).toBe("Start walkthrough");
    expect(translate("es", "Rockwood project XYZ")).toBe(
      "Rockwood project XYZ",
    );
  });
  it("preserves evidence IDs, statuses, priorities, assignees and the original Spanish input", async () => {
    const report = structuredClone(createSample(projects[0]).report!);
    report.summary = "No se ha terminado el sellado.";
    const original = structuredClone(report);
    const slots = reportTextSlots(report);
    const parse = vi
      .fn()
      .mockResolvedValue({
        status: "completed",
        output_parsed: {
          values: slots.map((s) => ({
            ...s,
            text:
              s.id === "summary" ? "Caulking has not been completed." : s.text,
          })),
        },
      });
    const result = await translateReportContent(report, {
      responses: { parse },
    } as unknown as OpenAI);
    expect(result.summary).toBe("Caulking has not been completed.");
    expect(result.observations).toEqual(report.observations);
    expect(result.actionItems).toEqual(report.actionItems);
    expect(report).toEqual(original);
    expect(parse.mock.calls[0][0].store).toBe(false);
    expect(parse.mock.calls[0][0].instructions).toContain("untrusted data");
  });
  it("rejects missing, duplicated and invented slots instead of saving partial translations", () => {
    const report = createSample(projects[0]).report!;
    const slots = reportTextSlots(report);
    expect(() => applyEnglishText(report, slots.slice(1))).toThrow(
      "Incomplete",
    );
    expect(() =>
      applyEnglishText(report, [slots[0], ...slots.slice(0, -1)]),
    ).toThrow("Incomplete");
    expect(() =>
      applyEnglishText(report, [
        ...slots.slice(1),
        { id: "invented", text: "Fabricated" },
      ]),
    ).toThrow("Incomplete");
  });
  it("fails closed without translation configuration and never fabricates English", async () => {
    vi.stubEnv("LIVE_AI_ENABLED", "false");
    try {
      const result = await POST(
        new Request("http://localhost/api/translate-report", {
          method: "POST",
          body: "{}",
        }),
      );
      expect(result.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("roundtrips source language, author contact and report output language through cloud payloads", () => {
    const sample = createSample(projects[0]);
    const row = cloudRowSchema.parse({
      id: sample.id,
      project_id: sample.projectId,
      workspace_id: "workspace",
      created_by: "visitor",
      started_at: sample.startedAt,
      updated_at: sample.startedAt,
      revision: 1,
      archived_at: null,
      payload: {
        duration: 0,
        status: "saved",
        notes: "Notas originales",
        mime: "",
        photos: [],
        language: "es",
        participant: { name: "Ana García", phone: "3055550123" },
        report: { ...sample.report, outputLanguage: "en" },
      },
    });
    expect(row.payload.notes).toBe("Notas originales");
    expect(row.payload.participant?.name).toBe("Ana García");
    expect(row.payload.report?.outputLanguage).toBe("en");
    const access = { role: "contributor", userId: "visitor" } as Parameters<
      typeof canEditSession
    >[0];
    expect(
      canEditSession(access, {
        ...sample,
        cloud: { createdBy: "visitor", revision: 1, pending: false },
      }),
    ).toBe(true);
    expect(
      canEditSession(access, {
        ...sample,
        cloud: { createdBy: "another", revision: 1, pending: false },
      }),
    ).toBe(false);
  });
});

describe("Read-only report links", () => {
  it("restricts a link to one workspace and visit and rejects tampering or key changes", () => {
    const token = shareToken("workspace-a", "visit-a", "test-secret");
    expect(
      validShareToken("workspace-a", "visit-a", token, "test-secret"),
    ).toBe(true);
    expect(
      validShareToken("workspace-b", "visit-a", token, "test-secret"),
    ).toBe(false);
    expect(
      validShareToken("workspace-a", "visit-b", token, "test-secret"),
    ).toBe(false);
    expect(
      validShareToken("workspace-a", "visit-a", token, "rotated-secret"),
    ).toBe(false);
    expect(
      validShareToken("workspace-a", "visit-a", "bad", "test-secret"),
    ).toBe(false);
  });
});
