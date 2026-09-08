import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { IdentityService } from "./identity.service";
import { IdentityController, ProductionAccessGuard } from "./identity-http";

@Global()
@Module({
  controllers: [IdentityController],
  providers: [
    { provide: IdentityService, useFactory: () => new IdentityService() },
    { provide: APP_GUARD, useClass: ProductionAccessGuard },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
