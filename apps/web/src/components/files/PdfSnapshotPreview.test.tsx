import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

vi.mock("./PdfDocumentPreview", () => ({
  default: ({ data }: { data: Uint8Array }) => {
    const [comment, setComment] = useState("");
    return (
      <div>
        <pre>{new TextDecoder().decode(data)}</pre>
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} />
      </div>
    );
  },
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("./fileSurfaceChrome", () => ({
  FileSurfaceLoading: () => <div>Loading</div>,
  FileSurfaceFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <button onClick={onRetry}>{message}</button>
  ),
}));

describe("PDF snapshot lifetime", () => {
  let renderer: ReactTestRenderer;
  let body: string;
  let etag: string;
  let unavailable: boolean;
  const refreshSrc = vi.fn<() => Promise<string | null>>();
  const fetchMock = vi.fn<typeof fetch>();
  const frame = (src: string | null, source = "report.pdf") => (
    <BrowserDocumentFrame
      src={src}
      title={source}
      source={source}
      pdf
      watch
      refreshSrc={refreshSrc}
    />
  );
  const open = async () => {
    // Resolve the lazy import before exercising timers and network races.
    await import("./PdfSnapshotPreview");
    await act(async () => {
      renderer = create(frame("https://test/report.pdf?revision=1"));
    });
  };
  const changeUrl = async (revision: number) => {
    await act(async () => {
      renderer.update(frame(`https://test/report.pdf?revision=${revision}`));
    });
  };
  const visible = () => renderer.root.findByType("pre").children.join("");
  const comment = () => renderer.root.findByType("textarea");

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    body = "original PDF bytes";
    etag = "v1";
    unavailable = false;
    refreshSrc.mockReset().mockResolvedValue(null);
    fetchMock.mockReset().mockImplementation(async (_url, options) => {
      if (unavailable) return new Response(null, { status: 404 });
      return new Response(options?.method === "HEAD" ? null : body, { headers: { etag } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves the reader and comment across agent steps and signed URL renewals", async () => {
    await open();
    await act(() => comment().props.onChange({ target: { value: "Keep this draft" } }));
    await changeUrl(2);
    await changeUrl(3);
    expect(visible()).toBe(body);
    expect(comment().props.value).toBe("Keep this draft");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "HEAD",
      "HEAD",
    ]);
  });

  it("holds every page on the original bytes until the user accepts the newest version", async () => {
    await open();
    await act(() => comment().props.onChange({ target: { value: "Unsaved note" } }));
    body = "second PDF bytes";
    etag = "v2";
    await changeUrl(2);
    body = "third PDF bytes";
    etag = "v3";
    await changeUrl(3);
    expect(visible()).toBe("original PDF bytes");
    expect(comment().props.value).toBe("Unsaved note");
    await act(() => renderer.root.findByType("button").props.onClick());
    expect(visible()).toBe("third PDF bytes");
    expect(comment().props.value).toBe("");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("does not offer an update for identical bytes even when metadata changes", async () => {
    await open();
    etag = "touched";
    await changeUrl(2);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    expect(visible()).toBe(body);
  });

  it("detects external edits without an agent step, and clears a reverted update", async () => {
    await open();
    body = "external edit";
    etag = "v2";
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    expect(visible()).toBe("original PDF bytes");
    body = "original PDF bytes";
    etag = "v3";
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("retains the snapshot and draft through background failures and connection loss", async () => {
    await open();
    await act(() => comment().props.onChange({ target: { value: "Offline draft" } }));
    unavailable = true;
    await changeUrl(2);
    await act(async () => renderer.update(frame(null)));
    expect(visible()).toBe(body);
    expect(comment().props.value).toBe("Offline draft");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reauthorizes a replaced file before offering its new contents", async () => {
    await open();
    unavailable = true;
    refreshSrc.mockImplementation(async () => {
      unavailable = false;
      body = "replacement";
      etag = "v2";
      return "https://test/renewed.pdf";
    });
    await changeUrl(2);
    expect(refreshSrc).toHaveBeenCalledTimes(1);
    expect(visible()).toBe("original PDF bytes");
    await act(() => renderer.root.findByType("button").props.onClick());
    expect(visible()).toBe("replacement");
  });

  it("starts a fresh snapshot when opening another document", async () => {
    await open();
    await act(() => comment().props.onChange({ target: { value: "First document draft" } }));
    body = "another PDF";
    await act(async () => renderer.update(frame("https://test/other.pdf", "other.pdf")));
    expect(visible()).toBe("another PDF");
    expect(comment().props.value).toBe("");
  });

  it("can retry an initial download failure", async () => {
    unavailable = true;
    await open();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    unavailable = false;
    await act(() => renderer.root.findByType("button").props.onClick());
    expect(visible()).toBe(body);
  });

  it("compares bytes when response validators are unavailable", async () => {
    fetchMock.mockImplementation(
      async (_url, options) => new Response(options?.method === "HEAD" ? null : body),
    );
    await open();
    await changeUrl(2);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    body = "changed without metadata";
    await changeUrl(3);
    expect(visible()).toBe("original PDF bytes");
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
  });

  it("ignores a slow check after a newer URL supersedes it", async () => {
    await open();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await changeUrl(2);
    await changeUrl(3);
    await act(async () => finish(new Response(null, { headers: { etag: "stale" } })));
    expect(visible()).toBe(body);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});
