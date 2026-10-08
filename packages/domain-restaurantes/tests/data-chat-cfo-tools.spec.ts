// CFO-09 · herramientas CFO del copiloto («Pregunta a tu CFO»): cada una contra el servicio REAL del CFO (repositorio en memoria, dataset SINTETICO).
// Reloj fijo: miercoles 12:00 de Merida (el periodo `semana_pasada` = 21-27 sep cae dentro del dataset).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDataChatTurn, scriptedCompletion, toJsonSchema, type DataChatTool, type DataChatToolContext, type DataChatScope, type ScriptStep } from "@atiende/agent-core/data-chat";
import { buildRestaurantesDataChatCatalog, buildRestaurantesDataChatTools } from "../src/data-chat/index.ts";
import { DataChatUnavailableError } from "../src/data-chat/reader.ts";
import { CFO_BRANCHES, CfoFakeReader, DATASET_SINTETICO as D, GERENTE_T1_SCOPE, IDS, MIERCOLES_MERIDA, OWNER_CFO_SCOPE, SUC, T1, T8 } from "./data-chat/support-cfo.ts";
import { PostgresRestaurantesDataChatReader } from "../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { FakeReader } from "./data-chat/support.ts";

const CFO_TOOLS = ["cfo_resumen", "cfo_lo_mas_importante", "cfo_estado_resultados", "cfo_comparar_sucursales", "cfo_clientes", "cfo_platillos", "cfo_patrones", "cfo_agente", "cfo_softrestaurant"];
const SEMANA = { periodo: "semana_pasada" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MIERCOLES_MERIDA);
});
afterEach(() => vi.useRealTimers());

function ctx(scope: DataChatScope = OWNER_CFO_SCOPE): DataChatToolContext {
  return { scope, now: new Date(), signal: new AbortController().signal, maxRows: 50 };
}
const tool = (reader: FakeReader, name: string): DataChatTool => buildRestaurantesDataChatTools(reader).find((t) => t.name === name)!;
const CALL = (name: string, args: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name, argumentsJson: JSON.stringify(args) }] });

describe("catálogo: las nueve herramientas CFO", () => {
  const tools = buildRestaurantesDataChatTools(new CfoFakeReader());

  it("se registran al final del catálogo, sin tocar las ocho existentes", () => {
    expect(tools).toHaveLength(17);
    expect(tools.slice(0, 8).map((t) => t.name)).toEqual(["ventas_por_dia", "ventas_por_sucursal", "productos_mas_vendidos", "ticket_medio", "pedidos_por_canal", "horas_pico", "clientes_recurrentes", "promociones"]);
    expect(tools.slice(8).map((t) => t.name)).toEqual(CFO_TOOLS);
  });

  it("ninguna acepta organización, sucursal por id, rol ni SQL; la sucursal es opcional y por nombre", () => {
    const forbidden = /^(?:.*(?:org|tenant|property|propiedad|role|rol|sql|query|user|usuario)|.*id)$/i;
    for (const t of tools.filter((x) => x.name.startsWith("cfo_"))) {
      for (const key of Object.keys(t.params)) expect(key, `${t.name}.${key}`).not.toMatch(forbidden);
      expect(t.params["sucursal"]).toMatchObject({ type: "string", optional: true });
      expect(toJsonSchema(t.params)).toMatchObject({ additionalProperties: false });
    }
  });
});

describe("cada herramienta contra el servicio del CFO", () => {
  it("las nueve responden con tabla, fuente con confianza y el aviso de que no sustituyen al contador; ninguna columna lleva PII", async () => {
    const reader = new CfoFakeReader({ dataset: { srResumen: D.srResumen } });
    for (const name of CFO_TOOLS) {
      const r = await tool(reader, name).run(ctx(), SEMANA);
      expect(["ok", "empty"], `${name}: ${r.message ?? ""}`).toContain(r.status);
      expect(r.source, name).toMatch(/CFO/);
      expect(r.source, name).toMatch(/no sustituye a tu contador/);
      expect(r.scopeLabel, name).toBe("todas tus sucursales");
      expect(r.periodLabel, name).toContain("semana pasada");
      for (const c of r.columns) expect(c.key, `${name}.${c.key}`).not.toMatch(/^(?:.*(?:nombre_cliente|telefono|direccion|email|correo|phone)|tel)$/i);
    }
  });

  it("cfo_resumen: la venta de la tabla es la del servicio (no se recalcula) y el resumen sale de la narrativa sin marcas de referencia", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_resumen").run(ctx(), SEMANA);
    const directo = await reader.servicios[0]!.resumen({ desde: "2026-09-21", hasta: "2026-09-27", comparar: "periodo_anterior", granularidad: "dia" });
    expect(r.status).toBe("ok");
    expect(r.rows[0]!["ventas"]).toBe(directo.kpis.total.sumas.netaCentavos / 100);
    expect(r.rows[0]!["pedidos"]).toBe(directo.kpis.total.sumas.pedidos);
    expect(r.summary).toContain("$");
    expect(r.summary).not.toMatch(/\[[a-z_]+\]/);
    expect(r.chart).toEqual({ kind: "kpi", x: "ventas", y: "ventas" });
    expect(r.columns.find((c) => c.key === "ventas")!.kind).toBe("mxn");
  });

  it("cfo_lo_mas_importante: hallazgos con cifra, acción e impacto en pesos; el orden 'urgencia' se pasa al servicio", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_lo_mas_importante").run(ctx(), { ...SEMANA, orden: "impacto" });
    expect(r.status).toBe("ok");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(10);
    const impactos = r.rows.map((x) => x["impacto"] as number | null).filter((x): x is number => x != null);
    expect([...impactos].sort((a, b) => b - a)).toEqual(impactos); // por impacto desc
    for (const f of r.rows) expect(String(f["accion"]).length).toBeGreaterThan(5);
    expect(r.chart).toEqual({ kind: "bar", x: "hallazgo", y: "impacto" });
    const porUrgencia = await tool(reader, "cfo_lo_mas_importante").run(ctx(), { ...SEMANA, orden: "urgencia" });
    expect(porUrgencia.rows[0]!["urgencia"]).toBe("Alta");
  });

  it("cfo_estado_resultados: sin captura, food cost y nómina salen 'captura pendiente' con valor null (jamás 0) y el EBITDA no se inventa", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_estado_resultados").run(ctx(), { periodo: "semana_pasada" });
    expect(r.status).toBe("ok");
    const costo = r.rows.find((x) => String(x["linea"]).startsWith("Costo de ventas"))!;
    expect(String(costo["linea"])).toContain("captura pendiente");
    expect(costo["c0"]).toBeNull();
    const nomina = r.rows.find((x) => String(x["linea"]).startsWith("Nómina"))!;
    expect(String(nomina["linea"])).toContain("captura pendiente");
    expect(r.rows.find((x) => String(x["linea"]).startsWith("EBITDA"))!["c0"]).toBeNull();
    expect(r.summary).toMatch(/EBITDA operativo incompleto/);
    expect(r.summary).toMatch(/Captura pendiente/);
    expect(r.summary).toContain("CFO > Estado de resultados > Capturar costos");
    expect(r.source).toMatch(/No sustituye a tu contabilidad/);
    // 7 sucursales + total: las columnas tienen el nombre de la sucursal.
    expect(r.columns.map((c) => c.label)).toContain("Altabrisa");
  });

  it("cfo_comparar_sucursales: ranking lado a lado; el ranking cuadra con la tabla del servicio y la suma por sucursal = total", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_comparar_sucursales").run(ctx(), SEMANA);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(SUC.length);
    const directo = await reader.servicios[0]!.sucursalesVista({ desde: "2026-09-21", hasta: "2026-09-27", comparar: "periodo_anterior", granularidad: "dia" });
    expect(r.rows.map((x) => x["sucursal"])).toEqual(directo.tabla.map((f) => f.nombre));
    expect(r.rows.reduce((s, x) => s + (x["ventas"] as number), 0)).toBeCloseTo(directo.total.netaCentavos / 100, 2);
    expect(r.summary).toMatch(/Mayor venta/);
    expect(r.summary).toMatch(/Menor venta/);
    expect(r.rows.every((x) => typeof x["vs_promedio_pct"] === "number")).toBe(true);
  });

  it("cfo_clientes: conteos y % de frecuentes, solo agregados; el conjunto no es la suma de las sucursales", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_clientes").run(ctx(), { periodo: "ultimos_30_dias" });
    expect(r.status).toBe("ok");
    const ultimo = r.rows[r.rows.length - 1]!;
    expect(String(ultimo["sucursal"])).toContain("Todas");
    expect(typeof ultimo["frecuentes_pct"]).toBe("number");
    expect(r.chart!.kind).toBe("kpi");
    expect(r.summary).toMatch(/frecuentes/);
    expect(Object.keys(r.rows[0]!).join(",")).not.toMatch(/telefono|nombre_cliente|alias/);
  });

  it("cfo_platillos: ranking por unidades o por ingreso, categorías y canasta", async () => {
    const reader = new CfoFakeReader();
    const unidades = await tool(reader, "cfo_platillos").run(ctx(), { ...SEMANA, vista: "mas_vendidos", ordenar_por: "unidades", limite: 5 });
    expect(unidades.rows).toHaveLength(5);
    const u = unidades.rows.map((x) => x["unidades"] as number);
    expect([...u].sort((a, b) => b - a)).toEqual(u);
    const ingreso = await tool(reader, "cfo_platillos").run(ctx(), { ...SEMANA, vista: "mas_vendidos", ordenar_por: "ingreso", limite: 5 });
    const i = ingreso.rows.map((x) => x["ingreso"] as number);
    expect([...i].sort((a, b) => b - a)).toEqual(i);
    const menos = await tool(reader, "cfo_platillos").run(ctx(), { ...SEMANA, vista: "menos_vendidos", limite: 3 });
    expect(menos.rows).toHaveLength(3);
    expect((menos.rows[0]!["unidades"] as number)).toBeLessThanOrEqual(unidades.rows[0]!["unidades"] as number);
    const cats = await tool(reader, "cfo_platillos").run(ctx(), { ...SEMANA, vista: "categorias" });
    expect(cats.rows.map((x) => x["categoria"])).toContain("Tacos");
    const canasta = await tool(reader, "cfo_platillos").run(ctx(), { ...SEMANA, vista: "canasta" });
    expect(["ok", "empty"]).toContain(canasta.status);
  });

  it("cfo_patrones: día de la semana, colonias (solo agregados) y canal×hora", async () => {
    const reader = new CfoFakeReader();
    const dias = await tool(reader, "cfo_patrones").run(ctx(), SEMANA);
    expect(dias.rows.map((x) => x["dia"])).toContain("Sábado");
    expect(dias.summary).toMatch(/Mejor día/);
    const ch = await tool(reader, "cfo_patrones").run(ctx(), { ...SEMANA, vista: "canal_hora", limite: 4 });
    expect(ch.rows.length).toBeLessThanOrEqual(4);
    if (ch.rows.length > 1) expect(ch.rows[0]!["pedidos"] as number).toBeGreaterThanOrEqual(ch.rows[1]!["pedidos"] as number);
    const col = await tool(reader, "cfo_patrones").run(ctx(), { ...SEMANA, vista: "colonias" });
    expect(["ok", "empty"]).toContain(col.status);
  });

  it("cfo_agente: costo por pedido y tasa de cierre; Meta sin medir se dice, nunca $0", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_agente").run(ctx(), SEMANA);
    expect(r.status).toBe("ok");
    const total = r.rows[r.rows.length - 1]!;
    expect(total["sucursal"]).toBe("Total");
    expect(r.columns.find((c) => c.key === "costo_por_pedido")!.kind).toBe("mxn");
    expect(r.summary).toMatch(/Costo del agente por pedido|Sin costo por pedido/);
  });
});

describe("alcance: sucursal por nombre, ajena = inexistente, «No asignado» solo con organización completa", () => {
  it("una sucursal por nombre acota el servicio a esa sucursal", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_comparar_sucursales").run(ctx(), { ...SEMANA, sucursal: "Altabrisa" });
    expect(r.scopeLabel).toBe("sucursal Altabrisa");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!["sucursal"]).toBe("Altabrisa");
    expect(reader.entradas[0]!.propertyIdsSql).toEqual([T8]);
    expect(reader.entradas[0]!.alcance).toMatchObject({ todas: false, organizacionCompleta: true });
  });

  it("owner sin sucursal: propertyIdsSql null (la SQL resuelve el alcance) y alcance 'todas'", async () => {
    const reader = new CfoFakeReader();
    await tool(reader, "cfo_resumen").run(ctx(), SEMANA);
    expect(reader.entradas[0]!.propertyIdsSql).toBeNull();
    expect(reader.entradas[0]!.alcance).toMatchObject({ todas: true, organizacionCompleta: true });
    expect(reader.entradas[0]!.alcance.propertyIds).toEqual(IDS);
  });

  it("nombre ambiguo: pide aclarar y no consulta el CFO", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_resumen").run(ctx(), { ...SEMANA, sucursal: "Montejo" });
    expect(r.status).toBe("needs_clarification");
    expect(r.message).toMatch(/varias sucursales/);
    expect(reader.entradas).toHaveLength(0);
  });

  it("admin acotado que pide una sucursal ajena recibe EXACTAMENTE lo mismo que con una inexistente (sin confirmar que existe)", async () => {
    const reader = new CfoFakeReader();
    const ajena = await tool(reader, "cfo_resumen").run(ctx(GERENTE_T1_SCOPE), { ...SEMANA, sucursal: "Altabrisa" });
    const inexistente = await tool(reader, "cfo_resumen").run(ctx(GERENTE_T1_SCOPE), { ...SEMANA, sucursal: "Narnia" });
    expect(ajena.status).toBe("needs_clarification");
    expect(ajena.message).toMatch(/No encontré esa sucursal/);
    expect(ajena.message).toBe(inexistente.message);
    expect(ajena.message).not.toMatch(/Altabrisa/);
    expect(reader.entradas).toHaveLength(0);
  });

  it("admin acotado sin sucursal: 'todas' = solo las suyas, rotulado así, con propertyIdsSql explícito y sin organización completa", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_comparar_sucursales").run(ctx(GERENTE_T1_SCOPE), SEMANA);
    expect(r.scopeLabel).toBe("sucursal Prolongación Montejo");
    expect(r.rows).toHaveLength(1);
    expect(reader.entradas[0]!.propertyIdsSql).toEqual([T1]);
    expect(reader.entradas[0]!.alcance.organizacionCompleta).toBe(false);
  });

  it("«No asignado» (costo del agente de la organización) solo con organización completa y sin sucursal elegida", async () => {
    const conLlm = D.agenteDiario.map((f, i) => (i === 0 ? { ...f, propertyId: null } : f));
    const owner = new CfoFakeReader({ dataset: { agenteDiario: conLlm } });
    const todas = await tool(owner, "cfo_agente").run(ctx(), SEMANA);
    const filasOwner = todas.rows.map((x) => x["sucursal"]);
    const acotado = await tool(new CfoFakeReader({ dataset: { agenteDiario: conLlm } }), "cfo_agente").run(ctx(GERENTE_T1_SCOPE), SEMANA);
    expect(acotado.rows.map((x) => x["sucursal"])).not.toContain("No asignado");
    const una = await tool(new CfoFakeReader({ dataset: { agenteDiario: conLlm } }), "cfo_agente").run(ctx(), { ...SEMANA, sucursal: "Altabrisa" });
    expect(una.rows.map((x) => x["sucursal"])).not.toContain("No asignado");
    // Con organización completa el servicio puede mostrarla: si el dataset aporta costo sin sucursal, aparece.
    expect(filasOwner.filter((n) => n === "No asignado").length).toBeLessThanOrEqual(1);
  });
});

describe("SoftRestaurant: honestidad sin importación", () => {
  it("sin SR: dice que no hay ventas importadas y no rellena mostrador ni domicilio", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_softrestaurant").run(ctx(), SEMANA);
    expect(r.status).toBe("empty");
    expect(r.rows).toEqual([]);
    expect(r.message).toMatch(/Todavía no hay ventas importadas de SoftRestaurant/);
    expect(r.message).toMatch(/no puedo separar mostrador y domicilio/);
    expect(r.summary).toBe(r.message);
  });

  it("con SR importado: separa domicilio y presencial con cifras del desglose y cita el cuadre", async () => {
    const reader = new CfoFakeReader({ dataset: { srResumen: D.srResumen } });
    const r = await tool(reader, "cfo_softrestaurant").run(ctx(), SEMANA);
    expect(r.status).toBe("ok");
    expect(r.rows.map((x) => x["concepto"])).toContain("Domicilio (SoftRestaurant)");
    const presencial = r.rows.find((x) => String(x["concepto"]).startsWith("Presencial"))!["ventas"] as number;
    const partes = r.rows.filter((x) => ["Comedor", "Para llevar", "Rápido"].includes(String(x["concepto"]))).reduce((s, x) => s + (x["ventas"] as number), 0);
    expect(presencial).toBeCloseTo(partes, 2);
    expect(r.summary).toMatch(/Ventas presenciales/);
  });
});

describe("base sin migrar y errores", () => {
  it("sin las migraciones 081-083: el servicio degrada con disponible:false y la herramienta responde 'unavailable' (sin cifras, sin 500)", async () => {
    const reader = new CfoFakeReader({ repo: { migraciones: { m081: false, m082: false, m083: false, m084: false } } });
    for (const name of ["cfo_resumen", "cfo_lo_mas_importante", "cfo_estado_resultados", "cfo_comparar_sucursales", "cfo_platillos", "cfo_patrones", "cfo_softrestaurant"]) {
      const r = await tool(reader, name).run(ctx(), SEMANA);
      expect(r.status, name).toBe("unavailable");
      expect(r.rows, name).toEqual([]);
      expect(r.message, name).toMatch(/todavía no está disponible/);
    }
    for (const name of ["cfo_clientes", "cfo_agente"]) {
      expect((await tool(reader, name).run(ctx(), SEMANA)).status, name).toBe("unavailable");
    }
  });

  it("sin la 084 (frecuentes dormidos y p90 de descuento) el resto del CFO sigue respondiendo", async () => {
    const reader = new CfoFakeReader({ repo: { migraciones: { m084: false } } });
    const r = await tool(reader, "cfo_resumen").run(ctx(), SEMANA);
    expect(r.status).toBe("ok");
  });

  it("DataChatUnavailableError del lector se traduce a 'unavailable'; un lector sin CFO también", async () => {
    const r1 = await tool(new CfoFakeReader({ falla: new DataChatUnavailableError("cfo") }), "cfo_resumen").run(ctx(), SEMANA);
    expect(r1.status).toBe("unavailable");
    const r2 = await tool(new FakeReader(CFO_BRANCHES), "cfo_resumen").run(ctx(), SEMANA);
    expect(r2.status).toBe("unavailable");
  });

  it("errores inesperados del servicio no se tragan (los atrapa el motor)", async () => {
    await expect(tool(new CfoFakeReader({ falla: new Error("boom") }), "cfo_resumen").run(ctx(), SEMANA)).rejects.toThrow("boom");
  });

  it("sin periodo pide aclaración y no consulta", async () => {
    const reader = new CfoFakeReader();
    const r = await tool(reader, "cfo_resumen").run(ctx(), {});
    expect(r.status).toBe("needs_clarification");
    expect(reader.entradas).toHaveLength(0);
  });
});

describe("lector Postgres contra la base SIN las migraciones del CFO", () => {
  const pgError = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });

  it("cada función SQL del CFO ausente (42883) degrada a 'unavailable' y la transacción compartida sigue utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] },
      { match: /from core\.property p\s+join restaurantes\.branch_detail/i, respond: () => [{ property_id: T1, name: "Prolongación Montejo", slug: "t1" }] },
      { match: /cfo_|restaurantes\.sr_/i, respond: () => pgError("42883", "function restaurantes.cfo_x() does not exist") },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const t = buildRestaurantesDataChatTools(new PostgresRestaurantesDataChatReader(session)).find((x) => x.name === "cfo_resumen")!;
    const r = await t.run(ctx(), SEMANA);
    expect(r.status).toBe("unavailable");
    expect(r.rows).toEqual([]);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("de punta a punta con el motor: la guardia de números", () => {
  it("una cifra inventada por el modelo se descarta; las del servicio sobreviven", async () => {
    const reader = new CfoFakeReader();
    const catalog = buildRestaurantesDataChatCatalog(reader);
    const real = await tool(reader, "cfo_resumen").run(ctx(), SEMANA);
    const inventada = scriptedCompletion([CALL("cfo_resumen", SEMANA), { text: "Vendiste $987,654.32 MXN la semana pasada." }]);
    const a = await runDataChatTurn({ catalog, scope: OWNER_CFO_SCOPE, question: "¿cómo me fue la semana pasada?", complete: inventada.complete, now: new Date() });
    expect(JSON.stringify(a)).not.toContain("987,654");
    expect(a.text).toBe(real.summary);
    const ventas = String(real.rows[0]!["ventas"]);
    expect(ventas).toBeTruthy();
    const fiel = scriptedCompletion([CALL("cfo_resumen", SEMANA), { text: `Vendiste ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(real.rows[0]!["ventas"] as number)} MXN.` }]);
    const b = await runDataChatTurn({ catalog, scope: OWNER_CFO_SCOPE, question: "¿cuánto vendí la semana pasada?", complete: fiel.complete, now: new Date() });
    expect(b.status).toBe("ok");
    expect(b.text).toContain("Vendiste");
    expect(b.blocks[0]!.tool).toBe("cfo_resumen");
    expect(b.sources[0]!.source).toMatch(/no sustituye a tu contador/);
  });

  it("admin acotado que pide otra sucursal por el motor: 'no encontré esa sucursal' y ninguna cifra ajena", async () => {
    const reader = new CfoFakeReader();
    const llm = scriptedCompletion([CALL("cfo_resumen", { ...SEMANA, sucursal: "Altabrisa" }), { text: "Altabrisa vendió $1 MXN" }]);
    const a = await runDataChatTurn({ catalog: buildRestaurantesDataChatCatalog(reader), scope: GERENTE_T1_SCOPE, question: "¿cuánto vendió Altabrisa?", complete: llm.complete, now: new Date() });
    expect(a.status).toBe("clarify");
    expect(a.text).toMatch(/No encontré esa sucursal/);
    expect(a.blocks).toEqual([]);
  });
});
