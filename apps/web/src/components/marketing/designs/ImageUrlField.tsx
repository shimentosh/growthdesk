"use client";

import { useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { MARKETING_ASSET_MAX_BYTES, MARKETING_ASSET_MIMES } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { post, messageOf } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useMarketing } from "../common";

/** POST marketing/assets answer. */
type UploadedImage = { id: string; contentType: string; size: number; url: string };

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("The file could not be read"));
    r.readAsDataURL(file);
  });

/**
 * An image block's address: paste an https:// URL, or upload a file, which
 * the API stores for the workspace and answers with a public URL to fill in.
 * The file is checked here for size and type, and again by the API from its
 * bytes (PNG, JPEG, GIF or WebP up to 1 MB; never SVG).
 */
export function ImageUrlField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  const mk = useMarketing();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const upload = async (file: File) => {
    setProblem(null);
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) return setProblem("SVG images are not shown by many inboxes — export a PNG instead.");
    if (file.size > MARKETING_ASSET_MAX_BYTES) return setProblem(`That image is ${formatBytes(file.size)}; the limit is 1 MB. Make it smaller and try again.`);
    if (file.type && !(MARKETING_ASSET_MIMES as readonly string[]).includes(file.type)) return setProblem("Use a PNG, JPEG, GIF or WebP image.");
    setUploading(true);
    try {
      const data = await readAsDataUrl(file);
      const image = await post<UploadedImage>(mk.path("/assets"), { data, mime: file.type || undefined, fileName: file.name.slice(0, 200) });
      onChange(image.url);
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Field label={label} error={problem ?? error} hint={hint}>
      <div className="flex gap-2">
        <Input
          type="url"
          inputMode="url"
          value={value}
          maxLength={2000}
          onChange={(e) => {
            setProblem(null);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1"
        />
        {!disabled && (
          <Button icon={<Upload />} loading={uploading} onClick={() => input.current?.click()} title="Upload a PNG, JPEG, GIF or WebP image (up to 1 MB)">
            Upload
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept={MARKETING_ASSET_MIMES.join(",")}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </Field>
  );
}
