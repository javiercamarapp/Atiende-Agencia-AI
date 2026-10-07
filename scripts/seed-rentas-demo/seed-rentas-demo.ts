// Seed REPETIBLE e idempotente de la cuenta demo de rentas "Gestora Demo Rentas (demo)" (Rn-33). Ver README.md de esta carpeta y
// packages/domain-rentas/src/seed/rentas-demo.ts para el modelo completo.
//
// Por defecto es DRY-RUN: valida los datos (parseando los .ics de fixtures/ con el parser real), imprime el plan y NO abre ninguna conexion.
// Escribir exige `--confirmar` Y `--owner-email=<correo>`, SEED_DATABASE_URL (a proposito NO se lee DATABASE_URL) e imprime a que base apunta;
// una base que no sea local se trata como produccion y exige ademas `--confirm-host=<host>` y `--confirmar-produccion`.
// NUNCA lo corra contra la base real sin el OK de Javier.
//
//   node --experimental-strip-types scripts/seed-rentas-demo/seed-rentas-demo.ts [--dry-run]
//   SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
//     node --experimental-strip-types scripts/seed-rentas-demo/seed-rentas-demo.ts --confirmar --owner-email=correo@ya-existente
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRentasSeedPlan, RentasSeedError, renderRentasSchemaPreflightSql, renderRentasSeedDoBlock } from "../../packages/domain-rentas/src/seed/rentas-demo.ts";
import { assertBanderasDeEscritura, assertObjetivoPermitido, describirObjetivo, parseSeedArgs, SeedTargetError } from "./args.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function cargarFixturesIcs(dir = path.join(HERE, "fixtures")): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ics")).sort()) out[f] = readFileSync(path.join(dir, f), "utf8");
  return out;
}

const USO = `Uso: node --experimental-strip-types scripts/seed-rentas-demo/seed-rentas-demo.ts [--dry-run] [--confirmar --owner-email=<correo>] [--confirm-host=<host> --confirmar-produccion]
  (sin --confirmar: dry-run, no abre ninguna conexion)
  --confirmar             escribe (exige tambien --owner-email y SEED_DATABASE_URL)
  --owner-email           correo de un usuario de staff que YA existe; queda como admin_gestora de la cuenta demo
  --confirm-host          host exacto de la base cuando NO es local
  --confirmar-produccion  obligatoria con una base no local (NUNCA sin el OK de Javier)
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria al escribir)`;

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const plan = buildRentasSeedPlan(cargarFixturesIcs());
  const s = plan.summary;
  console.log(`Plan del seed demo de rentas (datos ${plan.seedVersion})`);
  console.log(`  organizacion: ${plan.organizacion.nombre} (slug ${plan.organizacion.slug}; el prefijo demo- es la marca de cuenta demo)`);
  console.log(`  ${s.propiedades} propiedades, ${s.unidades} unidades, ${s.propietarios} propietarios; datos ficticios (apellido Demo, correos @example.test)`);
  for (const p of plan.propiedades) console.log(`    - ${p.nombre} (${p.zonaHoraria}): ${p.unidades.map((u) => u.nombre).join(", ")}`);
  console.log(`  feeds iCal: ${s.feeds} (URLs .invalid: nunca consultan internet; las reservas salen de los .ics de fixtures/)`);
  console.log(`  reservas: ${s.reservasImportadas} importadas + ${s.reservasDirectas} directas; bloqueos: ${s.bloqueos}; conflictos abiertos: ${s.conflictosAbiertos}`);
  console.log(`  movimientos financieros: ${s.movimientosFinancieros}; reglas de comision: ${s.reglasComision}`);
  console.log(`  tareas: ${s.tareas}; incidencias: ${s.incidencias}; plantillas: ${s.plantillas} (${s.plantillasAprobadas} aprobadas); borradores pendientes: ${s.borradoresPendientes}`);
  console.log("  las fechas son relativas a HOY en la zona de cada propiedad; re-ejecutar no duplica (llaves por external_id, nombre o correo)");
  console.log("  para quitar la demo: node --experimental-strip-types scripts/seed-rentas-demo/limpiar-demo.ts (dry-run) / --confirmar");

  if (args.dryRun || !args.confirmar) {
    console.log("\nDRY-RUN: no se toco ninguna base. Para escribir: SEED_DATABASE_URL=... con --confirmar y --owner-email (ver --help).");
    return 0;
  }
  assertBanderasDeEscritura(args);
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`\nBase objetivo: ${target.label}`);
  assertObjetivoPermitido(target, args);

  // `pg` se importa solo al escribir: el dry-run y los tests no necesitan el driver.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  try {
    const faltantes = await client.query<{ faltante: string; migracion: string }>(renderRentasSchemaPreflightSql());
    if (faltantes.rows.length > 0) {
      console.error("La base no tiene el esquema que el seed necesita. Aplique primero estas migraciones:");
      for (const row of faltantes.rows) console.error(`  - falta ${row.faltante} (migracion ${row.migracion})`);
      return 3;
    }
    await client.query("begin");
    try {
      await client.query(renderRentasSeedDoBlock(plan, { ownerEmail: args.ownerEmail! }));
      const counts = await client.query<{ propiedades: number; unidades: number; reservas: number; conflictos_abiertos: number; tareas: number }>(
        `select (select count(*)::int from core.property p join core.organization o on o.id = p.organization_id where o.slug = $1) as propiedades,
                (select count(*)::int from rentas.unidad u join core.organization o on o.id = u.organization_id where o.slug = $1) as unidades,
                (select count(*)::int from rentas.ocupacion oc join core.organization o on o.id = oc.organization_id where o.slug = $1 and oc.capa = 'reserva') as reservas,
                (select count(*)::int from rentas.conflicto_calendario k join core.organization o on o.id = k.organization_id where o.slug = $1 and k.resuelto_en is null) as conflictos_abiertos,
                (select count(*)::int from rentas.tarea_operativa t join core.organization o on o.id = t.organization_id where o.slug = $1) as tareas;`,
        [plan.organizacion.slug],
      );
      await client.query("commit");
      console.log("Seed aplicado (idempotente: puede repetirse). Estado en la base:", counts.rows[0]);
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
        console.error(`seed-rentas-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
