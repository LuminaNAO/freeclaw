import { logVerbose, shouldLogVerbose } from "../globals.js";
import { loadWebMedia } from "../web/media.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { alignConvertedImageExtension, sanitizeOutboundFileName } from "./outbound-file-name.js";
import { saveMediaBuffer, saveMediaBufferInOwnFolder } from "./store.js";

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: { localRoots?: readonly string[] },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaLocalRoots: options?.localRoots,
    }),
  );
  // signal-attachment-names §2.1-§2.3: the copy handed to the channel CLI keeps the source's
  // file name (the CLI sends the on-disk base name), inside its own folder per send.
  const safeName = sanitizeOutboundFileName(media.fileName);
  if (safeName) {
    const fileName = await alignConvertedImageExtension({
      fileName: safeName,
      contentType: media.contentType,
      kind: media.kind,
    });
    try {
      const saved = await saveMediaBufferInOwnFolder(
        media.buffer,
        media.contentType ?? undefined,
        "outbound",
        maxBytes,
        fileName,
      );
      return { path: saved.path, contentType: saved.contentType };
    } catch (err) {
      // A name the file system still refuses never fails the send: fall back to today's name.
      if (shouldLogVerbose()) {
        logVerbose(
          `outbound attachment: keeping the file name failed, using a generated name: ${String(err)}`,
        );
      }
    }
  }
  // §2.3 fallback: exactly today's behaviour, `media/outbound/<uuid><ext>`.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}
