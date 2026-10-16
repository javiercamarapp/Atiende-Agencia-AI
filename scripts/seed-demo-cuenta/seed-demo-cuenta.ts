// Seed REPETIBLE e idempotente de la cuenta demo FICTICIA «El Tizon Norteño» (6 sucursales, 289 productos). Ver README.md de esta carpeta.
//
// Por defecto es DRY-RUN: valida la definicion, imprime el plan y NO abre ninguna conexion. Escribir exige `--apply` + SEED_DATABASE_URL (a proposito NO se
// lee DATABASE_URL), imprime a que base apunta y, si no es local, exige repetir el host con `--confirm-host=<host>`. NUNCA lo corra contra la base real sin
// el OK de Javier. No toca la organizacion `demo-restaurantes` (Taqueria Demo): su slug esta prohibido para esta cuenta.
//
//   npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts
//   npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --emit-sql=demo-cuenta.sql [--owner-email=correo@existente]   (genera un .sql para pegar en el SQL Editor de Supabase; sin conexion)
//   SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --apply
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/args.ts";
import { DEMO_CUENTA } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/definicion.ts";
import { construirPlanDemoCuenta, DemoCuentaError } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaArchivoSql } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/emit-sql.ts";
import { normalizarOwnerEmail, renderDemoCuentaDoBlock, renderEsquemaRequeridoDemoCuenta } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/sql.ts";
import { assertPuedeAplicar, describirObjetivo, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

const USO = `Uso: vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- [--apply] [--confirm-host=<host>] [--owner-email=<correo>]
     vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --emit-sql=<archivo.sql> [--owner-email=<correo>]
  (sin --apply: dry-run, no abre ninguna conexion)
  --emit-sql=<archivo>: escribe un .sql completo (begin ... commit + verificacion) para pegarlo en el SQL Editor de Supabase; NO abre conexion ni pide credenciales
  --owner-email=<correo>: enlaza como owner a un usuario de staff que YA existe con ese correo (opcional; sin el, la cuenta queda sin dueno)
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

  if (args.emitSql !== null) {
    const destino = path.resolve(args.emitSql);
    const sql = renderDemoCuentaArchivoSql(plan, { ownerEmail: args.ownerEmail });
    mkdirSync(path.dirname(destino), { recursive: true });
    try {
      writeFileSync(destino, sql, "utf8"); // sin chequeo previo con stat (carrera TOCTOU): si es un directorio, el propio write falla con EISDIR
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EISDIR") throw new SeedTargetError(`--emit-sql apunta a un directorio: ${destino}`);
      throw err;
    }
    const duenio = normalizarOwnerEmail(args.ownerEmail);
    console.log(`\nSQL generado SIN abrir ninguna conexion: ${destino}`);
    console.log(`  ${sql.split("\n").length} lineas, ${Buffer.byteLength(sql, "utf8")} bytes, sha256 ${createHash("sha256").update(sql).digest("hex")}`);
    console.log(`  dueno: ${duenio ? `membresia owner si ya existe el usuario de staff ${duenio}` : "ninguno (la cuenta queda sin dueno)"}`);
    console.log("  Siguiente: revise el archivo, peguelo completo en el SQL Editor de Supabase (rol postgres), ejecute y compruebe que la tabla final tenga ok = true.");
    return 0;
  }
  if (args.ownerEmail !== null && !args.apply) normalizarOwnerEmail(args.ownerEmail); // valida el correo tambien en el dry-run

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
      await client.query(renderDemoCuentaDoBlock(plan, { ownerEmail: args.ownerEmail }));
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
