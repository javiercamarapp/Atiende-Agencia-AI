// Limpieza de la cuenta demo (R-20): borra lo ficticio por modo, o la organizacion demo completa. Invoca la funcion SQL
// `restaurantes.demo_limpiar` (migracion 037), que SOLO opera sobre organizaciones marcadas como demo y borra por el rango de
// telefonos ficticios (0001 = volumen, 0009 = sesiones del widget): nunca toca pedidos, clientes ni conversaciones reales.
//
// Por defecto es DRY-RUN: cuenta lo que se borraria y NO borra nada. Borrar exige `--apply` + SEED_DATABASE_URL y, si la base no es
// local, `--confirm-host=<host exacto>`. Runbook: docs/DEMO-PM-CARGA.md.
//
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=volumen            (dry-run)
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=todo --apply --confirm-host=<host>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPuedeAplicar, describirObjetivo, parseCleanupArgs, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

const USO = `Uso: node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=volumen|sesiones_widget|todo [--horas=N] [--org-slug=<slug>] [--apply] [--confirm-host=<host>]
  --modo volumen          pedidos, clientes y conversaciones del seed de volumen (telefonos 0001xxxxxx)
  --modo sesiones_widget  conversaciones, tomas de handoff, pedidos y clientes del widget publico (telefonos 0009xxxxxx)
  --modo todo             la organizacion demo completa (cascada); se niega si no esta marcada como demo
  --horas=N               solo lo que tenga al menos N horas (util para sesiones_widget); por omision todo
  (sin --apply: dry-run, solo cuenta; SEED_DATABASE_URL obligatoria)`;

async function main(): Promise<number> {
  const args = parseCleanupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`Base objetivo: ${target.label}`);
  if (args.apply) assertPuedeAplicar(target, { apply: true, confirmHost: args.confirmHost });

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  try {
    const org = await client.query<{ id: string; demo: boolean }>(
      `select o.id, (d.organization_id is not null) as demo from core.organization o left join restaurantes.demo_organization d on d.organization_id = o.id where o.slug = $1;`,
      [args.orgSlug],
    );
    if (!org.rows[0]) {
      console.error(`La organizacion "${args.orgSlug}" no existe.`);
      return 4;
    }
    if (!org.rows[0].demo) {
      console.error(`La organizacion "${args.orgSlug}" NO esta marcada como demo: la limpieza se niega a tocarla.`);
      return 4;
    }
    const prefijo = args.modo === "volumen" ? "0001" : "0009";
    if (args.modo !== "todo") {
      const c = await client.query<{ pedidos: number; clientes: number; conversaciones: number }>(
        `select (select count(*)::int from restaurantes.orders where organization_id = $1 and right(regexp_replace(customer_phone, '\\D', '', 'g'), 10) like $2 || '%') as pedidos,
                (select count(*)::int from restaurantes.customers where organization_id = $1 and right(regexp_replace(phone, '\\D', '', 'g'), 10) like $2 || '%') as clientes,
                (select count(*)::int from restaurantes.whatsapp_conversations where organization_id = $1 and right(regexp_replace(phone, '\\D', '', 'g'), 10) like $2 || '%') as conversaciones;`,
        [org.rows[0].id, prefijo],
      );
      console.log(`Se borrarian (modo ${args.modo}):`, c.rows[0]);
    } else {
      console.log(`Se borraria la organizacion demo "${args.orgSlug}" completa (sucursales, menu, pedidos, clientes, conversaciones, configuracion).`);
    }
    if (!args.apply) {
      console.log("\nDRY-RUN: no se borro nada. Para borrar: repita con --apply (ver --help).");
      return 0;
    }
    const r = await client.query<{ demo_limpiar: unknown }>(`select restaurantes.demo_limpiar($1, $2, $3) as demo_limpiar;`, [org.rows[0].id, args.modo, args.horas]);
    console.log("Limpieza aplicada:", r.rows[0]?.demo_limpiar);
  } finally {
    await client.end();
  }
  return 0;
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
