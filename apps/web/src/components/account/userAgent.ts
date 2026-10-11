/*
 * A session's User-Agent as a person would name the device: "Chrome on macOS".
 * Order matters — Edge and Opera also say "Chrome", Chrome also says "Safari".
 */

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

export function describeUserAgent(ua: string): string {
  if (!ua) return "Unknown device";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser || system) return (browser ?? system) as string;
  // Not a browser (an API client, curl): show the product token rather than nothing.
  return ua.split(/[\s/]/)[0] || "Unknown device";
}

export function isMobileAgent(ua: string): boolean {
  return /iPhone|iPod|Android.*Mobile|Mobile Safari/.test(ua);
}
