import { describe, expect, it } from "vitest";
import { MARKETING_ASSET_MAX_BYTES } from "@growthdesk/shared";
import { checkAsset, checkEmailImage, extensionFor, sniffImage } from "./asset-rules.js";
import { assetIdFrom } from "../marketing/assets.service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const b64 = (b: Buffer) => b.toString("base64");

describe("sniffImage", () => {
  it("knows PNG, JPEG, GIF and WebP by their bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(Buffer.from("GIF87a....", "latin1"))).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from("hello"))).toBeNull();
  });
});

describe("checkEmailImage", () => {
  it("accepts the four email image types, as base64 or a data: URL", () => {
    for (const [bytes, mime] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"]] as const) {
      expect(checkEmailImage(b64(bytes))).toMatchObject({ ok: true, mime });
      expect(checkEmailImage(`data:${mime};base64,${b64(bytes)}`, mime)).toMatchObject({ ok: true, mime });
    }
    expect(checkEmailImage(b64(JPEG), "image/jpg")).toMatchObject({ ok: true, mime: "image/jpeg" });
  });

  it("refuses SVG, however it is labelled", () => {
    expect(checkEmailImage(b64(SVG))).toMatchObject({ ok: false, message: expect.stringMatching(/SVG/) });
    expect(checkEmailImage(b64(PNG), "image/svg+xml")).toMatchObject({ ok: false, message: expect.stringMatching(/SVG/) });
    expect(checkEmailImage(`data:image/png;base64,${b64(SVG)}`)).toMatchObject({ ok: false });
  });

  it("refuses a type the bytes contradict, ICO, junk and empty files", () => {
    expect(checkEmailImage(b64(PNG), "image/jpeg")).toMatchObject({ ok: false, message: "The file's contents do not match its type" });
    expect(checkEmailImage(b64(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])))).toMatchObject({ ok: false });
    expect(checkEmailImage("not base64!")).toMatchObject({ ok: false });
    expect(checkEmailImage("data:image/png,raw")).toMatchObject({ ok: false, message: "Upload the file as base64" });
    expect(checkEmailImage(b64(Buffer.from("plain text")))).toMatchObject({ ok: false });
  });

  it("caps one image at 1 MB", () => {
    const at = Buffer.concat([PNG, Buffer.alloc(MARKETING_ASSET_MAX_BYTES - PNG.length)]);
    expect(checkEmailImage(b64(at))).toMatchObject({ ok: true });
    const over = Buffer.concat([at, Buffer.alloc(1)]);
    expect(checkEmailImage(b64(over))).toMatchObject({ ok: false, message: "The file is larger than 1 MB" });
  });
});

describe("checkAsset (site images) still applies its slot rules", () => {
  it("takes a GIF nowhere and an ICO only as a favicon", () => {
    // A GIF is no site image at all — the same answer it got before GIFs were sniffed.
    for (const kind of ["logo", "favicon", "og"] as const) {
      expect(checkAsset(kind, b64(GIF))).toMatchObject({ ok: false, message: "Only PNG, JPEG, WebP and ICO images are accepted" });
    }
    expect(checkAsset("logo", b64(JPEG))).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(checkAsset("favicon", b64(JPEG))).toMatchObject({ ok: false, message: "A favicon must be PNG or ICO" });
    expect(checkAsset("favicon", b64(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])))).toMatchObject({ ok: true, mime: "image/x-icon" });
    expect(checkAsset("og", b64(PNG))).toMatchObject({ ok: true, mime: "image/png" });
    expect(checkAsset("logo", b64(Buffer.alloc(300 * 1024, 1)))).toMatchObject({ ok: false, message: "The file is larger than 256 KB" });
  });
});

describe("email image URLs", () => {
  it("name the file with its extension, and the id comes back with or without it", () => {
    expect(extensionFor("image/gif")).toBe("gif");
    const id = "0190a3c4-1b2c-7d3e-8f40-0123456789ab";
    expect(assetIdFrom(`${id}.png`)).toBe(id);
    expect(assetIdFrom(id)).toBe(id);
    expect(assetIdFrom("../etc/passwd")).toBeNull();
    expect(assetIdFrom(`${id}x.png`)).toBeNull();
  });
});
