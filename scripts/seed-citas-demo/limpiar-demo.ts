// Limpieza de las cuentas demo de citas: borra la organizacion demo completa (citas, clientes, profesionales, servicios, horario,
// lista de espera, configuracion). Invoca la funcion SQL `citas.demo_limpiar` (migracion 030), que SOLO opera sobre organizaciones
// marcadas en `citas.demo_organization`; ademas esta CLI se niega a tocar una organizacion que no este marcada ANTES de llamarla.
// Nunca toca otra organizacion, aunque comparta nombre o profesionales.
//
// Por defecto es DRY-RUN: cuenta lo que se borraria y NO borra nada. Borrar exige `--confirmar` + SEED_DATABASE_URL y, si la base
// no es local, `--confirm-host=<host exacto>`.
//
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-citas-demo/limpiar-demo.ts --todas            (dry-run)
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-citas-demo/limpiar-demo.ts --org-slug=barberia-el-filo-demo --confirmar --confirm-host=<host>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPuedeAplicar, describirObjetivo, parseLimpiarArgs, SeedTargetError } from "./args.ts";

const USO = `Uso: node --experimental-strip-types scripts/seed-citas-demo/limpiar-demo.ts (--org-slug=<slug> [--org-slug=...] | --todas) [--confirmar] [--confirm-host=<host>]
  --todas      las dos cuentas demo del seed
  (sin --confirmar: dry-run, solo cuenta; SEED_DATABASE_URL obligatoria)`;

async function main(): Promise<number> {
  const args = parseLimpiarArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`Base objetivo: ${target.label}`);
  if (args.confirmar) assertPuedeAplicar(target, { apply: true, confirmHost: args.confirmHost });

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  let codigo = 0;
  try {
    for (const slug of args.slugs) {
      const org = await client.query<{ id: string; demo: boolean }>(
        `select o.id, (d.organization_id is not null) as demo from core.organization o left join citas.demo_organization d on d.organization_id = o.id where o.slug = $1;`,
        [slug],
      );
      if (!org.rows[0]) {
        console.log(`- ${slug}: no existe; nada que borrar.`);
        continue;
      }
      if (!org.rows[0].demo) {
        console.error(`- ${slug}: NO esta marcada como demo de citas; la limpieza se niega a tocarla.`);
        codigo = 4;
        continue;
      }
      const c = await client.query<{ citas: number; clientes: number; espera: number }>(
        `select (select count(*)::int from citas.appointments where organization_id = $1) as citas,
                (select count(*)::int from citas.customers where organization_id = $1) as clientes,
                (select count(*)::int from citas.appointment_waitlist where organization_id = $1) as espera;`,
        [org.rows[0].id],
      );
      console.log(`- ${slug}: se borrarian`, c.rows[0], "y la organizacion completa");
      if (!args.confirmar) continue;
      const r = await client.query<{ demo_limpiar: unknown }>(`select citas.demo_limpiar($1) as demo_limpiar;`, [org.rows[0].id]);
      console.log(`  limpieza aplicada:`, r.rows[0]?.demo_limpiar);
    }
    if (!args.confirmar) console.log("\nDRY-RUN: no se borro nada. Para borrar: repita con --confirmar (ver --help).");
  } finally {
    await client.end();
  }
  return codigo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof SeedTargetError) {
        console.error(`limpiar-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
