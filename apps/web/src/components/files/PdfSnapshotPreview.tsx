import type { ComposerThreadTarget } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import PdfDocumentPreview from "./PdfDocumentPreview";
import { usePdfSnapshot } from "./usePdfSnapshot";

export default function PdfSnapshotPreview(props: {
  src: string | null;
  title: string;
  source: string;
  watch?: boolean | undefined;
  refreshSrc?: (() => Promise<string | null>) | undefined;
  composerDraftTarget?: ComposerThreadTarget | undefined;
}) {
  const snapshot = usePdfSnapshot(props.src, props.watch ?? false, props.refreshSrc);
  if (!snapshot.loaded) {
    return snapshot.error ? (
      <FileSurfaceFailure message={snapshot.error} onRetry={snapshot.retry} />
    ) : (
      <FileSurfaceLoading />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {snapshot.update ? (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
          <span>New PDF version available.</span>
          <Button
            size="compact"
            variant="secondary"
            title="Load the new version and discard the open selection and comment"
            onClick={snapshot.reload}
          >
            Load new version
          </Button>
        </div>
      ) : null}
      <PdfDocumentPreview
        key={snapshot.loaded.revision}
        data={snapshot.loaded.data}
        title={props.title}
        source={props.source}
        composerDraftTarget={props.composerDraftTarget}
      />
    </div>
  );
}
