/*
 * The seam between meetings edited in the app (pipeline/pipeline.service.ts)
 * and the host's calendar (booking/). PipelineService calls
 * meetingChanged() after a meeting's time or status changes; BookingService
 * registers the handler when the booking module starts, which cancels or
 * moves the calendar event the meeting mirrors (and queues a retry on
 * QUEUES.calendar if the calendar cannot be reached). Without the booking
 * module loaded it is a no-op. A failure never fails the edit itself.
 */

type Handler = (workspaceId: string, meetingId: string) => Promise<void>;
let handler: Handler | null = null;

export function setMeetingSync(next: Handler | null) {
  handler = next;
}

export async function meetingChanged(workspaceId: string, meetingId: string): Promise<void> {
  if (!handler) return;
  try {
    await handler(workspaceId, meetingId);
  } catch {
    // The handler logs and queues its own retries.
  }
}
