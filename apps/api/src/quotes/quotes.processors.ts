import { Module } from "@nestjs/common";
import { QuotesModule } from "./quotes.module.js";

/** Worker side of quotes: processors and recurring schedules (filled in with the feature). */
@Module({ imports: [QuotesModule], providers: [] })
export class QuotesProcessorsModule {}
