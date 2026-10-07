// Genera scripts/verify-restaurantes-demo-volumen/assertions.sql: funciones con el cuerpo REAL del seed de la demo
// (`renderPmSeedPlpgsql(..., { demo: true })`) y del seed de volumen (`renderDemoVolumePlpgsql`, con un volumen pequeno producido por
// el generador sobre el motor real) + escenarios. Un test de vitest compara el archivo commiteado contra esta salida: si el seed
// cambia y assertions.sql no se regenera, falla.
//
//   node scripts/seed-pm-demo/ejecutar.mjs verify-demo-volumen
//
// (No corre con `--experimental-strip-types` a secas: el generador depende del repositorio en memoria, que usa parameter
// properties; `ejecutar.mjs` lo empaqueta con esbuild.)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPmSeedPlan, renderPmSeedPlpgsql } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../../packages/domain-restaurantes/src/seed/pm-world.ts";
import { generarVolumenDemo, DEMO_PERFIL_T7, type DemoVolumeBatch } from "../../packages/domain-restaurantes/src/seed/demo-volume.ts";
import { renderDemoVerificationSql } from "../../packages/domain-restaurantes/src/seed/demo-verification.ts";
import { renderDemoVolumePlpgsql } from "../../packages/domain-restaurantes/src/seed/demo-volume-sql.ts";
import { loadSeedInputs } from "../seed-pm-demo/inputs.ts";

// Empaquetado por ejecutar.mjs, `import.meta.url` ya no es la del codigo fuente: ATIENDE_SEED_DIR (scripts/seed-pm-demo) la reemplaza.
const HERE = process.env.ATIENDE_SEED_DIR ? path.join(path.dirname(process.env.ATIENDE_SEED_DIR), "verify-restaurantes-demo-volumen") : path.dirname(fileURLToPath(import.meta.url));
const SLUG_DEMO = "los-taquitos-de-pm-demo";
const ORG_AJENA = "00000000-0000-0000-0000-0000000f0002";
const STAFF_AJENO = "00000000-0000-0000-0000-0000000f0014";

export interface VolumenDePrueba {
  readonly batch: DemoVolumeBatch;
  readonly pedidos: number;
  readonly clientes: number;
  readonly conversaciones: number;
  readonly handoffs: number;
  readonly pendientes: number;
  readonly callbacks: number;
}

/** Volumen pequeno y determinista (10 dias x 12 pedidos, "ahora" fijo) generado con el motor real. */
export async function volumenDePrueba(): Promise<VolumenDePrueba> {
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent, { demo: true });
  const world = await buildInMemoryPmWorld(plan, { deterministic: true });
  const lotes: DemoVolumeBatch[] = [];
  const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, dias: 10, pedidosPorDia: 12, ahora: new Date("2026-09-14T15:00:00Z") });
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    lotes.push(r.value);
  }
  const batch: DemoVolumeBatch = {
    customers: lotes.flatMap((l) => l.customers),
    orders: lotes.flatMap((l) => l.orders),
    conversations: lotes.flatMap((l) => l.conversations),
    handoffs: lotes.flatMap((l) => l.handoffs),
    callbacks: lotes.flatMap((l) => l.callbacks),
  };
  return {
    batch,
    pedidos: batch.orders.length,
    clientes: batch.customers.length,
    conversaciones: batch.conversations.length,
    handoffs: batch.handoffs.length,
    pendientes: batch.handoffs.filter((h) => h.estado === "pendiente").length,
    callbacks: batch.callbacks.length,
  };
}

export interface VolumenT7DePrueba {
  readonly batch: DemoVolumeBatch;
  readonly pedidos: number;
  readonly clientes: number;
  readonly recurrentes: number;
  readonly pedidosDeRecurrentes: number;
}

/** Volumen del perfil t7 completo (139 pedidos en 56 dias) con "ahora" fijo: lo que `npm run demo:pm` carga. */
export async function volumenT7DePrueba(): Promise<VolumenT7DePrueba> {
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent, { demo: true });
  const world = await buildInMemoryPmWorld(plan, { deterministic: true });
  const lotes: DemoVolumeBatch[] = [];
  const gen = generarVolumenDemo(world.repo, { organizationId: world.organizationId, dias: DEMO_PERFIL_T7.dias, perfil: "t7", ahora: new Date("2026-10-03T15:00:00Z") });
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    lotes.push(r.value);
  }
  const batch: DemoVolumeBatch = {
    customers: lotes.flatMap((l) => l.customers),
    orders: lotes.flatMap((l) => l.orders),
    conversations: lotes.flatMap((l) => l.conversations),
    handoffs: lotes.flatMap((l) => l.handoffs),
    callbacks: lotes.flatMap((l) => l.callbacks),
  };
  // Mismo criterio que la consulta de verificacion: pedidos por cliente SIN contar los cancelados.
  const porCliente = new Map<string, number>();
  for (const o of batch.orders) if (o.status !== "cancelado") porCliente.set(o.customerPhone, (porCliente.get(o.customerPhone) ?? 0) + 1);
  const rec = [...porCliente.values()].filter((n) => n >= 2);
  return { batch, pedidos: batch.orders.length, clientes: new Set(batch.orders.filter((o) => o.status !== "cancelado").map((o) => o.customerPhone)).size, recurrentes: rec.length, pedidosDeRecurrentes: rec.reduce((a, b) => a + b, 0) };
}

const SUMA_RENGLONES = `(select coalesce(sum((i->>'price')::numeric * (i->>'quantity')::numeric), 0) from jsonb_array_elements(o.items) i)`;
const DESCUENTO = `coalesce((regexp_match(o.notes, 'Promoción aplicada: [A-Z0-9_-]+ \\(-\\$([0-9.]+)\\)'))[1]::numeric, 0)`;
const DEMO_ORG = `(select id from core.organization where slug = '${SLUG_DEMO}')`;

function escenario(titulo: string, cuerpo: string, opciones: { demo?: boolean } = { demo: true }): string {
  return `\\echo '=== ${titulo} ==='\nbegin;\n${opciones.demo === false ? "" : "select public.seed_pm_demo_marcado();\n"}${cuerpo}\nrollback;\n`;
}

export async function construirAssertions(): Promise<string> {
  const { data, agent } = loadSeedInputs();
  const cuerpoSeedDemo = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent, { demo: true }));
  const v = await volumenDePrueba();
  const t7 = await volumenT7DePrueba();
  const cuerpoVolumenT7 = renderDemoVolumePlpgsql(SLUG_DEMO, t7.batch);
  const cuerpoVolumen = renderDemoVolumePlpgsql(SLUG_DEMO, v.batch);
  // Lotes minimos (un pedido) para los casos de rechazo: no hace falta repetir todo el volumen en el archivo.
  const mini: DemoVolumeBatch = { customers: v.batch.customers.slice(0, 1), orders: v.batch.orders.slice(0, 1), conversations: [], handoffs: [], callbacks: [] };
  const cuerpoNoDemo = renderDemoVolumePlpgsql("otra-taqueria", mini);
  const telefonoReal: DemoVolumeBatch = { ...mini, orders: mini.orders.map((o) => ({ ...o, customerPhone: "9991234567" })) };
  const cuerpoTelefonoReal = renderDemoVolumePlpgsql(SLUG_DEMO, telefonoReal);

  const aplicar = "select public.seed_volumen();\n";
  const aplicarT7 = "select public.seed_volumen_t7();\n";
  // La consulta REAL de verificacion (npm run demo:pm -- --verificar), envuelta para poder compararla: el $1 es el slug demo.
  const hechos = (slug: string) => `(select hechos from (${renderDemoVerificationSql().trim().replace(/;$/, "").replace("$1", `'${slug}'`)}) q)`;
  const escenarios = [
    escenario(`V1. El volumen inserta exactamente ${v.pedidos} pedidos del motor real en la organizacion demo`, `${aplicar}select count(*)::int as pedidos_deberia_ser_${v.pedidos} from restaurantes.orders where organization_id = ${DEMO_ORG};`),
    escenario(
      "V2. IDEMPOTENCIA: aplicar el MISMO volumen dos veces deja los mismos pedidos (sin duplicar)",
      `${aplicar}${aplicar}select count(*)::int as pedidos_tras_dos_corridas_deberia_ser_${v.pedidos} from restaurantes.orders where organization_id = ${DEMO_ORG};`,
    ),
    escenario(
      "V2b. IDEMPOTENCIA: clientes, conversaciones, handoffs y contactos tampoco se duplican",
      `${aplicar}${aplicar}select (
  (select count(*) from restaurantes.customers where organization_id = ${DEMO_ORG}) = ${v.clientes}
  and (select count(*) from restaurantes.whatsapp_conversations where organization_id = ${DEMO_ORG}) = ${v.conversaciones}
  and (select count(*) from restaurantes.conversation_handoff where organization_id = ${DEMO_ORG}) = ${v.handoffs}
  and (select count(*) from restaurantes.callback_requests where organization_id = ${DEMO_ORG}) = ${v.callbacks}
)::int as sin_duplicados_deberia_ser_1;`,
    ),
    escenario(
      "V3. COHERENCIA: el total de cada pedido es la suma de sus renglones menos el descuento del motor (0 pedidos incoherentes)",
      `${aplicar}select count(*)::int as pedidos_con_total_incoherente_deberia_ser_0 from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and abs(o.total - (${SUMA_RENGLONES} - ${DESCUENTO})) > 0.005;`,
    ),
    escenario(
      "V4. Los renglones son del menu sembrado: mismo nombre y mismo precio que el producto EN LA SUCURSAL del pedido (branch_products; 0 discrepancias)",
      `${aplicar}select count(*)::int as renglones_fuera_del_menu_deberia_ser_0
  from restaurantes.orders o cross join lateral jsonb_array_elements(o.items) i
 where o.organization_id = ${DEMO_ORG}
   and not exists (select 1 from restaurantes.products p join restaurantes.branch_products bp on bp.product_id = p.id and bp.property_id = o.property_id where p.organization_id = o.organization_id and p.name = i->>'name' and bp.price = (i->>'price')::numeric);`,
    ),
    escenario(
      "V5. Solo las 5 sucursales de despacho activas en la demo (T1, T2, T3, T7 y T8; T2 y T8 se crean activas con --demo) reciben pedidos; Galerias (T4) y Playa (T5) ninguno",
      `${aplicar}select (
  (select count(distinct bd.slug) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = ${DEMO_ORG}) = 5
  and (select count(*) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = ${DEMO_ORG} and bd.slug not in ('prol-montejo', 'fco-montejo', 'pensiones', 'garcia-lavin', 'altabrisa')) = 0
)::int as cinco_sucursales_con_pedidos_deberia_ser_1;`,
    ),
    escenario(
      "V6. Reglas duras: ningun pedido a domicilio bajo $200 (antes de descuentos) ni con alcohol (no_domicilio)",
      `${aplicar}select (
  (select count(*) from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and o.canal = 'domicilio' and ${SUMA_RENGLONES} < 200)
  + (select count(*) from restaurantes.orders o cross join lateral jsonb_array_elements(o.items) i join restaurantes.products p on p.organization_id = o.organization_id and p.name = i->>'name'
      where o.organization_id = ${DEMO_ORG} and o.canal = 'domicilio' and p.no_domicilio)
)::int as violaciones_de_reglas_duras_deberia_ser_0;`,
    ),
    escenario(
      "V6b. Propina solo con tarjeta; promociones solo al recoger",
      `${aplicar}select (
  (select count(*) from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and o.propina is not null and o.payment_method <> 'tarjeta')
  + (select count(*) from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and o.canal = 'domicilio' and ${DESCUENTO} > 0)
)::int as propina_o_promo_indebida_deberia_ser_0;`,
    ),
    escenario(
      "V7. El contador de pedidos de cada cliente coincide con sus pedidos reales (sin cancelados)",
      `${aplicar}select count(*)::int as clientes_con_contador_incoherente_deberia_ser_0
  from restaurantes.customers cu
 where cu.organization_id = ${DEMO_ORG}
   and cu.order_count <> (select count(*) from restaurantes.orders o where o.customer_id = cu.id and o.status <> 'cancelado');`,
    ),
    escenario(
      "V8. Todo lo escrito esta en el rango ficticio reservado 0001xxxxxx (0 telefonos fuera de rango)",
      `${aplicar}select (
  (select count(*) from restaurantes.orders where organization_id = ${DEMO_ORG} and customer_phone !~ '^0001[0-9]{6}$')
  + (select count(*) from restaurantes.customers where organization_id = ${DEMO_ORG} and phone !~ '^0001[0-9]{6}$')
  + (select count(*) from restaurantes.whatsapp_conversations where organization_id = ${DEMO_ORG} and right(phone, 10) !~ '^0001[0-9]{6}$')
)::int as telefonos_fuera_de_rango_deberia_ser_0;`,
    ),
    escenario(
      `V9. Handoffs: ${v.handoffs} tomas (${v.pendientes} pendientes recientes, el resto cerradas) ligadas a una conversacion; ninguna toma abierta duplicada`,
      `${aplicar}select (
  (select count(*) from restaurantes.conversation_handoff where organization_id = ${DEMO_ORG}) = ${v.handoffs}
  and (select count(*) from restaurantes.conversation_handoff where organization_id = ${DEMO_ORG} and estado = 'pendiente') = ${v.pendientes}
  and not exists (select 1 from restaurantes.conversation_handoff h where h.organization_id = ${DEMO_ORG} and not exists (select 1 from restaurantes.whatsapp_conversations c where c.id = h.conversation_id))
)::int as handoffs_coherentes_deberia_ser_1;`,
    ),
    escenario(
      "V10. Cada conversacion completada esta ligada a un pedido real",
      `${aplicar}select count(*)::int as conversaciones_completadas_sin_pedido_deberia_ser_0 from restaurantes.whatsapp_conversations where organization_id = ${DEMO_ORG} and status = 'completed' and order_id is null;`,
    ),
    escenario(
      `V10b. Contactos: ${v.callbacks} registrados, ${v.pendientes} sin resolver (estado 'nuevo')`,
      `${aplicar}select (
  (select count(*) from restaurantes.callback_requests where organization_id = ${DEMO_ORG}) = ${v.callbacks}
  and (select count(*) from restaurantes.callback_requests where organization_id = ${DEMO_ORG} and not resolved and status = 'nuevo') = ${v.pendientes}
)::int as contactos_coherentes_deberia_ser_1;`,
    ),
    escenario(
      `V18. PERFIL T7 en SQL real: ${t7.pedidos} pedidos (el ritmo medido en T7), SOLO en T7 Garcia Lavin, ${t7.recurrentes} clientes recurrentes con ${t7.pedidosDeRecurrentes} pedidos (sin contar cancelados)`,
      `${aplicarT7}select (
  (select count(*) from restaurantes.orders where organization_id = ${DEMO_ORG}) = ${t7.pedidos}
  and (select count(distinct bd.slug) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = ${DEMO_ORG}) = 1
  and (select count(*) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = ${DEMO_ORG} and bd.slug = '${DEMO_PERFIL_T7.sucursal}') = ${t7.pedidos}
  and (select count(*) from restaurantes.orders where organization_id = ${DEMO_ORG} and source <> 'whatsapp') = 0
)::int as perfil_t7_solo_t7_y_139_pedidos_deberia_ser_1;`,
    ),
    escenario(
      "V18b. PERFIL T7 IDEMPOTENTE: aplicarlo dos veces deja los mismos pedidos y clientes (sin duplicar)",
      `${aplicarT7}${aplicarT7}select (
  (select count(*) from restaurantes.orders where organization_id = ${DEMO_ORG}) = ${t7.pedidos}
  and (select count(*) from restaurantes.customers where organization_id = ${DEMO_ORG}) = ${t7.batch.customers.length}
)::int as t7_sin_duplicados_deberia_ser_1;`,
    ),
    escenario(
      "V18c. PERFIL T7: totales coherentes con el motor (renglones - descuento), minimo $200 a domicilio y renglones del menu de T7",
      `${aplicarT7}select (
  (select count(*) from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and abs(o.total - (${SUMA_RENGLONES} - ${DESCUENTO})) > 0.005)
  + (select count(*) from restaurantes.orders o where o.organization_id = ${DEMO_ORG} and o.canal = 'domicilio' and ${SUMA_RENGLONES} < 200)
  + (select count(*) from restaurantes.orders o cross join lateral jsonb_array_elements(o.items) i
      where o.organization_id = ${DEMO_ORG}
        and not exists (select 1 from restaurantes.products p join restaurantes.branch_products bp on bp.product_id = p.id and bp.property_id = o.property_id where p.organization_id = o.organization_id and p.name = i->>'name' and bp.price = (i->>'price')::numeric))
)::int as incoherencias_del_perfil_t7_deberia_ser_0;`,
    ),
    escenario(
      "V19. VERIFICACION (solo lectura) sobre la demo cargada con el perfil T7: los HECHOS que lee coinciden con lo sembrado y la demo queda LISTA",
      `${aplicarT7}select (
  ${hechos(SLUG_DEMO)}->'org'->>'demo' = 'true'
  and ${hechos(SLUG_DEMO)}->'agente'->>'perfil' = 'taqueria_pm'
  and (${hechos(SLUG_DEMO)}->'volumen'->>'pedidos')::int = ${t7.pedidos}
  and (${hechos(SLUG_DEMO)}->'volumen'->>'clientes')::int = ${t7.clientes}
  and (${hechos(SLUG_DEMO)}->'volumen'->>'sucursales')::int = 1
  and (${hechos(SLUG_DEMO)}->'volumen'->>'whatsapp')::int = ${t7.pedidos}
  and (${hechos(SLUG_DEMO)}->'volumen'->>'clientesRecurrentes')::int = ${t7.recurrentes}
  and (${hechos(SLUG_DEMO)}->'volumen'->>'pedidosDeRecurrentes')::int = ${t7.pedidosDeRecurrentes}
  and (${hechos(SLUG_DEMO)}->'volumen'->'porSlug'->>'${DEMO_PERFIL_T7.sucursal}')::int = ${t7.pedidos}
  and ${hechos(SLUG_DEMO)}->'vozT7Habilitada' = 'false'::jsonb
  and (${hechos(SLUG_DEMO)}->'sucursales') @> '[{"slug": "${DEMO_PERFIL_T7.sucursal}", "status": "active"}]'::jsonb
)::int as hechos_de_verificacion_coinciden_deberia_ser_1;`,
    ),
    escenario(
      "V19b. VERIFICACION sin volumen y sobre un slug inexistente: reporta 0 pedidos / org null (nunca inventa datos)",
      `${aplicar}select restaurantes.demo_limpiar(${DEMO_ORG}, 'volumen');\nselect (
  (${hechos(SLUG_DEMO)}->'volumen'->>'pedidos')::int = 0
  and jsonb_typeof(${hechos("no-existe-esta-org")}->'org') = 'null'
)::int as verificacion_honesta_deberia_ser_1;`,
    ),
    escenario(
      "V19c. VERIFICACION cuenta SOLO el rango ficticio: una sesion del widget (0009) no cuenta como volumen y se reporta aparte",
      `${aplicarT7}insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, source)
  select o.organization_id, o.property_id, 'Sesion widget', '0009123456', 100, '[]'::jsonb, 'whatsapp' from restaurantes.orders o where o.organization_id = ${DEMO_ORG} limit 1;
select (
  (${hechos(SLUG_DEMO)}->'volumen'->>'pedidos')::int = ${t7.pedidos}
  and (${hechos(SLUG_DEMO)}->'sesionesWidget'->>'pedidos')::int = 1
)::int as widget_aparte_del_volumen_deberia_ser_1;`,
    ),
    escenario("V11. RECHAZADO (debe fallar): una organizacion que NO esta marcada como demo no recibe volumen", `select public.seed_volumen_no_demo() as should_fail;`, { demo: false }),
    escenario("V12. RECHAZADO (debe fallar): un telefono fuera del rango ficticio aborta el lote entero", `select public.seed_volumen_telefono_real() as should_fail;`),
    escenario(
      "V13. AISLAMIENTO: el volumen de la demo no toca los pedidos de otra organizacion",
      `${aplicar}select count(*)::int as pedidos_de_la_otra_organizacion_deberia_ser_1 from restaurantes.orders where organization_id = '${ORG_AJENA}';`,
    ),
    escenario(
      "V14. CROSS-TENANT: el staff de otra organizacion no lee ningun pedido de la demo (RLS: 0 filas)",
      `${aplicar}set local role authenticated;\nselect set_config('request.jwt.claim.sub', '${STAFF_AJENO}', true);\nselect count(*)::int as pedidos_de_la_demo_visibles_para_otro_staff_deberia_ser_0 from restaurantes.orders where organization_id <> '${ORG_AJENA}';`,
    ),
    escenario("V15. RECHAZADO (debe fallar): anon no lee los pedidos sembrados", `${aplicar}set local role anon;\nselect count(*)::int as should_fail from restaurantes.orders;`),
    escenario(
      "V16. LIMPIEZA del volumen: borra pedidos, clientes, conversaciones, handoffs y contactos del rango ficticio y deja intacto el menu",
      `${aplicar}select restaurantes.demo_limpiar(${DEMO_ORG}, 'volumen');\nselect (
  (select count(*) from restaurantes.orders where organization_id = ${DEMO_ORG})
  + (select count(*) from restaurantes.customers where organization_id = ${DEMO_ORG})
  + (select count(*) from restaurantes.whatsapp_conversations where organization_id = ${DEMO_ORG})
  + (select count(*) from restaurantes.conversation_handoff where organization_id = ${DEMO_ORG})
  + (select count(*) from restaurantes.callback_requests where organization_id = ${DEMO_ORG})
)::int as restos_del_volumen_deberia_ser_0;`,
    ),
    escenario(
      "V16b. LIMPIEZA del volumen: el menu, la politica y la configuracion del agente de la demo (fila de la organizacion + fila propia de T7) siguen ahi",
      `${aplicar}select restaurantes.demo_limpiar(${DEMO_ORG}, 'volumen');\nselect (
  (select count(*) from restaurantes.products where organization_id = ${DEMO_ORG}) = 279
  and (select count(*) from restaurantes.whatsapp_agent_config where organization_id = ${DEMO_ORG}) = 2
)::int as configuracion_intacta_deberia_ser_1;`,
    ),
    escenario(
      "V17. LIMPIEZA total: borra la organizacion demo y deja intacta la otra",
      `${aplicar}select restaurantes.demo_limpiar(${DEMO_ORG}, 'todo');\nselect (
  (select count(*) from core.organization where slug = '${SLUG_DEMO}') = 0
  and (select count(*) from restaurantes.orders where organization_id = '${ORG_AJENA}') = 1
)::int as demo_borrada_y_otra_intacta_deberia_ser_1;`,
    ),
  ];
  // Los escenarios "RECHAZADO" (as should_fail) terminan en ERROR real: se listan por numero para el gate.
  const errores = escenarios.map((e, i) => (/as should_fail/.test(e) ? i + 1 : 0)).filter(Boolean);

  return `-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales) del seed de VOLUMEN de la demo (R-20). GENERADO por
-- scripts/verify-restaurantes-demo-volumen/generar-assertions.ts: contiene el cuerpo REAL del seed de la cuenta demo y del seed de
-- volumen (el mismo SQL que ejecuta scripts/seed-pm-demo/seed-volumen.ts) con un volumen pequeno producido por el motor real de
-- pedidos. No editar a mano. Cada escenario corre en su propio begin/rollback; "RECHAZADO" termina en ERROR real (as should_fail).
\\set ON_ERROR_STOP off
\\pset pager off

create or replace function public.seed_pm_demo_marcado() returns void language plpgsql as $seed_fn$
${cuerpoSeedDemo}
$seed_fn$;
create or replace function public.seed_volumen() returns void language plpgsql as $seed_fn$
${cuerpoVolumen}
$seed_fn$;
create or replace function public.seed_volumen_t7() returns void language plpgsql as $seed_fn$
${cuerpoVolumenT7}
$seed_fn$;
create or replace function public.seed_volumen_no_demo() returns void language plpgsql as $seed_fn$
${cuerpoNoDemo}
$seed_fn$;
create or replace function public.seed_volumen_telefono_real() returns void language plpgsql as $seed_fn$
${cuerpoTelefonoReal}
$seed_fn$;

-- Otra organizacion REAL (no demo) con un pedido en el MISMO rango de telefono ficticio, su sucursal y su staff.
insert into core.organization (id, vertical, name, slug) values ('${ORG_AJENA}', 'restaurantes', 'Otra Taqueria', 'otra-taqueria') on conflict do nothing;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000f00b1', '${ORG_AJENA}', 'Sucursal Ajena') on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values ('00000000-0000-0000-0000-0000000f00b1', '${ORG_AJENA}', 'ajena') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values ('00000000-0000-0000-0000-0000000f00c1', '${ORG_AJENA}', '0001000001', 'Cliente ajeno', 1) on conflict do nothing;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, items, source)
  values ('${ORG_AJENA}', '00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f00c1', 'Cliente ajeno', '0001000001', 99, '[]'::jsonb, 'whatsapp');
insert into core.staff_user (id, email, full_name, created_via) values ('${STAFF_AJENO}', 'owner-otra@volumen.example.com', 'Owner de la otra organizacion', 'seed') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('${STAFF_AJENO}', '${ORG_AJENA}', null, 'owner', 'owner') on conflict do nothing;

${escenarios.join("\n")}
\\echo 'los escenarios ${errores.join("/")} deben terminar en ERROR; el resto en el valor indicado por el alias.'
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  construirAssertions().then((sql) => {
    writeFileSync(path.join(HERE, "assertions.sql"), sql);
    console.log("assertions.sql regenerado");
  });
}
