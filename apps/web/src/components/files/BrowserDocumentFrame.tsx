import { lazy, Suspense } from "react";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PdfDocumentPreview = lazy(() => import("./PdfDocumentPreview"));

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Renders a PDF with the app's reader. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly source?: string | undefined;
  readonly composerDraftTarget?: ComposerThreadTarget | undefined;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  return props.pdf ? (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PdfDocumentPreview
        key={`${props.source ?? props.title}:${props.src}`}
        src={props.src}
        title={props.title}
        source={props.source ?? props.title}
        composerDraftTarget={props.composerDraftTarget}
      />
    </Suspense>
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
