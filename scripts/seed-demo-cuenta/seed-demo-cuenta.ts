// Seed REPETIBLE e idempotente de la cuenta demo FICTICIA «El Tizon Norteño» (6 sucursales, 289 productos). Ver README.md de esta carpeta.
//
// Por defecto es DRY-RUN: valida la definicion, imprime el plan y NO abre ninguna conexion. Escribir exige `--apply` + SEED_DATABASE_URL (a proposito NO se
// lee DATABASE_URL), imprime a que base apunta y, si no es local, exige repetir el host con `--confirm-host=<host>`. NUNCA lo corra contra la base real sin
// el OK de Javier. No toca la organizacion `demo-restaurantes` (Taqueria Demo): su slug esta prohibido para esta cuenta.
//
//   npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts
//   SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --apply
import { parseArgs } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/args.ts";
import { DEMO_CUENTA } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/definicion.ts";
import { construirPlanDemoCuenta, DemoCuentaError } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaDoBlock, renderEsquemaRequeridoDemoCuenta } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/sql.ts";
import { assertPuedeAplicar, describirObjetivo, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

const USO = `Uso: vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- [--apply] [--confirm-host=<host>]
  (sin --apply: dry-run, no abre ninguna conexion)
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria con --apply)`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const plan = construirPlanDemoCuenta(DEMO_CUENTA);
  const s = plan.summary;
  console.log(`Plan del seed "${plan.organization.name}" (slug ${plan.organization.slug}, version ${plan.organization.seedVersion})`);
  console.log(`  sucursales: ${s.branches}`);
  for (const b of plan.branches) console.log(`    - ${b.name} (${b.zonaHoraria}): ${b.catalogSize} productos`);
  console.log(`  productos: ${s.products} en ${s.categories} categorias (${s.alcoholProducts} de alcohol => no_domicilio); precios por sucursal: ${s.branchProducts} (${s.unavailableBranchProducts} agotados hoy)`);
  console.log(`  colonias de reparto: ${s.colonias} (${s.coberturas} filas de cobertura); promociones: ${s.promotions}; conocimiento: ${s.conocimiento}`);
  console.log("  voz: DESHABILITADA (sin gasto de proveedores). No se crean usuarios, credenciales ni pedidos.");

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
    const faltantes = await client.query<{ faltante: string; migracion: string }>(renderEsquemaRequeridoDemoCuenta());
    if (faltantes.rows.length > 0) {
      console.error("La base no tiene el esquema que el seed necesita. Aplique primero estas migraciones:");
      for (const row of faltantes.rows) console.error(`  - falta ${row.faltante} (migracion ${row.migracion})`);
      return 3;
    }
    await client.query("begin");
    try {
      await client.query(renderDemoCuentaDoBlock(plan));
      const counts = await client.query(
        `select (select count(*)::int from core.property p join core.organization o on o.id = p.organization_id where o.slug = $1) as sucursales,
                (select count(*)::int from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = $1) as productos,
                (select count(*)::int from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = $1) as precios;`,
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

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof DemoCuentaError || err instanceof SeedTargetError) {
      console.error(`seed-demo-cuenta: ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  },
);
