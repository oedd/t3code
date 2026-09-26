import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentId, PreviewAnnotationPayloadSchema, ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { buildMessageContext, asKnownContextRecord } from "~/lib/composerContextRecords";
import { buildPdfAnnotation, pdfAnnotationSource, pdfCropPixels, pdfRegion } from "./pdfRegion";

const isAnnotation = Schema.is(PreviewAnnotationPayloadSchema);

describe("PDF region capture", () => {
  it("normalizes reverse drags and clamps releases outside the page", () => {
    expect(pdfRegion({ x: 0.8, y: 0.75 }, { x: 0.2, y: 0.25 })).toEqual({
      x: 0.2,
      y: 0.25,
      width: 0.6000000000000001,
      height: 0.5,
    });
    expect(pdfRegion({ x: 0.25, y: 0.5 }, { x: -2, y: 3 })).toEqual({
      x: 0,
      y: 0.5,
      width: 0.25,
      height: 0.5,
    });
  });

  it("crops backing pixels at high DPI and rounds outward without crossing the page edge", () => {
    const region = pdfRegion({ x: 0.25, y: 0.5 }, { x: 1, y: 1 });
    expect(pdfCropPixels(region, 1200, 1600)).toEqual({ x: 300, y: 800, width: 900, height: 800 });
    expect(pdfCropPixels(region, 601, 801)).toEqual({ x: 150, y: 400, width: 451, height: 401 });
  });

  it("keeps documents with spaces, hashes and Unicode distinct", () => {
    expect(pdfAnnotationSource("C:/papers/cœur #2.pdf")).toBe(
      "pdf:C%3A%2Fpapers%2Fc%C5%93ur%20%232.pdf#page=",
    );
    expect(pdfAnnotationSource("attachment:a")).not.toBe(pdfAnnotationSource("attachment:b"));
  });
});

describe("PDF notes in a prompt", () => {
  const target = {
    environmentId: EnvironmentId.make("pdf-test"),
    threadId: ThreadId.make("pdf-notes"),
  };
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
  });

  it("stacks notes from different PDFs, binds each screenshot on send, and removes both together", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Compare these figures.");
    const notes = ["paper-a.pdf", "paper-b.pdf"].map((source, index) => {
      const note = buildPdfAnnotation({
        id: `pdf-${index}`,
        source,
        title: source,
        page: index + 2,
        comment: `  Explain figure ${index + 1}.  `,
        region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
        dataUrl: "data:image/png;base64,AA==",
        width: 400,
        height: 300,
      });
      expect(isAnnotation(note)).toBe(true);
      const file = new File(["png"], `${note.id}.png`, { type: "image/png" });
      expect(
        store.addImage(target, {
          type: "image",
          id: note.id,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: note.screenshot!.dataUrl,
        }),
      ).toBe(true);
      store.addPreviewAnnotation(target, note, { insertAtCaret: false });
      return note;
    });
    const draft = store.getComposerDraft(target)!;
    expect(draft.prompt).toContain("Compare these figures.");
    expect(draft.previewAnnotations).toHaveLength(2);
    expect(draft.images).toHaveLength(2);
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: draft.previewAnnotations,
      attachments: draft.images.map((image) => ({
        attachmentId: image.id,
        attachment: image,
      })),
    });
    const records = context!.records
      .map(asKnownContextRecord)
      .filter((record) => record?.kind === "preview-annotation");
    expect(records).toMatchObject([
      {
        pageTitle: "paper-a.pdf — PDF page 2",
        comment: "Explain figure 1.",
        screenshotContextId: "image_pdf-0",
      },
      {
        pageTitle: "paper-b.pdf — PDF page 3",
        comment: "Explain figure 2.",
        screenshotContextId: "image_pdf-1",
      },
    ]);
    store.removePreviewAnnotation(target, notes[0]!.id);
    expect(store.getComposerDraft(target)?.previewAnnotations.map((note) => note.id)).toEqual([
      "pdf-1",
    ]);
    expect(store.getComposerDraft(target)?.images.map((image) => image.id)).toEqual(["pdf-1"]);
    expect(store.getComposerDraft(target)?.prompt).not.toContain("preview-annotation_pdf-0");
  });
});
