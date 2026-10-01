// Seed de VOLUMEN de la cuenta demo (R-20): pedidos historicos creados con el motor real, clientes, conversaciones, handoffs y
// contactos coherentes por sucursal, en America/Merida, idempotente y borrable (todo vive en el rango ficticio 0001xxxxxx).
//
// Por defecto es DRY-RUN: genera el volumen contra un mundo EN MEMORIA con el menu del seed de PM, imprime el resumen y NO abre
// ninguna conexion. Escribir exige `--apply` + SEED_DATABASE_URL (a proposito NO se lee DATABASE_URL), la organizacion debe estar
// marcada como demo (`seed-pm-demo.ts --demo`, migracion 037) y, si la base no es local, `--confirm-host=<host exacto>`.
// NUNCA lo corra contra la base real sin el OK del dueño del proyecto. Runbook: docs/DEMO-PM-CARGA.md.
//
//   node --experimental-strip-types scripts/seed-pm-demo/seed-volumen.ts [--escala=ligero|moderado|completo] [--dias=N] [--pedidos-por-dia=N]
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-pm-demo/seed-volumen.ts --apply [--confirm-host=<host>]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPmSeedPlan } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../../packages/domain-restaurantes/src/seed/pm-world.ts";
import { DEMO_VOLUME_SCALES, DemoVolumeError, generarVolumenDemo, type DemoVolumeSummary } from "../../packages/domain-restaurantes/src/seed/demo-volume.ts";
import { DemoVolumeSqlError, renderDemoVolumeDoBlock, renderVolumePreflightSql } from "../../packages/domain-restaurantes/src/seed/demo-volume-sql.ts";
import { assertPuedeAplicar, describirObjetivo, parseVolumeArgs, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";
import { PostgresRestaurantesRepository } from "../../packages/domain-restaurantes/src/postgres-repository.ts";
import { loadSeedInputs } from "./inputs.ts";
import { sesionDesdePg } from "./pg-session.ts";

const USO = `Uso: node --experimental-strip-types scripts/seed-pm-demo/seed-volumen.ts [--org-slug=<slug>] [--escala=ligero|moderado|completo]
       [--dias=N] [--pedidos-por-dia=N] [--semilla=N] [--apply] [--confirm-host=<host>]
  (sin --apply: dry-run contra un mundo en memoria, no abre ninguna conexion)
  --org-slug   por omision los-taquitos-de-pm-demo (debe estar marcada como demo)
  --escala     ligero = 30 dias x 12/dia; moderado (por omision) = 90 dias x 24/dia (~2,200 pedidos); completo = 90 dias x 1000/dia (~90,000, OPCIONAL)
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria con --apply)`;

function opciones(args: ReturnType<typeof parseVolumeArgs>) {
  const base = DEMO_VOLUME_SCALES[args.escala];
  return { dias: args.dias ?? base.dias, pedidosPorDia: args.pedidosPorDia ?? base.pedidosPorDia, seed: args.semilla ?? undefined };
}

function imprimirResumen(s: DemoVolumeSummary, titulo: string) {
  console.log(`${titulo}: ${s.orders} pedidos, ${s.customers} clientes, ${s.omitidos} omitidos por el motor (reglas duras) entre ${s.desde.slice(0, 10)} y ${s.hasta.slice(0, 10)}`);
  for (const [slug, n] of Object.entries(s.porSucursal).sort()) console.log(`  ${slug}: ${n}`);
}

async function main(): Promise<number> {
  const args = parseVolumeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const opts = opciones(args);
  console.log(`Seed de volumen de "${args.orgSlug}": ${opts.dias} dias x ~${opts.pedidosPorDia} pedidos/dia (escala ${args.escala}${args.escala === "completo" ? ", ~90,000 pedidos: opcion pesada" : ""})`);

  if (!args.apply) {
    const { data, agent } = loadSeedInputs();
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent, { demo: true }), { deterministic: true });
    const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, ...opts });
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        imprimirResumen(r.value, "DRY-RUN (mundo en memoria, el menu del seed de PM)");
        break;
      }
    }
    console.log("\nDRY-RUN: no se toco ninguna base. Para escribir: SEED_DATABASE_URL=... con --apply (ver --help).");
    return 0;
  }

  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`Base objetivo: ${target.label}`);
  assertPuedeAplicar(target, { apply: args.apply, confirmHost: args.confirmHost });

  const { default: pg } = await import("pg");
  const lector = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  const escritor = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await lector.connect();
  await escritor.connect();
  try {
    const faltantes = await escritor.query<{ faltante: string; migracion: string }>(renderVolumePreflightSql());
    if (faltantes.rows.length > 0) {
      console.error("La base no tiene el esquema que el seed de volumen necesita. Aplique primero estas migraciones:");
      for (const row of faltantes.rows) console.error(`  - falta ${row.faltante} (migracion ${row.migracion})`);
      return 3;
    }
    const { rows } = await escritor.query<{ id: string }>(
      `select o.id from core.organization o join restaurantes.demo_organization d on d.organization_id = o.id where o.slug = $1;`,
      [args.orgSlug],
    );
    if (!rows[0]) {
      console.error(`La organizacion "${args.orgSlug}" no existe o NO esta marcada como demo. Cargue primero: seed-pm-demo.ts --demo --apply`);
      return 4;
    }
    // Lectura del catalogo con el repositorio REAL de Postgres, en una transaccion de solo lectura (los SAVEPOINT del repositorio la exigen).
    await lector.query("begin read only");
    const repo = new PostgresRestaurantesRepository(sesionDesdePg(lector));
    const gen = generarVolumenDemo(repo, { organizationId: rows[0].id, ...opts });
    let lotes = 0;
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        imprimirResumen(r.value, "Volumen aplicado (idempotente: puede repetirse)");
        break;
      }
      const b = r.value;
      if (b.orders.length + b.customers.length + b.conversations.length + b.handoffs.length + b.callbacks.length === 0) continue;
      await escritor.query(renderDemoVolumeDoBlock(args.orgSlug, b)); // cada lote es su propia transaccion: una interrupcion se puede reanudar
      lotes += 1;
      if (lotes % 10 === 0) process.stdout.write(`  ${lotes} lotes...\r`);
    }
    await lector.query("rollback");
    const conteo = await escritor.query<{ pedidos: number; clientes: number; conversaciones: number }>(
      `select (select count(*)::int from restaurantes.orders where organization_id = $1 and customer_phone ~ '^0001[0-9]{6}$') as pedidos,
              (select count(*)::int from restaurantes.customers where organization_id = $1 and phone ~ '^0001[0-9]{6}$') as clientes,
              (select count(*)::int from restaurantes.whatsapp_conversations where organization_id = $1 and right(phone, 10) ~ '^0001[0-9]{6}$') as conversaciones;`,
      [rows[0].id],
    );
    console.log("Estado en la base (solo lo ficticio del rango 0001):", conteo.rows[0]);
  } finally {
    await lector.end();
    await escritor.end();
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof DemoVolumeError || err instanceof DemoVolumeSqlError || err instanceof SeedTargetError) {
        console.error(`seed-volumen: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
