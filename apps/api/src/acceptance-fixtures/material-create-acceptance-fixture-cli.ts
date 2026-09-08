import { createPool, migrate } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import {
  MaterialCreateAcceptanceFixtureBuilder,
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
    const fixture = await new MaterialCreateAcceptanceFixtureBuilder(
      new PostgresAcceptanceSourceTaskRepository(pool),
      business,
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
