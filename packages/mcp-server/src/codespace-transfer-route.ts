import type { RequestHandler } from "express";
import { createLogger, type CodespaceTransferService } from "@mcp-moira/shared";

const logger = createLogger({ component: "CodespaceTransferDownload" });

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function createCodespaceTransferDownloadHandler(
  service: Pick<CodespaceTransferService, "claimDownload" | "consume">,
): RequestHandler {
  return async (req, res) => {
    let claimed: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | null = null;
    let settled = false;
    const consume = () => {
      if (!claimed || settled) return;
      settled = true;
      void service
        .consume(claimed.record)
        .catch((error) => logger.error("Codespace transfer consumption cleanup failed", error));
    };
    try {
      claimed = await service.claimDownload(`codespace-file://${req.params.token}`);
      res.status(200);
      res.set({
        "Content-Type": claimed.record.mimeType,
        "Content-Length": String(claimed.record.observedSize),
        "Content-Disposition": contentDisposition(claimed.record.fileName),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Referrer-Policy": "no-referrer",
      });
      claimed.stream.once("error", (error) => {
        consume();
        res.destroy(error);
      });
      res.once("finish", consume);
      res.once("close", consume);
      claimed.stream.pipe(res);
    } catch {
      consume();
      if (!res.headersSent) res.status(404).json({ error: "codespace_transfer_not_found" });
      else res.destroy();
    }
  };
}
