import { Module } from "@nestjs/common";

import { GovernedCommandKernel } from "./governed-command-kernel";
import { GovernedCommandExceptionFilter } from "./governed-command-http";
import { PostgresGovernedCommandStore } from "./postgres-governed-command-store";

@Module({
  providers: [
    PostgresGovernedCommandStore,
    GovernedCommandExceptionFilter,
    {
      provide: GovernedCommandKernel,
      inject: [PostgresGovernedCommandStore],
      useFactory: (store: PostgresGovernedCommandStore) =>
        new GovernedCommandKernel(store),
    },
  ],
  exports: [GovernedCommandKernel, GovernedCommandExceptionFilter],
})
export class CommandKernelModule {}
