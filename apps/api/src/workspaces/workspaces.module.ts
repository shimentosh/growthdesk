import { Module } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";
import { LibrarySeedRunner, LibrarySeedService } from "./library-seed.service.js";

@Module({ controllers: [WorkspacesController], providers: [WorkspacesService, LibrarySeedService, LibrarySeedRunner], exports: [WorkspacesService, LibrarySeedService] })
export class WorkspacesModule {}
