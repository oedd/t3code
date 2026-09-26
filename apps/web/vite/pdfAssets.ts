import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Plugin } from "vite-plus";

/** Keep PDF fonts, CMaps and image decoders local, including in the packaged desktop app. */
export function pdfAssetsPlugin(): Plugin {
  const root = NodePath.dirname(
    NodeURL.fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
  );
  const assets = new Map<string, string>();
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    for (const file of NodeFS.readdirSync(NodePath.join(root, directory), {
      withFileTypes: true,
    })) {
      if (file.isFile())
        assets.set(
          `pdf-assets/${directory}/${file.name}`,
          NodePath.join(root, directory, file.name),
        );
    }
  }
  return {
    name: "t3-pdf-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname.slice(1);
        const file = assets.get(path);
        if (!file) return next();
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm")
            ? "application/wasm"
            : path.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
        );
        res.end(NodeFS.readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of assets)
        this.emitFile({ type: "asset", fileName, source: NodeFS.readFileSync(file) });
    },
  };
}
