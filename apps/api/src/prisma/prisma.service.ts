import { Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { type ScopedClient, withTenantGuard } from "./tenant-guard.js";

export type Db = ScopedClient;
/** The client handed to an interactive transaction callback on the guarded client. */
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

@Injectable()
export class PrismaService implements OnModuleDestroy {
  /** No tenant guard. Only for platform admin, webhook routing and schedulers — and say why at the call site. */
  readonly unscoped: PrismaClient;
  /** The default client: tenant-owned models must be queried with a workspace scope. */
  readonly db: Db;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.unscoped = new PrismaClient({
      adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: config.RUN_WORKERS ? 20 : 15 }),
    });
    this.db = withTenantGuard(this.unscoped);
  }

  async onModuleDestroy(): Promise<void> {
    await this.unscoped.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
