import { MAX_MESSAGE_ATTEMPTS, onMessageFailure } from "./imap-sync.service.js";

describe("onMessageFailure", () => {
  it("holds the pointer on a message that failed for the first time", () => {
    expect(onMessageFailure({ failedUid: null, failedAttempts: 0 }, 42)).toEqual({ hold: true, attempts: 1 });
  });

  it("counts passes failing on the same uid, and starts over for a different one", () => {
    expect(onMessageFailure({ failedUid: 42, failedAttempts: 2 }, 42)).toEqual({ hold: true, attempts: 3 });
    expect(onMessageFailure({ failedUid: 41, failedAttempts: 4 }, 42)).toEqual({ hold: true, attempts: 1 });
  });

  it("gives up after the last attempt so the mailbox moves on", () => {
    expect(onMessageFailure({ failedUid: 42, failedAttempts: MAX_MESSAGE_ATTEMPTS - 1 }, 42)).toEqual({ hold: false, attempts: MAX_MESSAGE_ATTEMPTS });
  });
});
