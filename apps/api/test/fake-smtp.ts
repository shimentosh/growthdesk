import net from "node:net";

/*
 * A minimal SMTP server for tests that need answers GreenMail will not give:
 * a 5.1.1 refusal of one recipient (any address starting "bad-"), a 535 for
 * the password "wrong", and a slow DATA reply so pooled sends overlap.
 */
export type FakeSmtp = {
  port: number;
  /** Envelope recipients of every message accepted. */
  accepted: string[];
  /** Delay before answering the end of DATA. */
  setDataDelay: (ms: number) => void;
  close: () => Promise<void>;
};

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const accepted: string[] = [];
  let dataDelay = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => undefined);
    sock.write("220 fake.test ESMTP\r\n");
    let buf = "";
    let inData = false;
    let rcpt: string[] = [];
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          buf = buf.slice(end + 5);
          inData = false;
          const to = rcpt;
          rcpt = [];
          setTimeout(() => {
            accepted.push(...to);
            if (!sock.destroyed) sock.write("250 2.0.0 queued\r\n");
          }, dataDelay);
          continue;
        }
        const eol = buf.indexOf("\r\n");
        if (eol < 0) return;
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") sock.write("250-fake.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (verb === "AUTH") {
          const parts = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\u0000");
          sock.write(parts[2] === "wrong" ? "535 5.7.8 Authentication credentials invalid\r\n" : "235 2.7.0 Authentication successful\r\n");
        } else if (verb === "MAIL") {
          rcpt = [];
          sock.write("250 2.1.0 Ok\r\n");
        } else if (verb === "RCPT") {
          const addr = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (/^bad-/i.test(addr)) sock.write(`550 5.1.1 <${addr}>: Recipient address rejected: User unknown in virtual mailbox table\r\n`);
          else {
            rcpt.push(addr);
            sock.write("250 2.1.5 Ok\r\n");
          }
        } else if (verb === "DATA") {
          inData = true;
          sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "RSET" || verb === "NOOP") sock.write("250 2.0.0 Ok\r\n");
        else if (verb === "QUIT") sock.end("221 2.0.0 Bye\r\n");
        else sock.write("502 5.5.2 Command not recognized\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    accepted,
    setDataDelay: (ms) => {
      dataDelay = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A local port with nothing listening on it (connection refused). */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
