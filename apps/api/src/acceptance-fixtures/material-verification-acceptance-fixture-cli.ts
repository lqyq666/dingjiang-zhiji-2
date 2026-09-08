import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { createPool, migrate } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  MaterialVerificationAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
} from "./material-create-acceptance-fixture";

const confirmation = "--confirm-local-acceptance";

async function main(): Promise<void> {
  if (!process.argv.includes(confirmation))
    throw new Error(
      `Pass ${confirmation} to create isolated local fixture data`,
    );
  const pool = createPool();
  const business = new Vs01Service();
  try {
    await migrate(pool);
    await business.onModuleInit();
    const base = new MaterialCreateAcceptanceFixtureBuilder(
      new PostgresAcceptanceSourceTaskRepository(pool),
      business,
    );
    const fixture = await new MaterialVerificationAcceptanceFixtureBuilder(
      base,
      new MaterialCreateCommand(
        new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
      ),
    ).create();
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await business.onModuleDestroy();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "fixture creation failed"}\n`,
  );
  process.exitCode = 1;
});
