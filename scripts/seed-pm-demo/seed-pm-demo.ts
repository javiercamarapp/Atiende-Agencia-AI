// Seed REPETIBLE e idempotente de la cuenta demo "Los Taquitos de PM" (R-01). Ver README.md de esta
// carpeta y packages/domain-restaurantes/src/seed/pm-demo.ts para el modelo completo.
//
// Por defecto es DRY-RUN: valida los datos, imprime el plan y NO abre ninguna conexion. Escribir exige
// `--apply` + SEED_DATABASE_URL (a proposito NO se lee DATABASE_URL), imprime a que base apunta y, si no es
// local, exige repetir el host con `--confirm-host=<host>`. NUNCA lo corra contra la base real sin el OK
// de Javier.
//
//   node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts
//   SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
//     node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts --apply [--owner-email=correo@existente]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPmSeedPlan, PmSeedError, renderPmSeedDoBlock, renderSchemaPreflightSql } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";
import { assertPuedeAplicar, describirObjetivo, parseSeedArgs, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";
import { loadSeedInputs } from "./inputs.ts";

export { loadSeedInputs };

const USO = `Uso: node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts [--demo] [--apply] [--confirm-host=<host>] [--owner-email=<correo>]
  --demo: carga la cuenta como DEMO (slug los-taquitos-de-pm-demo, marca is_demo; requiere la migracion 037)
  (sin --apply: dry-run, no abre ninguna conexion)
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria con --apply)`;

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent, { demo: args.demo });
  const s = plan.summary;
  console.log(`Plan del seed "${plan.organization.name}" (slug ${plan.organization.slug}, datos ${data.version})`);
  console.log(`  sucursales: ${s.branches} (${s.activeBranches} activas; T4 registrada e inactiva; T2, T7 y T8 sin catalogo hasta la respuesta P5)`);
  for (const b of plan.branches) console.log(`    - ${b.name} (${b.status}): ${b.catalogSize} productos`);
  console.log(`  productos: ${s.products} (${s.alcoholProducts} de alcohol => no_domicilio); precios por sucursal: ${s.branchProducts}`);
  console.log(`  zonas conocidas: ${s.zones} (puntos de las sucursales con coordenadas)`);
  console.log(`  colonias (lista unica, sin coordenadas en known_zone): ${s.colonias} (+${s.coloniasEnZonaDeSucursal} que es el punto de una sucursal): ${s.coloniasAsignadas} a su sucursal de despacho mas cercana (${s.coberturasColonias} filas de cobertura, ${s.coloniasCubiertasPorDos} con dos sucursales) y ${s.coloniasSinAsignar} FUERA de cobertura sin asignar (a mas de 8 km de toda sucursal de despacho o sin coordenada; van al reporte de revision)`);
  console.log(`  promociones: ${s.promotions} cargada(s)`);
  for (const skipped of s.skippedPromotions) console.log(`  promocion NO cargada -> ${skipped}`);
  console.log(`  voz: se carga DESHABILITADA en las ${plan.voice.greetings.length} sucursales activas (sin gasto de proveedores)`);
  console.log(`  agente de WhatsApp: perfil ${plan.whatsappAgent.perfil}, tono ${plan.whatsappAgent.toneStyle}, tiempo de entrega "${plan.whatsappAgent.deliveryTimeText}" (re-ejecutar no pisa lo que el dueño cambie)`);
  console.log(`  modo: ${plan.demo ? "DEMO (marca restaurantes.demo_organization)" : "cuenta normal (sin marca demo)"}`);
  console.log(`  pendientes del dueño (no se inventan): ${plan.pendientes.filter((x) => x.estado !== "resuelta").length} abiertos de ${plan.pendientes.length}`);
  for (const p of plan.pendientes.filter((x) => x.estado !== "resuelta")) console.log(`    - ${p.titulo}`);

  if (!args.apply) {
    console.log("\nDRY-RUN: no se toco ninguna base. Para escribir: SEED_DATABASE_URL=... con --apply (ver --help).");
    return 0;
  }

  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`\nBase objetivo: ${target.label}`);
  assertPuedeAplicar(target, { apply: args.apply, confirmHost: args.confirmHost });

  // `pg` se importa solo al escribir: el dry-run y los tests no necesitan el driver.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  try {
    const faltantes = await client.query<{ faltante: string; migracion: string }>(renderSchemaPreflightSql({ demo: args.demo }));
    if (faltantes.rows.length > 0) {
      console.error("La base no tiene el esquema que el seed necesita. Aplique primero estas migraciones:");
      for (const row of faltantes.rows) console.error(`  - falta ${row.faltante} (migracion ${row.migracion})`);
      return 3;
    }
    await client.query("begin");
    try {
      await client.query(renderPmSeedDoBlock(plan, { ownerEmail: args.ownerEmail }));
      const counts = await client.query<{ sucursales: number; productos: number; precios: number; alcohol_no_domicilio: number }>(
        `select (select count(*)::int from core.property p join core.organization o on o.id = p.organization_id where o.slug = $1) as sucursales,
                (select count(*)::int from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = $1) as productos,
                (select count(*)::int from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = $1) as precios,
                (select count(*)::int from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = $1 and pr.no_domicilio) as alcohol_no_domicilio;`,
        [plan.organization.slug],
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
      if (err instanceof PmSeedError || err instanceof SeedTargetError) {
        console.error(`seed-pm-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
