// Genera scripts/verify-restaurantes-seed-demo-cuenta/assertions.sql = cabecera + funcion public.seed_demo_cuenta()
// (cuerpo REAL del seed de «El Tizon Norteño», `renderDemoCuentaPlpgsql`) + escenarios.sql. Un test de vitest compara el
// archivo commiteado contra esta salida: si el seed cambia y assertions.sql no se regenera, falla.
//
//   npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts   (escribe el archivo)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CUENTA } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/definicion.ts";
import { construirPlanDemoCuenta } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaPlpgsql } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/sql.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function construirAssertions(): string {
  const body = renderDemoCuentaPlpgsql(construirPlanDemoCuenta(DEMO_CUENTA));
  const escenarios = readFileSync(path.join(HERE, "escenarios.sql"), "utf8");
  const marcador = "\\set ON_ERROR_STOP off\n\\pset pager off\n";
  const i = escenarios.indexOf(marcador);
  if (i === -1) throw new Error("escenarios.sql debe contener el marcador \\set ON_ERROR_STOP off / \\pset pager off");
  const cabecera = escenarios.slice(0, i + marcador.length);
  const resto = escenarios.slice(i + marcador.length);
  return `${cabecera}
-- GENERADO: funcion con el cuerpo real del seed (packages/domain-restaurantes/src/seed/demo-cuenta/sql.ts). No editar a mano:
-- npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts
create or replace function public.seed_demo_cuenta() returns void language plpgsql as $seed_fn$
${body}
$seed_fn$;
${resto}`;
}
