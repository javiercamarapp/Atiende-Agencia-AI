// Genera scripts/verify-restaurantes-seed-demo-cuenta/assertions.sql = cabecera + funcion public.seed_demo_cuenta()
// (cuerpo REAL del seed de «El Tizon Norteño», `renderDemoCuentaPlpgsql`) + escenarios.sql + escenarios E (el archivo `--emit-sql` ejecutado tal cual).
// Un test de vitest compara el archivo commiteado contra esta salida: si el seed cambia y assertions.sql no se regenera, falla.
//
//   npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts   (escribe el archivo)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CUENTA } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/definicion.ts";
import { renderDemoCuentaArchivoSql } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/emit-sql.ts";
import { construirPlanDemoCuenta } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaPlpgsql } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/sql.ts";
import type { DemoCuentaDef } from "../../packages/domain-restaurantes/src/seed/demo-cuenta/tipos.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Texto hostil para el SQL emitido: comillas simples y dobles, `$$`, `$1`, otra etiqueta dollar-quote, `;`, `--` y barras invertidas. */
export const TEXTO_HOSTIL = "Tizón O'Neil \"x\" $$ ; drop schema core cascade; -- \\ \\n $1 $a$ $$";
export const EMAIL_DUENO_PRUEBA = "dueno.prueba@demo-cadena.example";

/** La definicion real, pero con nombre de organizacion, una descripcion de producto y el saludo del agente hostiles. */
export function definicionConDatosHostiles(): DemoCuentaDef {
  const [primero, ...resto] = DEMO_CUENTA.productos;
  return {
    ...DEMO_CUENTA,
    organizacion: { ...DEMO_CUENTA.organizacion, nombre: TEXTO_HOSTIL },
    productos: [{ ...primero!, descripcion: TEXTO_HOSTIL }, ...resto],
    agente: { ...DEMO_CUENTA.agente, saludo: TEXTO_HOSTIL },
  };
}

/** El archivo emitido sin su envoltura begin/commit, para correrlo DENTRO de un escenario begin;...rollback; del gate (el resto, byte a byte). */
export function emitidoSinTransaccion(sql: string): string {
  const sinBegin = sql.replace(/^begin;\n/m, "");
  if (sinBegin === sql || !/^commit;\n/m.test(sinBegin)) throw new Error("el SQL emitido debe traer begin; y commit; en lineas propias");
  return sinBegin.replace(/^commit;\n/m, "");
}

/** Escenarios E: el archivo `--emit-sql` ejecutado dos veces seguidas, y con datos hostiles + dueno existente. */
function escenariosEmitidos(): string {
  const plan = construirPlanDemoCuenta(DEMO_CUENTA);
  const normal = emitidoSinTransaccion(renderDemoCuentaArchivoSql(plan));
  const planHostil = construirPlanDemoCuenta(definicionConDatosHostiles());
  const hostil = emitidoSinTransaccion(renderDemoCuentaArchivoSql(planHostil, { ownerEmail: EMAIL_DUENO_PRUEBA }));
  const nombreHostil = planHostil.organization.name; // el plan agrega " (demo)" al nombre
  const s = plan.summary;
  const org = "o.slug = 'demo-cadena'";
  return `
\\echo '=== E1. El .sql emitido (--emit-sql) se ejecuta DOS veces seguidas y deja exactamente los conteos esperados, sin duplicar y sin dueno ==='
begin;
${normal}${normal}select (
  (select count(*) from core.organization o where ${org}) = 1
  and (select count(*) from core.property p join core.organization o on o.id = p.organization_id where ${org}) = ${s.branches}
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where ${org}) = ${s.products}
  and (select count(*) from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where ${org}) = ${s.branchProducts}
  and (select count(*) from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id where ${org}) = ${s.promotions}
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where ${org}) = ${plan.zones.length + s.colonias}
  and (select count(*) from core.membership m join core.organization o on o.id = m.organization_id where ${org}) = 0
  and (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000d0001') = 1
)::int as emitido_dos_corridas_conteos_exactos_deberia_ser_1;
rollback;

\\echo '=== E2. El .sql emitido con texto hostil (comillas, $$, $1, punto y coma, --, barras) y dueno existente: los datos quedan literales, hay membresia owner y no se ejecuta nada ajeno ==='
begin;
insert into core.staff_user (email, full_name) values ('${EMAIL_DUENO_PRUEBA}', 'Dueno de prueba');
${hostil}select (
  (select o.name from core.organization o where ${org}) = $ev$${nombreHostil}$ev$
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where ${org} and position($ev$${TEXTO_HOSTIL}$ev$ in pr.description) > 0) = 1
  and (select count(*) from restaurantes.whatsapp_agent_config w join core.organization o on o.id = w.organization_id where ${org} and w.greeting_text = $ev$${TEXTO_HOSTIL}$ev$) >= 1
  and (select count(*) from core.membership m join core.staff_user u on u.id = m.user_id join core.organization o on o.id = m.organization_id
         where ${org} and u.email = '${EMAIL_DUENO_PRUEBA}' and m.platform_role = 'owner' and m.vertical_role = 'owner') = 1
  and (select count(*) from information_schema.schemata where schema_name = 'core') = 1
)::int as emitido_hostil_literal_y_dueno_deberia_ser_1;
rollback;
`;
}

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
${resto}${escenariosEmitidos()}`;
}
