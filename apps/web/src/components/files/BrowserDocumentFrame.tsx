import { lazy, Suspense } from "react";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PdfSnapshotPreview = lazy(() => import("./PdfSnapshotPreview"));

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Renders a PDF with the app's reader. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string | null;
  readonly title: string;
  readonly pdf: boolean;
  readonly source?: string | undefined;
  readonly watch?: boolean | undefined;
  readonly refreshSrc?: (() => Promise<string | null>) | undefined;
  readonly composerDraftTarget?: ComposerThreadTarget | undefined;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  return props.pdf ? (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PdfSnapshotPreview
        key={props.source ?? props.title}
        src={props.src}
        title={props.title}
        source={props.source ?? props.title}
        watch={props.watch}
        refreshSrc={props.refreshSrc}
        composerDraftTarget={props.composerDraftTarget}
      />
    </Suspense>
  ) : props.src === null ? (
    <FileSurfaceLoading />
  ) : (
    <iframe
      key={props.src}
      src={props.src}
      title={props.title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
  );
}
