// Genera scripts/verify-rentas-seed/assertions.sql = cabecera + funciones public.seed_rentas_demo() y public.seed_rentas_demo_sin_duena()
// (cuerpo REAL del seed, `renderRentasSeedPlpgsql`, con los .ics de fixtures parseados) + escenarios.sql. Un test de vitest compara el
// archivo commiteado contra esta salida: si el seed o los fixtures cambian y assertions.sql no se regenera, falla.
//
//   node --experimental-strip-types scripts/verify-rentas-seed/generar-assertions.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRentasSeedPlan, renderRentasLimpiarPlpgsql, renderRentasSeedPlpgsql } from "../../packages/domain-rentas/src/seed/rentas-demo.ts";
import { cargarFixturesIcs } from "../seed-rentas-demo/seed-rentas-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function construirAssertions(): string {
  const plan = buildRentasSeedPlan(cargarFixturesIcs());
  const cuerpo = renderRentasSeedPlpgsql(plan, { ownerEmail: "duena@example.test" });
  const cuerpoSinDuena = renderRentasSeedPlpgsql(plan, { ownerEmail: "no-existe@example.test" });
  const escenarios = readFileSync(path.join(HERE, "escenarios.sql"), "utf8");
  const marcador = "\\set ON_ERROR_STOP off\n\\pset pager off\n";
  const i = escenarios.indexOf(marcador);
  if (i === -1) throw new Error("escenarios.sql debe contener el marcador \\set ON_ERROR_STOP off / \\pset pager off");
  const cabecera = escenarios.slice(0, i + marcador.length);
  const resto = escenarios.slice(i + marcador.length);
  return `${cabecera}
-- GENERADO: funciones con el cuerpo real del seed (packages/domain-rentas/src/seed/rentas-demo.ts). No editar a mano:
-- node --experimental-strip-types scripts/verify-rentas-seed/generar-assertions.ts
create or replace function public.seed_rentas_demo() returns void language plpgsql as $seed_fn$
${cuerpo}
$seed_fn$;
create or replace function public.seed_rentas_demo_sin_duena() returns void language plpgsql as $seed_fn$
${cuerpoSinDuena}
$seed_fn$;
create or replace function public.limpiar_rentas_demo() returns void language plpgsql as $seed_fn$
${renderRentasLimpiarPlpgsql()}
$seed_fn$;
${resto}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, "assertions.sql"), construirAssertions());
  console.log("assertions.sql regenerado");
}
