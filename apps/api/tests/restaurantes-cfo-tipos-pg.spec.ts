// CFO-05 · de punta a punta con el adaptador POSTGRES sobre una sesión que entrega las filas como las entrega node-postgres: bigint y numeric como
// STRING, columnas NULL. La API debe responder números (nunca strings numéricos) y conservar NULL ≠ 0.
import { describe, expect, it } from "vitest";
import { PostgresCfoRepository } from "@atiende/domain-restaurantes/cfo/postgres";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const Q = "desde=2026-09-01&hasta=2026-09-07";

function cadenasNumericas(valor: unknown, ruta = "$", out: string[] = []): string[] {
  if (typeof valor === "string" && /^-?\d+(\.\d+)?$/.test(valor)) out.push(`${ruta}=${valor}`);
  else if (Array.isArray(valor)) valor.forEach((v, i) => cadenasNumericas(v, `${ruta}[${i}]`, out));
  else if (valor && typeof valor === "object") for (const [k, v] of Object.entries(valor)) cadenasNumericas(v, `${ruta}.${k}`, out);
  return out;
}

async function montar() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const A = ctx.propertyIdA;
  const ventas = (dia: string, canal: string, source: string, pago: string | null, pedidos: string, neta: string) => ({
    property_id: A, dia_negocio: dia, canal, source, payment_method: pago, pedidos, bruta_centavos: String(Number(neta) + 10000), desc_promo_centavos: "10000", desc_comp_centavos: "0", neta_centavos: neta,
    propina_centavos: "1500", cancelados: "1", cancelados_centavos: "25000", no_recogidos: "0", no_recogidos_centavos: "0", reposiciones: "0", reposicion_unidades: "0", entregados: pedidos,
    entrega_min_suma: "812.45", entrega_tarde: "2",
  });
  const handlers: FakeSessionHandler[] = [
    { match: /cfo_config_leer/, respond: () => [{ frecuente_n: 3, frecuente_dias: 90, activo_dias: 60, perdido_dias: 120, promesa_min: 50, iva_pct: "16.00", caida_pct: "15.00", ticket_baja_pct: "10.00", cancelacion_x_mediana: "2.00", descuento_max_pct: "8.00", costo_agente_alza_pct: "30.00", cierre_baja_pp: "10.00", entrega_p90_max_min: 60, sr_cuadre_verde_pct: "1.00", sr_cuadre_ambar_pct: "3.00", sr_cuadre_verde_centavos: "5000", comision_terminal_pct: null, updated_at: null }] },
    { match: /cfo_ventas_diarias/, respond: () => [ventas("2026-09-03", "domicilio", "whatsapp", "tarjeta", "12", "250000"), ventas("2026-09-04", "recoger", "voice", "efectivo", "8", "130050")] },
    { match: /cfo_cobertura/, respond: () => [{ property_id: A, primer_dia: "2026-05-01", ultimo_dia: "2026-09-07", zona: "America/Merida", corte: "01:00:00" }] },
    {
      match: /cfo_agente_diario/,
      respond: () => [
        { property_id: A, dia_negocio: "2026-09-03", wa_conversaciones_nuevas: "30", wa_con_pedido: "12", wa_con_handoff: "2", wa_handoffs: "2", voz_llamadas: "6", voz_pedido_creado: "3", voz_escalado: "1", voz_abandonado: "2",
          costo_voz_micro_usd: "900000", costo_telefonia_micro_usd: "120000", costo_meta_micro_usd: null, costo_llm_micro_usd: null, costo_voz_centavos: "162", costo_telefonia_centavos: "22", costo_meta_centavos: null, costo_llm_centavos: null, meta_eventos: "0", mxn_por_usd: "18.0000" },
        { property_id: null, dia_negocio: "2026-09-03", wa_conversaciones_nuevas: "0", wa_con_pedido: "0", wa_con_handoff: "0", wa_handoffs: "0", voz_llamadas: "0", voz_pedido_creado: "0", voz_escalado: "0", voz_abandonado: "0",
          costo_voz_micro_usd: "0", costo_telefonia_micro_usd: "0", costo_meta_micro_usd: null, costo_llm_micro_usd: "300000", costo_voz_centavos: null, costo_telefonia_centavos: null, costo_meta_centavos: null, costo_llm_centavos: "54", meta_eventos: "0", mxn_por_usd: "18.0000" },
      ],
    },
    { match: /cfo_entregas_percentiles/, respond: () => [{ property_id: A, alcance: "sucursal", entregados: "20", p50_min: "36.50", p90_min: "58.00" }, { property_id: null, alcance: "conjunto", entregados: "20", p50_min: "36.50", p90_min: "58.00" }] },
    { match: /cfo_clientes_resumen/, respond: () => [{ property_id: A, alcance: "sucursal", clientes_con_pedido: "15", nuevos: "4", recurrentes: "11", activos: "14", dormidos: "1", perdidos: "0", frecuentes: "6", multi_sucursal: null, clientes_varias_sucursales: null, recuperados: "0", recuperados_por_campana: "0", activos_al_inicio: "10", pasan_a_perdidos: "0", dias_entre_pedidos_mediana: "9.5", neta_top10pct_centavos: "90000", neta_total_centavos: "380050", pedidos_por_cliente_12m_promedio: "2.40", pedidos_con_cliente: "20", pedidos_sin_cliente: "0" }, { property_id: null, alcance: "conjunto", clientes_con_pedido: "15", nuevos: "4", recurrentes: "11", activos: "14", dormidos: "1", perdidos: "0", frecuentes: "6", multi_sucursal: "0", clientes_varias_sucursales: "0", recuperados: "0", recuperados_por_campana: "0", activos_al_inicio: "10", pasan_a_perdidos: "0", dias_entre_pedidos_mediana: "9.5", neta_top10pct_centavos: "90000", neta_total_centavos: "380050", pedidos_por_cliente_12m_promedio: "2.40", pedidos_con_cliente: "20", pedidos_sin_cliente: "0" }] },
    { match: /cfo_entregas\(/, respond: () => [{ property_id: A, hora_local: 13, dow_negocio: 4, entregados: "20", min_suma: "812.45", tarde: "2" }] },
    { match: /restaurantes\./, respond: () => [] },
  ];
  const sesion = new AbortAwareFakeSession(handlers);
  const deps: AppDeps = { ...ctx.deps, cfoRestaurantesRepo: () => new PostgresCfoRepository(sesion) };
  const app = buildApp(deps);
  return { ctx, app, A, sesion };
}

describe("API sobre el adaptador Postgres: tipos numéricos como string y NULL ≠ 0", () => {
  it("/ventas: bigint y numeric (strings) salen como números JSON; los minutos conservan 2 decimales", async () => {
    const { ctx, app, A } = await montar();
    const res = await app.request(`/v1/restaurantes/${A}/admin/cfo/ventas?${Q}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ventas: { total: { sumas: Record<string, number> } } };
    const s = j.ventas.total.sumas;
    expect(s.pedidos).toBe(20);
    expect(s.netaCentavos).toBe(380050);
    expect(s.entregaMinSuma).toBe(1624.9);
    expect(typeof s.netaCentavos).toBe("number");
    expect(cadenasNumericas(j)).toEqual([]);
  });

  it("/operacion: el costo de Meta sin eventos llega NULL (no 0) y el LLM de la organización solo con alcance completo", async () => {
    const { ctx, app, A } = await montar();
    const j = (await (await app.request(`/v1/restaurantes/${A}/admin/cfo/operacion?${Q}`, authedGet(ctx.staff.owner.token))).json()) as {
      costoAgente: { total: { meta: { valor: number | null; fuente: string }; total: { valor: number | null }; porPedido: { valor: number | null } }; noAsignado: { llmTexto: { valor: number | null } } | null };
      entregas: Array<{ p90Min: { valor: number | null }; conjunto: boolean }>;
    };
    expect(j.costoAgente.total.meta).toMatchObject({ valor: null, fuente: "Meta: no medido" });
    // 162 + 22 (voz y telefonía por sucursal) + 54 (LLM no asignado) = 238 centavos; sin sumar Meta como 0.
    expect(j.costoAgente.total.total.valor).toBe(238);
    expect(j.costoAgente.noAsignado!.llmTexto.valor).toBe(54);
    expect(j.entregas.find((e) => e.conjunto)!.p90Min.valor).toBe(58);
    expect(cadenasNumericas(j)).toEqual([]);
    const acotado = (await (await app.request(`/v1/restaurantes/${A}/admin/cfo/operacion?${Q}`, authedGet(ctx.staff.adminSucursalA.token))).json()) as typeof j;
    expect(acotado.costoAgente.noAsignado).toBeNull();
  });

  it("/resumen: sumas, KPIs y narrativa salen numéricos; el consolidado coincide con las filas de la base", async () => {
    const { ctx, app, A } = await montar();
    const res = await app.request(`/v1/restaurantes/${A}/admin/cfo/resumen?${Q}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { kpis: { total: { sumas: { netaCentavos: number }; kpis: Array<{ id: string; valor: { valor: number | null } }> }; porSucursal: Array<{ sumas: { netaCentavos: number } }> } };
    expect(j.kpis.total.sumas.netaCentavos).toBe(380050);
    expect(j.kpis.porSucursal.reduce((s, c) => s + c.sumas.netaCentavos, 0)).toBe(380050);
    expect(j.kpis.total.kpis.find((k) => k.id === "ticket")!.valor.valor).toBe(19003); // 380050 / 20 redondeado
    expect(j.kpis.total.kpis.find((k) => k.id === "entrega_p90")!.valor.valor).toBe(58);
    // `narrativa.referencias` son textos ya formateados para tooltips («20», «$1,234.50»): no son cifras crudas.
    expect(cadenasNumericas(j).filter((x) => !x.startsWith("$.narrativa.referencias"))).toEqual([]);
  });

  it("una sesión que revienta con «función no existe» (base vieja) responde 200 con disponible=false y la sesión sigue viva", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const sesion = new AbortAwareFakeSession([{ match: /restaurantes\./, respond: () => Object.assign(new Error("function restaurantes.cfo_ventas_diarias does not exist"), { code: "42883" }) }]);
    const app = buildApp({ ...ctx.deps, cfoRestaurantesRepo: () => new PostgresCfoRepository(sesion) });
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/cfo/resumen?${Q}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { disponible: boolean; bloques: { ventas: boolean } };
    expect(j.disponible).toBe(false);
    expect(j.bloques.ventas).toBe(false);
    const put = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/cfo/config`, { method: "PUT", headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" }, body: JSON.stringify({ ivaPct: 8 }) });
    expect(put.status).toBe(503);
  });
});
