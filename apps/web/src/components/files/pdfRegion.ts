import type { PreviewAnnotationPayload, PreviewAnnotationRect } from "@t3tools/contracts";

export interface PdfPoint {
  x: number;
  y: number;
}

/** Page-relative coordinates keep a selection stable across zoom and pixel densities. */
export function pdfRegion(start: PdfPoint, end: PdfPoint): PreviewAnnotationRect {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = Math.min(clamp(start.x), clamp(end.x));
  const y = Math.min(clamp(start.y), clamp(end.y));
  return {
    x,
    y,
    width: Math.max(clamp(start.x), clamp(end.x)) - x,
    height: Math.max(clamp(start.y), clamp(end.y)) - y,
  };
}

export function pdfCropPixels(region: PreviewAnnotationRect, width: number, height: number) {
  const left = Math.max(0, Math.floor(region.x * width));
  const top = Math.max(0, Math.floor(region.y * height));
  const right = Math.min(width, Math.ceil((region.x + region.width) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function pdfAnnotationSource(source: string) {
  // This identifies the document, never the signed URL used to fetch its bytes.
  return `pdf:${encodeURIComponent(source)}#page=`;
}

export function buildPdfAnnotation(input: {
  id: string;
  source: string;
  title: string;
  page: number;
  comment: string;
  region: PreviewAnnotationRect;
  dataUrl: string;
  width: number;
  height: number;
}): PreviewAnnotationPayload {
  return {
    id: input.id,
    pageUrl: `${pdfAnnotationSource(input.source)}${input.page}`,
    pageTitle: `${input.title} — PDF page ${input.page}`,
    comment: input.comment.trim(),
    elements: [],
    regions: [{ id: `${input.id}-region`, rect: input.region }],
    strokes: [],
    styleChanges: [],
    screenshot: {
      dataUrl: input.dataUrl,
      width: input.width,
      height: input.height,
      cropRect: input.region,
    },
    createdAt: new Date().toISOString(),
  };
}
