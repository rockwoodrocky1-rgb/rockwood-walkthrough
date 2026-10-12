import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { CloudRow } from "../src/cloud";

const ink = rgb(0.17, 0.2, 0.16);
const muted = rgb(0.39, 0.42, 0.37);
const cream = rgb(0.97, 0.96, 0.93);
const margin = 48,
  width = 612,
  height = 792,
  contentWidth = width - margin * 2;

export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
) {
  const supported = new Set(font.getCharacterSet());
  const safe = [
    ...text.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " "),
  ]
    .map((c) => (c === "\n" || supported.has(c.codePointAt(0)!) ? c : "?"))
    .join("");
  const lines: string[] = [];
  for (const paragraph of safe.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > maxWidth) {
        lines.push(line);
        line = "";
      }
      for (const char of line ? ` ${word}` : word) {
        if (line && font.widthOfTextAtSize(line + char, size) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function createReportPdf(input: {
  row: CloudRow;
  projectName: string;
  isSampleProject: boolean;
  reportUrl: string;
  photos: Uint8Array[];
}): Promise<Uint8Array> {
  const { row, photos, projectName, reportUrl } = input;
  const report = row.payload.report;
  if (!report || photos.length !== row.payload.photos.length)
    throw new Error("Incomplete report evidence.");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes, logoBytes] = await Promise.all([
    readFile(join(process.cwd(), "server/assets/NotoSans-Regular.ttf")),
    readFile(join(process.cwd(), "server/assets/NotoSans-Bold.ttf")),
    readFile(join(process.cwd(), "public/brand/rockwood-logo.png")),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const logo = await pdf.embedPng(logoBytes);
  pdf.setTitle(`Rockwood - ${projectName} - Walkthrough report`);
  pdf.setAuthor("Rockwood Development");
  pdf.setCreator("Rockwood Walkthrough");
  const generated = new Date(report.generatedAt);
  const date = Number.isFinite(generated.getTime())
    ? generated
    : new Date(row.started_at);
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  let page = pdf.addPage([width, height]);
  let y = 678;
  function header() {
    page.drawRectangle({
      x: 0,
      y: height - 91,
      width,
      height: 91,
      color: cream,
    });
    page.drawImage(logo, {
      x: margin,
      y: height - 68,
      width: 174,
      height: (174 * 158) / 578,
    });
    page.drawText("SITE WALKTHROUGH", {
      x: 392,
      y: height - 48,
      size: 9,
      font: bold,
      color: muted,
    });
    y = 678;
  }
  header();
  function newPage() {
    page = pdf.addPage([width, height]);
    header();
  }
  function room(needed: number) {
    if (y - needed < 64) newPage();
  }
  function paragraph(text: string, size = 10, font = regular, color = ink) {
    for (const line of wrapText(text, font, size, contentWidth)) {
      room(size * 1.5);
      page.drawText(line, { x: margin, y, size, font, color });
      y -= size * 1.5;
    }
    y -= 7;
  }
  function heading(text: string) {
    room(55);
    y -= 12;
    paragraph(text, 15, bold);
  }
  function references(item: {
    photoIds: string[];
    transcriptSegmentIds: string[];
    noteIds: string[];
  }) {
    const labels = item.photoIds.map((id) => {
      const i = row.payload.photos.findIndex((p) => p.id === id);
      return i < 0 ? "Unmatched photo reference" : `Photo ${i + 1}`;
    });
    if (item.transcriptSegmentIds.length)
      labels.push("Narration (see saved report)");
    if (item.noteIds.length) labels.push("User notes");
    return labels.length
      ? `Sources: ${labels.join("; ")}`
      : "No source linked - verify before relying on this item.";
  }
  paragraph("Site Walkthrough Report", 25, bold);
  paragraph(projectName, 18, bold);
  paragraph(
    `${input.isSampleProject ? "TEST / FICTIONAL PROJECT  |  " : ""}${report.mode.toUpperCase()}  |  ${report.reviewStatus.toUpperCase()}`,
    9,
    bold,
    muted,
  );
  paragraph(
    `Visit: ${new Date(row.started_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" })} Eastern`,
    10,
  );
  paragraph(
    `Saved revision ${row.revision}  |  ${photos.length} photos`,
    9,
    regular,
    muted,
  );
  paragraph(
    "This PDF is the report as first created. The online report contains later edits, original photos, audio and notes. Drafts require review; observations do not certify work or safety compliance.",
    9,
    regular,
    muted,
  );
  room(38);
  page.drawText("Open saved report and original photos", {
    x: margin,
    y,
    size: 11,
    font: bold,
    color: ink,
  });
  page.node.addAnnot(
    pdf.context.register(
      pdf.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [margin, y - 3, margin + contentWidth, y + 14],
        Border: [0, 0, 0],
        A: {
          Type: "Action",
          S: PDFName.of("URI"),
          URI: PDFString.of(reportUrl),
        },
      }),
    ),
  );
  y -= 29;
  heading("Visit summary");
  paragraph(report.summary);
  heading("Observations");
  if (!report.observations.length) paragraph("No observations recorded.");
  for (const [i, item] of report.observations.entries()) {
    room(65);
    paragraph(
      `${i + 1}. ${item.area} / ${item.state.replaceAll("_", " ")}`,
      10,
      bold,
    );
    paragraph(item.description);
    paragraph(
      `${references(item)}${item.needsVerification ? " Verification needed." : ""}`,
      8,
      regular,
      muted,
    );
  }
  heading("Actions and questions");
  if (!report.actionItems.length) paragraph("No actions recorded.");
  for (const [i, item] of report.actionItems.entries()) {
    room(65);
    paragraph(`${i + 1}. ${item.area} / ${item.status}`, 10, bold);
    paragraph(item.task);
    paragraph(
      `Assignee: ${item.assignee || "Unassigned"} | Due: ${item.dueDateText || "Not set"} | Priority: ${item.priority}`,
      9,
      regular,
      muted,
    );
    if (item.suggestedTrade)
      paragraph(`Suggested trade: ${item.suggestedTrade}`, 9);
    paragraph(
      `${references(item)}${item.needsConfirmation ? " Confirmation needed." : ""}`,
      8,
      regular,
      muted,
    );
  }
  for (const [i, photo] of row.payload.photos.entries()) {
    newPage();
    paragraph(`Photo ${i + 1} / ${photo.area}`, 17, bold);
    paragraph(
      `Captured ${new Date(photo.capturedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern`,
      9,
      regular,
      muted,
    );
    const bytes = photos[i];
    const image =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? await pdf.embedJpg(bytes)
        : await pdf.embedPng(bytes);
    const scaled = image.scale(
      Math.min(contentWidth / image.width, 375 / image.height),
    );
    page.drawRectangle({
      x: margin,
      y: y - 375,
      width: contentWidth,
      height: 375,
      color: cream,
    });
    page.drawImage(image, {
      x: margin + (contentWidth - scaled.width) / 2,
      y: y - 375 + (375 - scaled.height) / 2,
      width: scaled.width,
      height: scaled.height,
    });
    y -= 397;
    const caption = report.captions.find(
      (c) => c.photoId === photo.id,
    )?.caption;
    if (caption) paragraph(caption, 11, bold);
    if (photo.note) paragraph(`Photo note: ${photo.note}`, 9);
    const linked = report.observations.flatMap((o, n) =>
      o.photoIds.includes(photo.id) ? [n + 1] : [],
    );
    paragraph(
      linked.length
        ? `Linked observations: ${linked.join(", ")}`
        : "No observation linked to this photo.",
      8,
      regular,
      muted,
    );
  }
  for (const [i, p] of pdf.getPages().entries()) {
    p.drawLine({
      start: { x: margin, y: 44 },
      end: { x: width - margin, y: 44 },
      thickness: 0.5,
      color: muted,
    });
    p.drawText("ROCKWOOD DEVELOPMENT  /  PRIVATE SITE RECORD", {
      x: margin,
      y: 29,
      size: 7,
      font: regular,
      color: muted,
    });
    p.drawText(`${i + 1} / ${pdf.getPageCount()}`, {
      x: 520,
      y: 29,
      size: 8,
      font: regular,
      color: muted,
    });
  }
  return pdf.save();
}
