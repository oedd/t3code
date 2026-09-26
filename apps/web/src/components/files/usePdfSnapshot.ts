import { useEffect, useRef, useState } from "react";

interface PdfSnapshot {
  data: Uint8Array<ArrayBuffer>;
  revision: number;
}

// Validators are only a download optimization; bytes decide whether to offer a reload.
function validator(response: Response): string | null {
  const etag = response.headers.get("etag");
  if (etag) return etag;
  const modified = response.headers.get("last-modified");
  const length = response.headers.get("content-length");
  return modified && length ? `${modified}:${length}` : null;
}

export function usePdfSnapshot(
  src: string | null,
  watch: boolean,
  refreshSrc?: () => Promise<string | null>,
) {
  const [loaded, setLoaded] = useState<PdfSnapshot | null>(null);
  const [update, setUpdate] = useState<PdfSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const active = useRef<PdfSnapshot | null>(null);
  const latest = useRef<{ snapshot: PdfSnapshot; validator: string | null } | null>(null);
  const refreshRef = useRef(refreshSrc);
  useEffect(() => {
    refreshRef.current = refreshSrc;
  }, [refreshSrc]);

  useEffect(() => {
    if (!src && active.current) return;
    if (!src && !refreshRef.current) return;
    const controller = new AbortController();
    let checking = false;
    let url = src;
    async function request(method: "HEAD" | "GET") {
      url ??= (await refreshRef.current?.()) ?? null;
      if (!url) throw new Error("Unable to load this PDF. Reconnect and try again.");
      let response = await fetch(url, { method, cache: "no-store", signal: controller.signal });
      if (!response.ok && refreshRef.current) {
        const renewed = await refreshRef.current();
        if (controller.signal.aborted) throw new Error("PDF check cancelled.");
        if (renewed) {
          url = renewed;
          response = await fetch(url, { method, cache: "no-store", signal: controller.signal });
        }
      }
      if (!response.ok) throw new Error("Unable to load this PDF. Reconnect and try again.");
      return response;
    }
    async function check() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        if (latest.current) {
          const head = await request("HEAD");
          if (controller.signal.aborted) return;
          const version = validator(head);
          if (version && version === latest.current.validator) return;
        }
        const response = await request("GET");
        const data = new Uint8Array(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        const current = active.current;
        const unchanged =
          current !== null &&
          current.data.length === data.length &&
          current.data.every((byte, index) => byte === data[index]);
        const snapshot = unchanged
          ? current
          : { data, revision: (latest.current?.snapshot.revision ?? 0) + 1 };
        latest.current = { snapshot, validator: validator(response) };
        if (!current) {
          active.current = snapshot;
          setLoaded(snapshot);
        } else {
          setUpdate(unchanged ? null : snapshot);
        }
        setError(null);
      } catch (cause) {
        // A failed background check must never take the loaded reader away.
        if (!controller.signal.aborted && !active.current)
          setError(cause instanceof Error ? cause.message : "Unable to load this PDF.");
      } finally {
        checking = false;
      }
    }
    void check();
    // Workspace events do not cover edits by other apps or files outside the workspace.
    const timer = watch ? setInterval(() => void check(), 15_000) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // A user retry deliberately reruns the same URL after an initial failure.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [src, watch, retry]);

  return {
    loaded,
    update,
    error,
    reload: () => {
      if (!update) return;
      active.current = update;
      setLoaded(update);
      setUpdate(null);
    },
    retry: () => {
      setError(null);
      setRetry((value) => value + 1);
    },
  };
}
