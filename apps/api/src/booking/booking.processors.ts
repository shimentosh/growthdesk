import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { BookingModule } from "./booking.module.js";
import { BookingService } from "./booking.service.js";
import { CalendarService } from "./calendar.service.js";

/*
 * The `calendar` queue (owned by booking):
 *   meeting.sync {workspaceId, meetingId}             make the host's calendar event match the meeting
 *                                                     (cancel / move); queued when a direct attempt failed.
 *                                                     Errors throw so BullMQ retries.
 *   reminder {workspaceId, meetingId, startsAt}       delayed to a day before: the attendee's reminder email,
 *                                                     only if the meeting is still on at that time.
 *   health                                            every hour: proves each idle connection's access still
 *                                                     works, so a revoked one is flagged (and its owner told)
 *                                                     before a visitor tries to book.
 */

@Processor(QUEUES.calendar, { concurrency: 5 })
export class CalendarProcessor extends WorkerHost {
  private readonly log = new Logger("calendar");

  constructor(
    private readonly booking: BookingService,
    private readonly calendar: CalendarService,
  ) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; meetingId?: string; startsAt?: string }>): Promise<unknown> {
    const { workspaceId, meetingId, startsAt } = job.data;
    switch (job.name) {
      case "meeting.sync":
        if (!workspaceId || !meetingId) return null;
        return { synced: await this.booking.syncJob(workspaceId, meetingId) };
      case "reminder":
        if (!workspaceId || !meetingId || !startsAt) return null;
        return { sent: await this.booking.remind(workspaceId, meetingId, startsAt) };
      case "health":
        return this.calendar.checkHealth();
      default:
        this.log.warn(`unknown calendar job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class CalendarSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.calendar).upsertJobScheduler(
      "calendar-health",
      { every: 3600_000 },
      {
        name: "health",
        data: {},
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
      },
    );
  }
}

/** Worker side of booking: the calendar queue's processor and its hourly health check. */
@Module({ imports: [BookingModule], providers: [CalendarProcessor, CalendarSchedules] })
export class BookingProcessorsModule {}
