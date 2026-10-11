import { asksToUnsubscribe, isAutoReply, latestReplyText, machineMailReason, parseMail, replyTextOf } from "./inbound-parse.js";

const raw = (headers: Record<string, string>, body: string, type = "text/plain") =>
  [...Object.entries({ "Message-ID": "<m1@lead.test>", Subject: "Re: Quick question", "Content-Type": `${type}; charset=utf-8`, ...headers }).map(([k, v]) => `${k}: ${v}`), "", body].join("\r\n");

// What our outbound text body ends with (OutboundEmailService): signature, then the opt-out line.
const OUR_EMAIL = [
  "Hi Ada, would Thursday suit for a short call?",
  "",
  "--",
  "Sam at Acme",
  "",
  'If you would rather not hear from me again, reply "unsubscribe" or visit: https://app.test/api/t/u/abc',
].join("\n");

describe("latestReplyText", () => {
  it("drops a Gmail-style quote and its attribution", () => {
    const text = `Yes, Thursday works.\n\nOn Tue, Oct 6, 2026 at 9:14 AM Sam <sam@acme.test> wrote:\n${OUR_EMAIL.split("\n").map((l) => `> ${l}`).join("\n")}`;
    expect(latestReplyText(text)).toBe("Yes, Thursday works.");
  });

  it("handles an attribution wrapped over two lines", () => {
    const text = "Sounds good.\n\nOn Tue, Oct 6, 2026 at 9:14 AM Sam at Acme <\nsam@acme.test> wrote:\n> Hi";
    expect(latestReplyText(text)).toBe("Sounds good.");
  });

  it("cuts at an Outlook header block or separator, unquoted original included", () => {
    const outlook = `Happy to talk.\r\n\r\nFrom: Sam <sam@acme.test>\r\nSent: Tuesday, October 6, 2026 9:14 AM\r\nTo: Ada\r\nSubject: Quick question\r\n\r\n${OUR_EMAIL}`;
    expect(latestReplyText(outlook)).toBe("Happy to talk.");
    expect(latestReplyText(`Ok\n\n-----Original Message-----\n${OUR_EMAIL}`)).toBe("Ok");
    expect(latestReplyText(`Ok\n________________________________\n${OUR_EMAIL}`)).toBe("Ok");
  });

  it("removes the signature and mobile footers", () => {
    expect(latestReplyText("Thursday at 3?\n\n-- \nAda Lovelace\nCTO")).toBe("Thursday at 3?");
    expect(latestReplyText("Thursday at 3?\n\nSent from my iPhone")).toBe("Thursday at 3?");
  });

  it("keeps a bottom-posted answer below the quote", () => {
    const text = "On Tue, Oct 6, 2026, Sam wrote:\n> Would Thursday suit?\n\nThursday is fine.";
    expect(latestReplyText(text)).toBe("Thursday is fine.");
  });

  it("drops our own footer line even when a client quoted it without markers", () => {
    expect(latestReplyText(`Great, see you then.\n\n${OUR_EMAIL.split("\n").at(-1)}`)).toBe("Great, see you then.");
  });
});

describe("asksToUnsubscribe", () => {
  it("is not fooled by our quoted unsubscribe footer", () => {
    const quoted = `Yes, Thursday works.\n\nOn Tue, Oct 6, 2026 at 9:14 AM Sam <sam@acme.test> wrote:\n${OUR_EMAIL.split("\n").map((l) => `> ${l}`).join("\n")}`;
    expect(asksToUnsubscribe(quoted)).toBe(false);
    const outlook = `Yes, Thursday works.\n\nFrom: Sam <sam@acme.test>\nSent: Tuesday\n\n${OUR_EMAIL}`;
    expect(asksToUnsubscribe(outlook)).toBe(false);
  });

  it("still hears a written opt-out above the quote", () => {
    expect(asksToUnsubscribe(`Please remove me from your list.\n\nOn Tue, Sam wrote:\n> ${OUR_EMAIL}`)).toBe(true);
    expect(asksToUnsubscribe("unsubscribe")).toBe(true);
    expect(asksToUnsubscribe("Stop emailing me.\n\n-- \nAda")).toBe(true);
  });
});

describe("replyTextOf", () => {
  it("drops quoted blocks from an HTML-only reply", async () => {
    const html = `<div>Yes, Thursday works.</div><div class="gmail_quote"><div>On Tue Sam wrote:</div><blockquote>Hi Ada<br>Not interested? <a href="https://x.test/u">Unsubscribe</a></blockquote></div>`;
    const mail = await parseMail(raw({}, html, "text/html"));
    expect(replyTextOf(mail)).toBe("Yes, Thursday works.");
    expect(asksToUnsubscribe(replyTextOf(mail))).toBe(false);
  });

  it("drops a bare blockquote too", async () => {
    const mail = await parseMail(raw({}, "<p>Count me in</p><blockquote><p>reply unsubscribe to stop</p></blockquote>", "text/html"));
    expect(replyTextOf(mail)).toBe("Count me in");
  });

  it("uses the text part when there is one", async () => {
    const mail = await parseMail(raw({}, "Remove me please\r\n\r\n> earlier"));
    expect(replyTextOf(mail)).toBe("Remove me please");
  });
});

describe("machineMailReason", () => {
  const person = "ada@lead.test";

  it("flags bulk, list, newsletter and auto-generated mail", async () => {
    expect(machineMailReason(await parseMail(raw({ Precedence: "bulk" }, "x")), person)).toMatch(/Precedence: bulk/);
    expect(machineMailReason(await parseMail(raw({ Precedence: "list" }, "x")), person)).toMatch(/Precedence: list/);
    expect(machineMailReason(await parseMail(raw({ Precedence: "junk" }, "x")), person)).toMatch(/Precedence: junk/);
    expect(machineMailReason(await parseMail(raw({ "List-Id": "Weekly digest <digest.news.test>" }, "x")), person)).toMatch(/List-Id/);
    expect(machineMailReason(await parseMail(raw({ "List-Unsubscribe": "<https://news.test/u>" }, "x")), person)).toMatch(/List-Unsubscribe/);
    expect(machineMailReason(await parseMail(raw({ "Auto-Submitted": "auto-generated" }, "x")), person)).toMatch(/Auto-Submitted/);
  });

  it("flags no-reply style senders", async () => {
    const mail = await parseMail(raw({}, "Your invoice"));
    for (const from of ["noreply@shop.test", "no-reply@shop.test", "do-not-reply@x.test", "donotreply@x.test", "notifications@github.test", "no_reply+abc@x.test", "bounces@x.test"]) {
      expect(machineMailReason(mail, from)).toBe("no-reply sender");
    }
  });

  it("leaves a person's mail alone", async () => {
    const mail = await parseMail(raw({ Precedence: "first-class" }, "Hi"));
    expect(machineMailReason(mail, person)).toBeNull();
    expect(machineMailReason(mail, "noreen@lead.test")).toBeNull();
    expect(machineMailReason(mail, "info@lead.test")).toBeNull();
    expect(machineMailReason(await parseMail(raw({ "Auto-Submitted": "no" }, "x")), person)).toBeNull();
  });

  it("an out-of-office is both an auto-reply and machine mail", async () => {
    const mail = await parseMail(raw({ "Auto-Submitted": "auto-replied", Subject: "Out of office" }, "Back Monday"));
    expect(isAutoReply(mail)).toBe(true);
    expect(machineMailReason(mail, person)).toMatch(/auto-replied/);
  });
});
