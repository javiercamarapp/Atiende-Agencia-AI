// Quita la cuenta demo de rentas (Rn-33): borra la organizacion `demo-rentas-gestora` (todo lo suyo cae en cascada) y los propietarios que
// solo pertenecian a ella. Solo toca esa organizacion de rentas. Mismas salvaguardas que el seed: dry-run por omision, `--confirmar` para
// escribir, SEED_DATABASE_URL (nunca DATABASE_URL), la base objetivo siempre se imprime y una base no local exige `--confirm-host` y
// `--confirmar-produccion`.
//
//   node --experimental-strip-types scripts/seed-rentas-demo/limpiar-demo.ts [--confirmar]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRentasLimpiarDoBlock, RentasSeedError } from "../../packages/domain-rentas/src/seed/rentas-demo.ts";
import { SLUG_DEMO_RENTAS } from "../../packages/domain-rentas/src/seed/rentas-demo-data.ts";
import { assertObjetivoPermitido, describirObjetivo, parseSeedArgs, SeedTargetError } from "./args.ts";

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Uso: node --experimental-strip-types scripts/seed-rentas-demo/limpiar-demo.ts [--confirmar] [--confirm-host=<host> --confirmar-produccion]\n  (sin --confirmar: dry-run)\n  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base");
    return 0;
  }
  console.log(`Limpieza de la cuenta demo de rentas (slug ${SLUG_DEMO_RENTAS}): borra la organizacion y los propietarios que solo eran de ella.`);
  if (args.dryRun || !args.confirmar) {
    console.log("DRY-RUN: no se toco ninguna base. Para borrar: SEED_DATABASE_URL=... con --confirmar.");
    return 0;
  }
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`Base objetivo: ${target.label}`);
  assertObjetivoPermitido(target, args);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    try {
      await client.query(renderRentasLimpiarDoBlock());
      const r = await client.query<{ quedan: number }>("select count(*)::int as quedan from core.organization where slug = $1 and vertical = 'rentas';", [SLUG_DEMO_RENTAS]);
      await client.query("commit");
      console.log(`Listo. Organizaciones demo que quedan: ${r.rows[0]?.quedan ?? 0}.`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  } finally {
    await client.end();
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof RentasSeedError || err instanceof SeedTargetError) {
        console.error(`limpiar-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
