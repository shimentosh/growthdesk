import { z } from "zod";

/*
 * Files attached to contacts, companies, deals and quotes, kept in Postgres
 * (Attachment.bytes). Uploads arrive as base64 JSON, like email images, so a
 * file is capped by the API's 20 MB JSON body limit: 10 MB of file is about
 * 13.4 MB of base64. The type is decided from the bytes where they say (PDF,
 * images, Office files…), else from a short list of plain-text extensions,
 * else it is served as application/octet-stream; programs and scripts are
 * refused by extension and by their bytes. Downloads are always served as an
 * attachment with nosniff, so nothing uploaded runs in the app's origin.
 */

export const ATTACHMENT_ENTITY_TYPES = ["contact", "company", "deal", "quote"] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

const MB = 1024 * 1024;
/** One file. Fits the API's 20 MB JSON body once base64-encoded. */
export const ATTACHMENT_MAX_BYTES = 10 * MB;
/** Every attachment in a workspace together (deleted ones stop counting). */
export const ATTACHMENT_WORKSPACE_MAX_BYTES = 1024 * MB;

export const AttachmentUploadInput = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  fileName: z.string().trim().min(1, "The file needs a name").max(200),
  /** What the browser says it is; used only when the bytes do not say. */
  contentType: z.string().trim().max(200).optional(),
  /** The file, base64 (or a data: URL). */
  data: z
    .string()
    .min(1, "Choose a file")
    .max(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 400, "Files can be up to 10 MB"),
});
export type AttachmentUploadInputT = z.infer<typeof AttachmentUploadInput>;

export const AttachmentListQuery = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
});

export const AttachmentRenameInput = z.object({ fileName: z.string().trim().min(1, "Enter a name").max(200) });

/** An attachment as the API returns it (never the bytes). */
export type AttachmentT = {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedBy: { id: string; name: string } | null;
  createdAt: string;
};

/** Programs, installers and scripts: refused whatever their bytes. */
export const BLOCKED_EXTENSIONS = [
  "exe", "dll", "com", "bat", "cmd", "msi", "msp", "mst", "scr", "pif", "cpl", "sys", "drv", "ocx",
  "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "ws", "hta", "msc", "lnk", "inf", "reg", "gadget",
  "jar", "class", "sh", "bash", "zsh", "csh", "ksh", "command", "app", "apk", "aab", "ipa", "dmg", "pkg", "deb", "rpm", "run", "bin", "elf", "appimage",
] as const;
const BLOCKED = new Set<string>(BLOCKED_EXTENSIONS);

export const extensionOf = (fileName: string) => {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : "";
};

export const isBlockedFileName = (fileName: string) => BLOCKED.has(extensionOf(fileName));

/** A name safe to store and to put in Content-Disposition: no paths, control characters or quotes. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 200);
}

const at = (b: Uint8Array, offset: number, sig: number[]) => b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Uint8Array, offset: number, s: string) => at(b, offset, [...s].map((c) => c.charCodeAt(0)));

/** Bytes that are a program: Windows PE, ELF, Mach-O, or a script starting with #!. */
export function looksExecutable(b: Uint8Array): boolean {
  if (ascii(b, 0, "MZ")) return true;
  if (at(b, 0, [0x7f, 0x45, 0x4c, 0x46])) return true;
  if (at(b, 0, [0xfe, 0xed, 0xfa, 0xce]) || at(b, 0, [0xfe, 0xed, 0xfa, 0xcf]) || at(b, 0, [0xce, 0xfa, 0xed, 0xfe]) || at(b, 0, [0xcf, 0xfa, 0xed, 0xfe])) return true;
  // 0xCAFEBABE is both a Mach-O fat binary and a Java class file.
  if (at(b, 0, [0xca, 0xfe, 0xba, 0xbe])) return true;
  if (ascii(b, 0, "#!")) return true;
  return false;
}

const ZIP_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  pages: "application/zip",
  key: "application/zip",
  numbers: "application/zip",
};
const OLE_TYPES: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", msg: "application/vnd.ms-outlook" };
/** Plain-text files the bytes cannot identify: trusted by extension, and served as text. */
const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  json: "application/json",
  ics: "text/calendar",
  vcf: "text/vcard",
  rtf: "application/rtf",
  log: "text/plain",
  eml: "message/rfc822",
};

/**
 * The type to store and serve: from the bytes when they are a known format,
 * else from a plain-text extension, else application/octet-stream. Markup
 * (HTML, SVG, XML) is never given a type a browser would render.
 */
export function sniffContentType(b: Uint8Array, fileName: string): string {
  const ext = extensionOf(fileName);
  if (ascii(b, 0, "%PDF-")) return "application/pdf";
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(b, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav";
  if (ascii(b, 4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^M4A/.test(brand)) return "audio/mp4";
    if (/^qt/.test(brand)) return "video/quicktime";
    return "video/mp4";
  }
  if (ascii(b, 0, "ID3") || at(b, 0, [0xff, 0xfb]) || at(b, 0, [0xff, 0xf3])) return "audio/mpeg";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (at(b, 0, [0x50, 0x4b, 0x03, 0x04]) || at(b, 0, [0x50, 0x4b, 0x05, 0x06])) return ZIP_TYPES[ext] ?? "application/zip";
  if (at(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return OLE_TYPES[ext] ?? "application/octet-stream";
  if (at(b, 0, [0x1f, 0x8b])) return "application/gzip";
  if (ascii(b, 0, "7z") && at(b, 2, [0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (ascii(b, 0, "Rar!")) return "application/vnd.rar";
  if (ascii(b, 0, "{\\rtf")) return "application/rtf";
  const text = TEXT_TYPES[ext];
  if (text && !b.subarray(0, 4096).includes(0)) return text;
  return "application/octet-stream";
}

/** Which icon a file gets in lists. */
export type AttachmentKind = "image" | "pdf" | "document" | "spreadsheet" | "presentation" | "archive" | "audio" | "video" | "text" | "other";

export function attachmentKind(contentType: string, fileName = ""): AttachmentKind {
  const t = contentType.toLowerCase();
  const ext = extensionOf(fileName);
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  if (/spreadsheet|ms-excel|text\/csv|tab-separated/.test(t) || ["xls", "xlsx", "csv", "ods", "numbers"].includes(ext)) return "spreadsheet";
  if (/presentation|powerpoint/.test(t) || ["ppt", "pptx", "odp", "key"].includes(ext)) return "presentation";
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(t) || ["doc", "docx", "odt", "pages", "rtf"].includes(ext)) return "document";
  if (/zip|gzip|7z|rar|tar/.test(t)) return "archive";
  if (t.startsWith("text/") || t === "application/json" || t === "message/rfc822") return "text";
  return "other";
}
