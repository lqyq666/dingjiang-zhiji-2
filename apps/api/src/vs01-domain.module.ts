import { Module } from "@nestjs/common";

import {
  MATERIAL_CONTENT_STORE,
  MaterialContentVault,
  type MaterialContentStore,
} from "./materials/content-vault";
import { Vs01Service } from "./vs01.service";
import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";
import { CommandKernelModule } from "./command-kernel/command-kernel.module";
import { GovernedCommandKernel } from "./command-kernel/governed-command-kernel";
import { MaterialVerificationCommand } from "./materials/material-verification-command";
import { EvidenceConfirmationCommand } from "./evidence/evidence-confirmation-command";

@Module({
  imports: [CommandKernelModule],
  providers: [
    {
      provide: MATERIAL_CONTENT_STORE,
      useFactory: () => new MaterialContentVault(),
    },
    {
      provide: RootCauseWorkpaperService,
      useFactory: () => new RootCauseWorkpaperService(),
    },
    {
      provide: MaterialVerificationCommand,
      inject: [GovernedCommandKernel],
      useFactory: (kernel: GovernedCommandKernel) =>
        new MaterialVerificationCommand(kernel),
    },
    {
      provide: EvidenceConfirmationCommand,
      inject: [GovernedCommandKernel],
      useFactory: (kernel: GovernedCommandKernel) =>
        new EvidenceConfirmationCommand(kernel),
    },
    {
      provide: Vs01Service,
      inject: [MATERIAL_CONTENT_STORE, RootCauseWorkpaperService],
      useFactory: (
        materialStore: MaterialContentStore,
        workpapers: RootCauseWorkpaperService,
      ) => new Vs01Service(materialStore, workpapers),
    },
  ],
  exports: [
    MATERIAL_CONTENT_STORE,
    RootCauseWorkpaperService,
    Vs01Service,
    MaterialVerificationCommand,
    EvidenceConfirmationCommand,
  ],
})
export class Vs01DomainModule {}
