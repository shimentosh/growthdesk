import { fetchImage, fileNameFrom, vetImageUrl, type Opener, type RawResponse } from "./image-fetch.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const dns = (table: Record<string, string[]>) => async (host: string) => {
  const hit = table[host];
  if (!hit) throw new Error("ENOTFOUND");
  return hit;
};

const PUBLIC = dns({ "cdn.example.com": ["93.184.216.34"], "img.example.com": ["2606:2800:220:1::1", "93.184.216.35"], "evil.example.com": ["93.184.216.34", "10.0.0.5"], "rebind.example.com": ["169.254.169.254"] });

function response(status: number, headers: Record<string, string>, chunks: Buffer[] = []): RawResponse {
  return {
    status,
    headers,
    abort: () => undefined,
    body: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

describe("image fetch guard", () => {
  describe("vetImageUrl", () => {
    it("accepts a public https host and pins an IPv4 address", async () => {
      expect(await vetImageUrl("https://cdn.example.com/a.png", PUBLIC)).toMatchObject({ host: "cdn.example.com", address: "93.184.216.34" });
      expect((await vetImageUrl("https://img.example.com/a.png", PUBLIC)).address).toBe("93.184.216.35");
    });

    it.each([
      ["http://cdn.example.com/a.png", /Only https/],
      ["ftp://cdn.example.com/a.png", /Only https/],
      ["file:///etc/passwd", /Only https/],
      ["https://user:pw@cdn.example.com/a.png", /username or password/],
      ["https://cdn.example.com:8443/a.png", /port \(443\)/],
      ["https://localhost/a.png", /private network/],
      ["https://printer.local/a.png", /private network/],
      ["https://metadata.google.internal/a", /private network/],
      ["https://intranet/a.png", /private network/],
      ["https://127.0.0.1/a.png", /private network/],
      ["https://2130706433/a.png", /private network/],
      ["https://10.1.2.3/a.png", /private network/],
      ["https://169.254.169.254/latest/meta-data", /private network/],
      ["https://[::1]/a.png", /private network/],
      ["https://[::ffff:7f00:1]/a.png", /private network/],
      ["https://[fd00::1]/a.png", /private network/],
      ["https://evil.example.com/a.png", /private network/],
      ["https://rebind.example.com/a.png", /private network/],
      ["https://nowhere.example.com/a.png", /No such host/],
      ["not a url", /not a valid link/],
    ])("refuses %s", async (url, message) => {
      await expect(vetImageUrl(url, PUBLIC)).rejects.toThrow(message);
    });
  });

  describe("fetchImage", () => {
    it("downloads through the vetted address and keeps an image content type", async () => {
      const seen: string[] = [];
      const open: Opener = async (t) => {
        seen.push(`${t.address} ${t.url.pathname}`);
        return response(200, { "content-type": "image/png; charset=binary" }, [PNG.subarray(0, 4), PNG.subarray(4)]);
      };
      const r = await fetchImage("https://cdn.example.com/logo.png", { resolve: PUBLIC, open });
      expect(r).toMatchObject({ contentType: "image/png", finalUrl: "https://cdn.example.com/logo.png" });
      expect(r.bytes.equals(PNG)).toBe(true);
      expect(seen).toEqual(["93.184.216.34 /logo.png"]);
    });

    it("vets every redirect target, and stops after three", async () => {
      const toPrivate: Opener = async () => response(302, { location: "https://169.254.169.254/latest" });
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: toPrivate })).rejects.toThrow(/private network/);

      const relative: Opener = async (t) => (t.url.pathname === "/a.png" ? response(301, { location: "/b.png" }) : response(200, { "content-type": "image/png" }, [PNG]));
      expect((await fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: relative })).finalUrl).toBe("https://cdn.example.com/b.png");

      const loop: Opener = async () => response(302, { location: "https://cdn.example.com/again" });
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: loop })).rejects.toThrow(/redirects too many times/);
    });

    it("refuses errors and anything over the size cap, declared or streamed", async () => {
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: async () => response(404, {}) })).rejects.toThrow(/answered 404/);
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, maxBytes: 10, open: async () => response(200, { "content-length": "11" }, [PNG]) })).rejects.toThrow(/larger than/);
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, maxBytes: 10, open: async () => response(200, {}, [PNG]) })).rejects.toThrow(/larger than/);
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: async () => response(200, {}, []) })).rejects.toThrow(/returned nothing/);
      await expect(fetchImage("https://cdn.example.com/a.png", { resolve: PUBLIC, open: async () => Promise.reject(new Error("ECONNRESET")) })).rejects.toThrow(/Could not download the image from cdn\.example\.com: ECONNRESET/);
    });

    it("drops a non-image content type (the bytes decide later)", async () => {
      const r = await fetchImage("https://cdn.example.com/a", { resolve: PUBLIC, open: async () => response(200, { "content-type": "text/html" }, [PNG]) });
      expect(r.contentType).toBeUndefined();
    });
  });

  it("names the file after the URL's last segment", () => {
    expect(fileNameFrom("https://cdn.example.com/img/My%20Logo.png?x=1")).toBe("My Logo.png");
    expect(fileNameFrom("https://cdn.example.com/")).toBe("image");
  });
});
