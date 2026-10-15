import { MARKETING_ASSET_MAX_BYTES, SITE_ASSET_MAX_BYTES, type MarketingAssetMime, type SiteAssetKind, type SiteAssetMime } from "@growthdesk/shared";

/*
 * What an uploaded image may be — the super-admin's site images here, and a
 * workspace's email images (checkEmailImage). The type is decided by the
 * file's magic bytes, never by the name or the browser's claim: an image the
 * browser calls PNG that is really HTML or SVG would otherwise be served from
 * our origin with a type a browser might execute. SVG is refused outright —
 * it is markup, and can carry script.
 */

export type ImageMime = SiteAssetMime | MarketingAssetMime;
export type AssetCheck<M extends ImageMime = SiteAssetMime> = { ok: true; mime: M; bytes: Buffer } | { ok: false; message: string };

const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/x-icon": "ico" };
export const extensionFor = (mime: string) => EXT[mime as ImageMime] ?? "bin";

/** Which types each slot accepts. */
const ALLOWED: Record<SiteAssetKind, readonly SiteAssetMime[]> = {
  logo: ["image/png", "image/jpeg", "image/webp"],
  favicon: ["image/png", "image/x-icon"],
  og: ["image/png", "image/jpeg"],
};
const ALLOWED_LABEL: Record<SiteAssetKind, string> = {
  logo: "PNG, JPEG or WebP",
  favicon: "PNG or ICO",
  og: "PNG or JPEG",
};

/** The real type from the first bytes, or null for anything else. */
export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  // ICONDIR: reserved 0, type 1 (icon), at least one image.
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | (b[5]! << 8)) > 0) return "image/x-icon";
  return null;
}

/** Text that looks like markup (SVG, HTML, XML), after an optional BOM and whitespace. */
function looksLikeMarkup(b: Buffer): boolean {
  const head = b.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<");
}

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/vnd.microsoft.icon": "image/x-icon",
  "image/ico": "image/x-icon",
  "image/icon": "image/x-icon",
};

type ImageRules<M extends ImageMime> = {
  /** Every type this family of images knows; anything else is "not an image" to it. */
  known: readonly M[];
  /** The subset this upload accepts (a slot may take fewer than the family knows). */
  allowed: readonly M[];
  label: string;
  /** Shown for bytes that are no image of this family at all. */
  notAnImage: string;
  maxBytes: number;
  sizeLabel: string;
  /** Shown for a known type this upload does not accept. */
  wrongType?: string;
};

/** Decodes base64 (or a data: URL) and checks size and real type against the rules. */
function checkImage<M extends ImageMime>(data: string, declaredMime: string | undefined, rules: ImageRules<M>): AssetCheck<M> {
  let payload = data.trim();
  let urlMime: string | undefined;
  const dataUrl = /^data:([^;,]*)(;[^,]*)?,/i.exec(payload);
  if (dataUrl) {
    if (!/;base64/i.test(dataUrl[2] ?? "")) return { ok: false, message: "Upload the file as base64" };
    urlMime = dataUrl[1]?.toLowerCase();
    payload = payload.slice(dataUrl[0].length);
  }
  payload = payload.replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return { ok: false, message: "The file could not be read (not base64)" };
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) return { ok: false, message: "The file is empty" };
  if (bytes.length > rules.maxBytes) return { ok: false, message: `The file is larger than ${rules.sizeLabel}` };

  const claimed = [declaredMime, urlMime].map((m) => (m ? (MIME_ALIASES[m.trim().toLowerCase()] ?? m.trim().toLowerCase()) : ""));
  const mime = sniffImage(bytes);
  if (claimed.some((m) => m.includes("svg")) || (!mime && looksLikeMarkup(bytes))) {
    return { ok: false, message: `SVG and other markup files are not accepted — upload a ${rules.label} image` };
  }
  // A type sniffImage knows but this family does not (a GIF offered as a site
  // image) is no different from bytes that are no image at all.
  if (!mime || !(rules.known as readonly ImageMime[]).includes(mime)) return { ok: false, message: rules.notAnImage };
  if (claimed.some((m) => m && m !== "application/octet-stream" && m !== mime)) {
    return { ok: false, message: "The file's contents do not match its type" };
  }
  if (!(rules.allowed as readonly ImageMime[]).includes(mime)) return { ok: false, message: rules.wrongType ?? rules.notAnImage };
  return { ok: true, mime: mime as M, bytes };
}

const SITE_IMAGE_MIMES: readonly SiteAssetMime[] = ["image/png", "image/jpeg", "image/webp", "image/x-icon"];

/** A site image for one slot (logo, favicon, social preview). */
export function checkAsset(kind: SiteAssetKind, data: string, declaredMime?: string): AssetCheck {
  return checkImage<SiteAssetMime>(data, declaredMime, {
    known: SITE_IMAGE_MIMES,
    allowed: ALLOWED[kind],
    label: "PNG, JPEG, WebP or ICO",
    notAnImage: "Only PNG, JPEG, WebP and ICO images are accepted",
    maxBytes: SITE_ASSET_MAX_BYTES,
    sizeLabel: "256 KB",
    wrongType: `A ${kind === "og" ? "social preview image" : kind} must be ${ALLOWED_LABEL[kind]}`,
  });
}

const EMAIL_IMAGE_MIMES: readonly MarketingAssetMime[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** An image for a marketing email: PNG, JPEG, GIF or WebP, up to 1 MB. */
export function checkEmailImage(data: string, declaredMime?: string): AssetCheck<MarketingAssetMime> {
  return checkImage(data, declaredMime, {
    known: EMAIL_IMAGE_MIMES,
    allowed: EMAIL_IMAGE_MIMES,
    label: "PNG, JPEG, GIF or WebP",
    notAnImage: "Only PNG, JPEG, GIF and WebP images are accepted",
    maxBytes: MARKETING_ASSET_MAX_BYTES,
    sizeLabel: "1 MB",
  });
}
