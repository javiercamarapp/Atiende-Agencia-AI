// Seed REPETIBLE e idempotente de las dos cuentas demo de citas: Clinica Dental Sonrisa (demo) y Barberia El Filo (demo).
// Ver README.md de esta carpeta y packages/domain-citas/src/seed/citas-demo.ts para el modelo completo.
//
// Por defecto es DRY-RUN: valida los datos, imprime el plan y NO abre ninguna conexion. Escribir exige `--confirmar` Y
// `--owner-email=<correo>`, SEED_DATABASE_URL (a proposito NO se lee DATABASE_URL), imprime a que base apunta y, si no es local,
// exige repetir el host con `--confirm-host=<host>`. NUNCA lo corra contra la base real sin el OK de Javier.
//
//   node --experimental-strip-types scripts/seed-citas-demo/seed-citas-demo.ts
//   SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
//     node --experimental-strip-types scripts/seed-citas-demo/seed-citas-demo.ts --confirmar --owner-email=correo@ya-existente
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCitasSeedPlan, CitasSeedError, renderCitasSchemaPreflightSql, renderCitasSeedDoBlock } from "../../packages/domain-citas/src/seed/citas-demo.ts";
import { assertBanderasDeEscritura, assertPuedeAplicar, describirObjetivo, parseSeedArgs, SeedTargetError } from "./args.ts";

const USO = `Uso: node --experimental-strip-types scripts/seed-citas-demo/seed-citas-demo.ts [--confirmar --owner-email=<correo>] [--confirm-host=<host>] [--fecha-base=YYYY-MM-DD]
  (sin --confirmar: dry-run, no abre ninguna conexion)
  --confirmar        escribe (exige tambien --owner-email y SEED_DATABASE_URL)
  --owner-email      correo de un usuario de staff que YA existe; queda como owner de las dos cuentas demo
  --fecha-base       fecha de referencia (por omision hoy, en la zona horaria del negocio); las citas se ubican por semanas relativas a su lunes
  SEED_DATABASE_URL=postgresql://usuario@host:puerto/base   (obligatoria al escribir)`;

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const plan = buildCitasSeedPlan();
  const s = plan.summary;
  console.log(`Plan del seed demo de citas (datos ${plan.seedVersion})`);
  console.log(`  negocios: ${s.negocios}; servicios: ${s.servicios}; profesionales: ${s.proveedores}; clientes ficticios: ${s.clientes} (telefonos 5200xxxxxx, correos @example.test)`);
  for (const n of plan.negocios) {
    console.log(`    - ${n.nombre} (slug ${n.slug}, rubro ${n.rubro}, ${n.timezone}): ${n.servicios.length} servicios, ${n.proveedores.length} profesionales, ${n.excepciones.length} excepciones de horario, ${n.citas.length} citas, ${n.espera.length} en lista de espera`);
  }
  console.log(`  citas por estado: ${Object.entries(s.citasPorEstado).map(([k, v]) => `${k} ${v}`).join(", ")}; lista de espera: ${s.espera}`);
  console.log("  la semana en curso queda libre; las citas pasadas y futuras se ubican por semanas relativas al lunes de la fecha base");
  console.log("  cada organizacion queda marcada en citas.demo_organization (migracion 030): solo esas las borra limpiar-demo.ts");

  if (!args.confirmar) {
    console.log("\nDRY-RUN: no se toco ninguna base. Para escribir: SEED_DATABASE_URL=... con --confirmar y --owner-email (ver --help).");
    return 0;
  }
  assertBanderasDeEscritura(args);
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`\nBase objetivo: ${target.label}`);
  assertPuedeAplicar(target, { apply: true, confirmHost: args.confirmHost });

  // `pg` se importa solo al escribir: el dry-run y los tests no necesitan el driver.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  try {
    const faltantes = await client.query<{ faltante: string; migracion: string }>(renderCitasSchemaPreflightSql());
    if (faltantes.rows.length > 0) {
      console.error("La base no tiene el esquema que el seed necesita. Aplique primero estas migraciones:");
      for (const row of faltantes.rows) console.error(`  - falta ${row.faltante} (migracion ${row.migracion})`);
      return 3;
    }
    await client.query("begin");
    try {
      await client.query(renderCitasSeedDoBlock(plan, { ownerEmail: args.ownerEmail!, fechaBase: args.fechaBase }));
      const counts = await client.query<{ organizaciones: number; citas: number; clientes: number; espera: number }>(
        `select (select count(*)::int from core.organization o join citas.demo_organization d on d.organization_id = o.id where o.slug = any ($1)) as organizaciones,
                (select count(*)::int from citas.appointments a join core.organization o on o.id = a.organization_id where o.slug = any ($1)) as citas,
                (select count(*)::int from citas.customers c join core.organization o on o.id = c.organization_id where o.slug = any ($1)) as clientes,
                (select count(*)::int from citas.appointment_waitlist w join core.organization o on o.id = w.organization_id where o.slug = any ($1)) as espera;`,
        [plan.negocios.map((n) => n.slug)],
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
      if (err instanceof CitasSeedError || err instanceof SeedTargetError) {
        console.error(`seed-citas-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
