import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { MaterialVerificationCommand } from "../materials/material-verification-command";
import { createPool, migrate } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { EvidenceIntakeAcceptanceFixtureBuilder } from "./evidence-intake-acceptance-fixture";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
} from "./material-create-acceptance-fixture";

const confirmation = "--create-non-production-evidence-fixture";

const run = async () => {
  if (!process.argv.includes(confirmation))
    throw new Error(
      `Pass ${confirmation} to create isolated local fixture data`,
    );
  const pool = createPool();
  const business = new Vs01Service();
  const kernel = new GovernedCommandKernel(
    new PostgresGovernedCommandStore(pool),
  );
  try {
    await migrate(pool);
    await business.onModuleInit();
    const fixture = await new EvidenceIntakeAcceptanceFixtureBuilder(
      new MaterialCreateAcceptanceFixtureBuilder(
        new PostgresAcceptanceSourceTaskRepository(pool),
        business,
      ),
      new MaterialCreateCommand(kernel),
      new MaterialVerificationCommand(kernel),
    ).create();
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await business.onModuleDestroy();
    await pool.end();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "fixture creation failed"}\n`,
  );
  process.exitCode = 1;
});
