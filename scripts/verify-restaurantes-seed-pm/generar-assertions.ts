// Genera scripts/verify-restaurantes-seed-pm/assertions.sql = cabecera + funcion public.seed_pm_demo()
// (cuerpo REAL del seed, `renderPmSeedPlpgsql`) + escenarios.sql. Un test de vitest compara el archivo
// commiteado contra esta salida: si el seed cambia y assertions.sql no se regenera, falla.
//
//   node --experimental-strip-types scripts/verify-restaurantes-seed-pm/generar-assertions.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPmSeedPlan, renderPmSeedPlpgsql } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";
import { loadSeedInputs } from "../seed-pm-demo/seed-pm-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function construirAssertions(): string {
  const { data, agent } = loadSeedInputs();
  const body = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent));
  // Carga como DEMO (`--demo`): slug `<slug>-demo` + marca en restaurantes.demo_organization (migracion 036).
  const bodyDemo = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent, { demo: true }));
  const escenarios = readFileSync(path.join(HERE, "escenarios.sql"), "utf8");
  const marcador = "\\set ON_ERROR_STOP off\n\\pset pager off\n";
  const i = escenarios.indexOf(marcador);
  if (i === -1) throw new Error("escenarios.sql debe contener el marcador \\set ON_ERROR_STOP off / \\pset pager off");
  const cabecera = escenarios.slice(0, i + marcador.length);
  const resto = escenarios.slice(i + marcador.length);
  return `${cabecera}
-- GENERADO: funcion con el cuerpo real del seed (packages/domain-restaurantes/src/seed/pm-demo.ts). No editar a mano:
-- node --experimental-strip-types scripts/verify-restaurantes-seed-pm/generar-assertions.ts
create or replace function public.seed_pm_demo() returns void language plpgsql as $seed_fn$
${body}
$seed_fn$;
create or replace function public.seed_pm_demo_marcado() returns void language plpgsql as $seed_fn$
${bodyDemo}
$seed_fn$;
${resto}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, "assertions.sql"), construirAssertions());
  console.log("assertions.sql regenerado");
}
