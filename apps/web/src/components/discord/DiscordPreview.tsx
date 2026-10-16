"use client";

import { Fragment, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { DiscordMessage } from "@growthdesk/shared";
import { cn } from "@/lib/cn";

/*
 * A Discord message as Discord shows it (dark theme, always): the content,
 * one embed with its colour bar, fields in rows of up to three inline, and
 * link buttons. Text is shown as sent — escaped values keep their
 * backslashes stripped for reading, and **bold** is the only markdown drawn.
 */

const unescape = (s: string) => s.replace(/\\([\\*_~`|>#[\]()<:-])/g, "$1").replace(/​/g, "");

function Text({ value }: { value: string }) {
  // **bold** only; everything else as plain text, line breaks kept.
  const parts = value.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold">
            {unescape(p.slice(2, -2))}
          </strong>
        ) : (
          <Fragment key={i}>{unescape(p)}</Fragment>
        ),
      )}
    </>
  );
}

const hex = (n: number | undefined) => (n === undefined ? "#4e5058" : `#${n.toString(16).padStart(6, "0")}`);

export function DiscordPreview({ message, botName = "Growthdesk", className, empty }: { message: DiscordMessage | null; botName?: string; className?: string; empty?: ReactNode }) {
  const embed = message?.embeds[0];
  const buttons = message?.components[0]?.components ?? [];
  const nothing = !message || (!message.content && !embed && !buttons.length);

  return (
    <div className={cn("rounded-lg bg-[#313338] p-4 text-[15px] leading-[1.375] text-[#dbdee1]", className)}>
      <div className="flex gap-3">
        <div aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] text-sm font-semibold text-white">
          {botName.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-white">{botName}</span>
            <span className="rounded-[3px] bg-[#5865f2] px-1 text-[10px] leading-4 font-semibold text-white">APP</span>
            <span className="text-xs text-[#949ba4]">Today</span>
          </div>
          {nothing ? (
            <div className="mt-1 text-sm text-[#949ba4] italic">{empty ?? "Nothing to post."}</div>
          ) : (
            <>
              {message.content && (
                <div className="mt-0.5 break-words whitespace-pre-wrap">
                  <Text value={message.content} />
                </div>
              )}
              {embed && (
                <div className="mt-1.5 grid max-w-[520px] rounded-[4px] border-l-4 bg-[#2b2d31] py-2 pr-4 pl-3" style={{ borderLeftColor: hex(embed.color) }}>
                  {embed.author && <div className="mb-1 text-sm font-semibold text-white">{embed.author.name}</div>}
                  {embed.title && (
                    <div className={cn("mb-1 font-semibold break-words", embed.url ? "text-[#00a8fc]" : "text-white")}>
                      <Text value={embed.title} />
                    </div>
                  )}
                  {embed.description && (
                    <div className="text-sm break-words whitespace-pre-wrap">
                      <Text value={embed.description} />
                    </div>
                  )}
                  {embed.fields && embed.fields.length > 0 && (
                    <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-x-2 gap-y-2">
                      {embed.fields.map((f, i) => (
                        <div key={i} className={cn("min-w-0 text-sm", f.inline ? "col-span-1" : "col-span-full")}>
                          <div className="font-semibold text-white">
                            <Text value={f.name} />
                          </div>
                          <div className="break-words whitespace-pre-wrap">
                            <Text value={f.value} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {(embed.footer || embed.timestamp) && (
                    <div className="mt-2 text-xs text-[#b5bac1]">
                      {embed.footer?.text}
                      {embed.footer && embed.timestamp && " • "}
                      {embed.timestamp && new Date(embed.timestamp).toLocaleString()}
                    </div>
                  )}
                </div>
              )}
              {buttons.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {buttons.map((b, i) => (
                    <span key={i} title={b.url} className="inline-flex h-8 items-center gap-1.5 rounded-[3px] bg-[#4e5058] px-4 text-sm font-medium text-white">
                      {b.label}
                      <ExternalLink aria-hidden className="size-3.5" />
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
