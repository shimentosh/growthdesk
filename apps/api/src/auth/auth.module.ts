import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { TwoFactorController } from "./two-factor.controller.js";
import { TwoFactorService } from "./two-factor.service.js";

@Module({ controllers: [AuthController, TwoFactorController], providers: [AuthService, TwoFactorService], exports: [AuthService] })
export class AuthModule {}
