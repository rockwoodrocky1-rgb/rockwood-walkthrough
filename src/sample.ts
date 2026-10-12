import { type Project, type Session } from "../shared/model";
export function createSample(project: Project): Session {
  const id = `sample-${project.id}`;
  const area = project.areas[1];
  const isBathroom = project.id === "coral-gables";
  const descriptions = isBathroom
    ? [
        "The primary bathroom vanity is installed.",
        "The shower still needs caulking.",
        "Have the tile contractor review the niche alignment before handover.",
      ]
    : project.id === "doral-office"
      ? [
          "Conference room partitions are reported installed.",
          "The finish touch-ups remain outstanding.",
          "Confirm the location of the meeting room display before installation.",
        ]
      : [
          "Second floor framing is reported in place.",
          "The remaining rough-in work needs a progress review.",
          "Confirm the next inspection requirements with the project team.",
        ];
  const segments = descriptions.map((text, i) => ({
    id: `sample-segment-${i}`,
    text,
    start: i * 8,
    end: i * 8 + 7,
  }));
  return {
    id,
    projectId: project.id,
    startedAt: "2026-10-12T14:00:00.000Z",
    duration: 24,
    status: "saved",
    photos: [],
    notes: "Fictional demonstration. No site visit took place.",
    mime: "",
    transcript: { text: descriptions.join(" "), segments, source: "sample" },
    report: {
      id: `report-${id}`,
      sessionId: id,
      projectId: project.id,
      generatedAt: "2026-10-12T14:00:24.000Z",
      mode: "sample",
      reviewStatus: "draft",
      summary: isBathroom
        ? "The illustrative visit covers finishing work in the primary bathroom. Vanity installation is reported complete; shower caulking remains outstanding. A review of the niche alignment has been requested before handover. No alignment defect has been confirmed."
        : `This fictional walkthrough records progress in the ${area.toLowerCase()}. One item is reported complete, one remains outstanding, and a follow-up requires confirmation. These examples demonstrate report organization; they are not findings about a Rockwood project.`,
      observations: descriptions.map((description, i) => ({
        id: `sample-observation-${i}`,
        area,
        description,
        basis: "narration",
        state: (
          ["reported_complete", "outstanding", "requested_review"] as const
        )[i],
        photoIds: [],
        transcriptSegmentIds: [segments[i].id],
        noteIds: [],
        needsVerification: true,
      })),
      actionItems: [
        {
          id: "sample-action-1",
          area,
          task: isBathroom ? "Complete the shower caulking." : descriptions[1],
          category: "outstanding",
          observationIds: ["sample-observation-1"],
          photoIds: [],
          transcriptSegmentIds: [segments[1].id],
          noteIds: [],
          priority: "unassigned",
          suggestedTrade: null,
          assignee: null,
          dueDateText: null,
          status: "open",
          needsConfirmation: false,
        },
        {
          id: "sample-action-2",
          area,
          task: isBathroom
            ? "Ask the tile contractor to review niche alignment before handover. This is a requested review, not a confirmed defect."
            : descriptions[2],
          category: "next_step",
          observationIds: ["sample-observation-2"],
          photoIds: [],
          transcriptSegmentIds: [segments[2].id],
          noteIds: [],
          priority: "unassigned",
          suggestedTrade: isBathroom ? "Tile contractor" : null,
          assignee: null,
          dueDateText: null,
          status: "open",
          needsConfirmation: true,
        },
        {
          id: "sample-question",
          area,
          task: "Who will own these follow-ups, and when should they be revisited?",
          category: "question",
          observationIds: [],
          photoIds: [],
          transcriptSegmentIds: [],
          noteIds: [],
          priority: "unassigned",
          suggestedTrade: null,
          assignee: null,
          dueDateText: null,
          status: "open",
          needsConfirmation: true,
        },
      ],
      captions: [],
    },
  };
}
