import {
  GlobalWorkerOptions,
  getDocument,
  PasswordResponses,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, Scan, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type PreviewAnnotationRect } from "@t3tools/contracts";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { dataUrlToFile } from "~/lib/imageCompression";
import { cn } from "~/lib/utils";
import { FileSurfaceAction, FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  buildPdfAnnotation,
  pdfAnnotationSource,
  pdfCropPixels,
  pdfRegion,
  type PdfPoint,
} from "./pdfRegion";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfDocumentPreviewProps {
  data: Uint8Array<ArrayBuffer>;
  title: string;
  source: string;
  composerDraftTarget?: ComposerThreadTarget | undefined;
}

interface PdfCapture {
  dataUrl: string;
  region: PreviewAnnotationRect;
  page: number;
  width: number;
  height: number;
}

/** A single rendered page bounds memory even for long, image-heavy documents. */
export default function PdfDocumentPreview(props: PdfDocumentPreviewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [panelWidth, setPanelWidth] = useState(600);
  const [rendered, setRendered] = useState<{
    page: number;
    zoom: number;
    panelWidth: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordRequest, setPasswordRequest] = useState<{
    submit: (password: string) => void;
    incorrect: boolean;
  } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<PreviewAnnotationRect | null>(null);
  const [capture, setCapture] = useState<PdfCapture | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ start: PdfPoint; pointerId: number } | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const draft = useComposerDraftStore((state) =>
    props.composerDraftTarget ? state.getComposerDraft(props.composerDraftTarget) : null,
  );
  const notes =
    draft?.previewAnnotations.filter((note) =>
      note.pageUrl.startsWith(pdfAnnotationSource(props.source)),
    ) ?? [];
  const ready =
    rendered?.page === pageNumber && rendered.zoom === zoom && rendered.panelWidth === panelWidth;

  useEffect(() => {
    let disposed = false;
    const assets = `${import.meta.env.BASE_URL}pdf-assets/`;
    const task = getDocument({
      // PDF.js transfers this buffer to its worker. Keep the snapshot's own bytes
      // intact for version comparisons and render every page from this one copy.
      data: props.data.slice(),
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
    });
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      if (!disposed)
        setPasswordRequest({ submit, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD });
    };
    void task.promise
      .then((document) => {
        if (disposed) return;
        setPasswordRequest(null);
        setPassword("");
        setPdf(document);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Unable to open this PDF.");
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [props.data]);

  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPanelWidth(Math.max(100, Math.floor(entry.contentRect.width - 32)));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    let cancel: (() => void) | undefined;
    let cleanup: (() => void) | undefined;
    // Each render owns its canvas, so cancelling a zoom cannot race the next render.
    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (disposed) return;
      cleanup = () => {
        page.cleanup();
      };
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (panelWidth / base.width) * zoom });
      const density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      const task = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
      cancel = () => task.cancel();
      await task.promise;
      if (disposed) return;
      const visible = canvasRef.current;
      if (!visible) return;
      visible.width = canvas.width;
      visible.height = canvas.height;
      visible.style.width = `${viewport.width}px`;
      visible.style.height = `${viewport.height}px`;
      const context = visible.getContext("2d");
      if (!context) throw new Error("This device could not create a PDF canvas.");
      context.drawImage(canvas, 0, 0);
      setRendered({ page: pageNumber, zoom, panelWidth });
    })().catch((cause: unknown) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "Unable to render this page.");
    });
    return () => {
      disposed = true;
      cancel?.();
      cleanup?.();
    };
  }, [pdf, pageNumber, zoom, panelWidth]);

  function cancelSelection() {
    dragRef.current = null;
    setSelection(null);
    setCapture(null);
    setComment("");
    setStatus("");
  }

  function goToPage(page: number) {
    if (!pdf || capture || saving) return;
    cancelSelection();
    setError(null);
    setPageNumber(Math.max(1, Math.min(pdf.numPages, Math.trunc(page) || 1)));
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }

  function point(event: PointerEvent<HTMLCanvasElement>): PdfPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }

  function captureRegion(region: PreviewAnnotationRect) {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const rect = pdfCropPixels(region, canvas.width, canvas.height);
    if (rect.width < 4 || rect.height < 4) {
      setSelection(null);
      return;
    }
    try {
      const crop = document.createElement("canvas");
      crop.width = rect.width;
      crop.height = rect.height;
      const context = crop.getContext("2d");
      if (!context) throw new Error("Unable to capture this region.");
      context.drawImage(
        canvas,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      );
      setCapture({
        dataUrl: crop.toDataURL("image/png"),
        region,
        page: pageNumber,
        width: crop.width,
        height: crop.height,
      });
      setSelection(region);
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Unable to capture this region.");
    }
  }

  useEffect(() => {
    if (capture) commentRef.current?.focus();
  }, [capture]);

  function addToPrompt() {
    const target = props.composerDraftTarget;
    if (!target || !capture || !comment.trim() || saving) return;
    setSaving(true);
    try {
      const annotation = buildPdfAnnotation({
        ...capture,
        id: crypto.randomUUID(),
        source: props.source,
        title: props.title,
        comment,
      });
      // Decode locally: the desktop CSP intentionally disallows fetching data: URLs.
      const file = dataUrlToFile(
        capture.dataUrl,
        `PDF-page-${capture.page}-${annotation.id}.png`,
        "image/png",
      );
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        throw new Error(
          "This screenshot is over 10 MB. Select a smaller area or zoom out and try again.",
        );
      const store = useComposerDraftStore.getState();
      const accepted = store.addImage(target, {
        type: "image",
        id: annotation.id,
        name: file.name,
        mimeType: "image/png",
        sizeBytes: file.size,
        file,
        previewUrl: capture.dataUrl,
      });
      if (!accepted)
        throw new Error(
          "The prompt's attachment limit has been reached. Send or remove an attachment first.",
        );
      store.addPreviewAnnotation(target, annotation, { insertAtCaret: false });
      cancelSelection();
      setStatus("Added to prompt. Select another area, or send your prompt when ready.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Could not add this note.");
    } finally {
      setSaving(false);
    }
  }

  const controlsDisabled = !pdf || !!capture || saving;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <FileSurfaceAction
          label="Previous PDF page"
          disabled={controlsDisabled || pageNumber === 1}
          onPress={() => goToPage(pageNumber - 1)}
        >
          <ChevronLeft />
        </FileSurfaceAction>
        <label className="flex items-center gap-1 text-xs">
          Page{" "}
          <input
            aria-label="PDF page"
            type="number"
            min={1}
            max={pdf?.numPages ?? 1}
            value={pageNumber}
            disabled={controlsDisabled}
            className="w-14 rounded border border-input bg-background px-1 py-1 text-center"
            onChange={(event) => goToPage(Number(event.target.value))}
          />
          <span className="pr-1 text-muted-foreground">/ {pdf?.numPages ?? "…"}</span>
        </label>
        <FileSurfaceAction
          label="Next PDF page"
          disabled={controlsDisabled || pageNumber === pdf?.numPages}
          onPress={() => goToPage(pageNumber + 1)}
        >
          <ChevronRight />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Zoom out"
          disabled={controlsDisabled || zoom <= 0.5}
          onPress={() => {
            cancelSelection();
            setZoom((value) => Math.max(0.5, value - 0.25));
          }}
        >
          <ZoomOut />
        </FileSurfaceAction>
        <Button
          variant="ghost"
          size="compact"
          disabled={controlsDisabled}
          onClick={() => {
            cancelSelection();
            setZoom(1);
          }}
          aria-label="Fit PDF page width"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <FileSurfaceAction
          label="Zoom in"
          disabled={controlsDisabled || zoom >= 3}
          onPress={() => {
            cancelSelection();
            setZoom((value) => Math.min(3, value + 0.25));
          }}
        >
          <ZoomIn />
        </FileSurfaceAction>
        {props.composerDraftTarget ? (
          <>
            <Button
              variant={selecting ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={selecting}
              disabled={!ready || !!capture}
              onClick={() => {
                cancelSelection();
                setSelecting((value) => !value);
              }}
            >
              <Scan /> Select area
            </Button>
            <Button
              variant="ghost"
              size="compact"
              disabled={!ready || !!capture}
              onClick={() => captureRegion({ x: 0, y: 0, width: 1, height: 1 })}
            >
              Capture page
            </Button>
          </>
        ) : null}
      </div>
      {selecting && !capture ? (
        <p className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
          Drag over the PDF to capture an area. Escape cancels the selection.
        </p>
      ) : null}
      {passwordRequest ? (
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            passwordRequest.submit(password);
            setPassword("");
            setPasswordRequest(null);
          }}
        >
          <label className="text-xs">
            {passwordRequest.incorrect ? "Incorrect password. Try again:" : "PDF password:"}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="ml-2 rounded border border-input px-2 py-1"
            />
          </label>
          <Button type="submit" size="compact">
            Unlock
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-muted/40 p-4 [scrollbar-gutter:stable]"
      >
        {!ready && !error && !passwordRequest ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <FileSurfaceLoading />
          </div>
        ) : null}
        <div
          className="relative mx-auto w-fit"
          style={{ display: rendered && !error ? "block" : "none", opacity: ready ? 1 : 0.5 }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${props.title}, PDF page ${pageNumber}`}
            tabIndex={selecting ? 0 : undefined}
            className={cn(
              "block bg-white shadow-sm",
              selecting && !capture && "touch-none cursor-crosshair",
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saving) {
                event.stopPropagation();
                cancelSelection();
                setSelecting(false);
              }
            }}
            onPointerDown={(event) => {
              if (!selecting || capture || !ready || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { start: point(event), pointerId: event.pointerId };
              setSelection(null);
            }}
            onPointerMove={(event) => {
              if (dragRef.current?.pointerId === event.pointerId)
                setSelection(pdfRegion(dragRef.current.start, point(event)));
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              captureRegion(pdfRegion(drag.start, point(event)));
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setSelection(null);
            }}
            onLostPointerCapture={() => {
              if (dragRef.current) {
                dragRef.current = null;
                setSelection(null);
              }
            }}
          />
          {selection ? (
            <div
              ref={selectionRef}
              className="pointer-events-none absolute border-2 border-primary bg-primary/15"
              style={{
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.width * 100}%`,
                height: `${selection.height * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
      <Popover
        open={capture !== null}
        onOpenChange={(open, details) => {
          // Releasing a marquee also dispatches a click on the canvas. It must
          // not dismiss the editor that this same gesture just opened.
          if (details.reason === "outside-press" && details.event.target === canvasRef.current)
            return;
          if (!open && !saving) cancelSelection();
        }}
      >
        {capture ? (
          <PopoverPopup
            anchor={selectionRef}
            side="bottom"
            align="start"
            sideOffset={8}
            initialFocus={commentRef}
            aria-label={`Annotate PDF page ${capture.page}`}
          >
            <div className="flex w-80 max-w-[calc(100vw-64px)] items-start gap-2">
              <textarea
                ref={commentRef}
                dir="auto"
                aria-label={`Comment on PDF page ${capture.page}`}
                placeholder="Describe the change…"
                rows={1}
                className="field-sizing-content min-h-8 max-h-24 min-w-0 flex-1 resize-none border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground focus:border-b-primary"
                value={comment}
                disabled={saving}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void addToPrompt();
                  }
                }}
              />
              <FileSurfaceAction
                label="Delete annotation"
                disabled={saving}
                onPress={cancelSelection}
              >
                <Trash2 className="size-3.5" />
              </FileSurfaceAction>
              <Button
                size="compact"
                title="Attach annotation and screenshot (Enter)"
                disabled={!comment.trim() || saving}
                onClick={() => {
                  void addToPrompt();
                }}
              >
                {saving ? "Attaching…" : "Attach"}
              </Button>
            </div>
          </PopoverPopup>
        ) : null}
      </Popover>
      {status ? (
        <p role="status" className="border-t border-border px-3 py-2 text-xs">
          {status}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <p className="mb-2 text-xs text-muted-foreground">
            {notes.length} PDF {notes.length === 1 ? "note" : "notes"} in prompt
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {notes.map((note) => {
              const image = draft?.images.find((image) => image.id === note.id);
              return (
                <div
                  key={note.id}
                  className="flex w-64 shrink-0 gap-2 overflow-hidden rounded border border-border p-2"
                >
                  {image ? (
                    <img
                      src={image.previewUrl}
                      alt={note.pageTitle ?? "PDF region"}
                      className="h-16 w-16 shrink-0 bg-white object-contain"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={<p className="line-clamp-2 wrap-anywhere text-xs font-medium" />}
                      >
                        {note.pageTitle}
                      </TooltipTrigger>
                      <TooltipPopup>
                        <div className="max-w-sm wrap-anywhere">{note.pageTitle}</div>
                      </TooltipPopup>
                    </Tooltip>
                    <p
                      className="max-h-20 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-xs"
                      dir="auto"
                    >
                      {note.comment}
                    </p>
                  </div>
                  <FileSurfaceAction
                    label="Remove PDF note"
                    onPress={() => {
                      if (props.composerDraftTarget)
                        useComposerDraftStore
                          .getState()
                          .removePreviewAnnotation(props.composerDraftTarget, note.id);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </FileSurfaceAction>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
