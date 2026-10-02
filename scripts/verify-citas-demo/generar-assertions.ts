// Genera scripts/verify-citas-demo/assertions.sql = cabecera + funciones (cuerpo REAL del seed, `renderCitasSeedPlpgsql`) +
// escenarios.sql. Un test de vitest compara el archivo commiteado contra esta salida: si el seed cambia y assertions.sql no se
// regenera, falla.
//
//   node --experimental-strip-types scripts/verify-citas-demo/generar-assertions.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCitasSeedPlan, claveIdempotencia, renderCitasSchemaPreflightSql, renderCitasSeedPlpgsql } from "../../packages/domain-citas/src/seed/citas-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function construirAssertions(): string {
  const plan = buildCitasSeedPlan();
  const funcion = (nombre: string, opciones: { ownerEmail: string; fechaBase?: string | null }) =>
    `create or replace function public.${nombre}() returns void language plpgsql as $seed_fn$\n${renderCitasSeedPlpgsql(plan, opciones)}\n$seed_fn$;`;
  const escenarios = readFileSync(path.join(HERE, "escenarios.sql"), "utf8");
  const marcador = "\\set ON_ERROR_STOP off\n\\pset pager off\n";
  const i = escenarios.indexOf(marcador);
  if (i === -1) throw new Error("escenarios.sql debe contener el marcador \\set ON_ERROR_STOP off / \\pset pager off");
  const cabecera = escenarios.slice(0, i + marcador.length);
  const resto = escenarios
    .slice(i + marcador.length)
    .replace("{{HASH_D16}}", claveIdempotencia("clinica-dental-sonrisa-demo", "d16"))
    .replace("{{PREFLIGHT}}", renderCitasSchemaPreflightSql().replace(/;\s*$/, ""));
  return `${cabecera}
-- GENERADO: funciones con el cuerpo real del seed (packages/domain-citas/src/seed/citas-demo.ts). No editar a mano:
-- node --experimental-strip-types scripts/verify-citas-demo/generar-assertions.ts
${funcion("seed_citas_demo", { ownerEmail: "owner-demo@example.test" })}
${funcion("seed_citas_demo_fecha_base", { ownerEmail: "owner-demo@example.test", fechaBase: "2026-03-04" })}
${funcion("seed_citas_demo_sin_owner", { ownerEmail: "no-existe@example.test" })}
${resto}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, "assertions.sql"), construirAssertions());
  console.log("assertions.sql regenerado");
}
