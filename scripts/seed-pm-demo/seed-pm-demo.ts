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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPmSeedPlan, PmSeedError, renderPmSeedDoBlock, renderSchemaPreflightSql, type PmAgentFiles, type PmSeedData } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";
import { assertPuedeAplicar, describirObjetivo, parseSeedArgs, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadSeedInputs(dataDir = path.join(HERE, "data")): { data: PmSeedData; agent: PmAgentFiles } {
  const data = JSON.parse(readFileSync(path.join(dataDir, "pm-seed-data.json"), "utf8")) as PmSeedData;
  const agent: PmAgentFiles = {
    systemPrompt: readFileSync(path.join(dataDir, "agente", "system-prompt.txt"), "utf8"),
    tools: JSON.parse(readFileSync(path.join(dataDir, "agente", "tools.json"), "utf8")),
    evals: JSON.parse(readFileSync(path.join(dataDir, "agente", "evals.json"), "utf8")),
  };
  return { data, agent };
}

const USO = `Uso: node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts [--apply] [--confirm-host=<host>] [--owner-email=<correo>]
  (sin --apply: dry-run, no abre ninguna conexion)
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria con --apply)`;

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent);
  const s = plan.summary;
  console.log(`Plan del seed "${plan.organization.name}" (slug ${plan.organization.slug}, datos ${data.version})`);
  console.log(`  sucursales: ${s.branches} (${s.activeBranches} activas; T4 registrada e inactiva, sin menu)`);
  console.log(`  productos: ${s.products} (${s.alcoholProducts} de alcohol => no_domicilio); precios por sucursal: ${s.branchProducts}`);
  console.log(`  zonas conocidas: ${s.zones} (puntos de las sucursales con coordenadas; el mapa de colonias del dueño sigue pendiente)`);
  console.log(`  promociones: ${s.promotions} cargada(s)`);
  for (const skipped of s.skippedPromotions) console.log(`  promocion NO cargada -> ${skipped}`);
  console.log("  voz: se carga DESHABILITADA en las 5 sucursales activas (sin gasto de proveedores)");

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
    const faltantes = await client.query<{ faltante: string; migracion: string }>(renderSchemaPreflightSql());
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
