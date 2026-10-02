// Contenido verificado del reporte PDF: analista -> redactor -> guardia numerica, con LLM guionado (sin red, sin gasto).
import { describe, expect, it } from "vitest";
import { GatewayBudgetExceededError, KillSwitchEngagedError } from "../../src/gateway/index.js";
import {
  esReporteFinanciero,
  ejecutarHerramientasReporte,
  generarContenidoReporte,
  graficasDelCatalogo,
  type ReporteTabla,
} from "../../src/data-chat/reporte.js";
import { scriptedCompletion } from "../../src/data-chat/scripted-llm.js";
import { NOW, SCOPE_A, SALES_COLUMNS, catalogOf, salesTool } from "./support.js";

const TABLA: ReporteTabla = {
  tool: "ventas_por_dia",
  title: "Ventas por día",
  source: "Pedidos (sin cancelados)",
  periodLabel: "últimos 30 días",
  scopeLabel: "todas tus sucursales",
  columns: SALES_COLUMNS,
  rows: [
    { dia: "2026-09-28", ventas: 1500.5, pedidos: 12 },
    { dia: "2026-09-29", ventas: 980, pedidos: 8 },
  ],
  truncated: false,
  chart: { kind: "bar", x: "dia", y: "ventas" },
  summary: "Ventas del periodo: $2,480.50 MXN en 20 pedidos.",
};

const ANALISIS_OK = JSON.stringify({
  hallazgos: [
    { tipo: "kpi", texto: "El 28 de septiembre se vendieron 1500.5 pesos en 12 pedidos.", fuentes: [{ herramienta: "ventas_por_dia", fila: 1 }] },
    { tipo: "riesgo", texto: "El día siguiente bajó a 980 pesos en 8 pedidos.", fuentes: [{ herramienta: "ventas_por_dia", fila: 2 }] },
  ],
});
const REDACCION_OK = JSON.stringify({
  resumen: "Se vendieron 2,480.50 pesos en 20 pedidos.",
  secciones: [{ titulo: "Ventas", texto: "El mejor día fue el 28 con 1500.5 pesos y 12 pedidos." }],
  graficas: [{ tipo: "bar", herramienta: "ventas_por_dia", x: "dia", y: "ventas", titulo: "Ventas por día" }],
});
const REDACCION_INVENTADA = JSON.stringify({
  resumen: "Se vendieron 9,999 pesos en 20 pedidos.",
  secciones: [{ titulo: "Ventas", texto: "Creció 47% contra el mes pasado." }],
  graficas: [],
});

function correr(analisis: ReturnType<typeof scriptedCompletion>, redaccion: ReturnType<typeof scriptedCompletion>, tablas: readonly ReporteTabla[] = [TABLA]) {
  return generarContenidoReporte({ tablas, vertical: "restaurantes", analisis: analisis.complete, redaccion: redaccion.complete });
}

describe("generarContenidoReporte: pipeline verificado", () => {
  it("camino feliz: hallazgos con fuente, narrativa y graficas del redactor", async () => {
    const a = scriptedCompletion([{ text: ANALISIS_OK }]);
    const r = scriptedCompletion([{ text: REDACCION_OK }]);
    const c = await correr(a, r);
    expect(c.narrativa?.resumen).toContain("20 pedidos");
    expect(c.hallazgos).toHaveLength(2);
    expect(c.hallazgos[0]!.fuentes).toEqual([{ tool: "ventas_por_dia", fila: 1 }]);
    expect(c.graficas).toEqual([{ kind: "bar", tool: "ventas_por_dia", x: "dia", y: "ventas", titulo: "Ventas por día" }]);
    expect(c.motivoSinNarrativa).toBeUndefined();
    expect(c.uso).toMatchObject({ llmCalls: 2, reintento: false });
    // salida estructurada pedida en ambas etapas
    expect(a.requests[0]!.responseFormat?.name).toBe("analisis_reporte");
    expect(r.requests[0]!.responseFormat?.name).toBe("redaccion_reporte");
  });

  it("cifra inventada en la redaccion: se rechaza y hay UN reintento que se acepta", async () => {
    const a = scriptedCompletion([{ text: ANALISIS_OK }]);
    const r = scriptedCompletion([{ text: REDACCION_INVENTADA }, { text: REDACCION_OK }]);
    const c = await correr(a, r);
    expect(c.narrativa).not.toBeNull();
    expect(c.uso.reintento).toBe(true);
    expect(r.requests).toHaveLength(2);
    const reintento = r.requests[1]!.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
    expect(reintento).toContain("no cumplió las reglas");
    expect(JSON.stringify(c)).not.toContain("9,999");
    expect(JSON.stringify(c)).not.toContain("47%");
  });

  it("doble fallo de la guardia: reporte SIN narrativa (solo tablas y graficas del catalogo) y exactamente 2 intentos", async () => {
    const a = scriptedCompletion([{ text: ANALISIS_OK }]);
    const r = scriptedCompletion([{ text: REDACCION_INVENTADA }]);
    const c = await correr(a, r);
    expect(c.narrativa).toBeNull();
    expect(c.motivoSinNarrativa).toBe("guardia");
    expect(c.hallazgos).toEqual([]);
    expect(r.requests).toHaveLength(2);
    expect(c.tablas).toHaveLength(1);
    expect(c.graficas).toEqual([{ kind: "bar", tool: "ventas_por_dia", x: "dia", y: "ventas", titulo: "Ventas por día" }]);
  });

  it("hallazgos con cifra ajena, fila inexistente o herramienta inventada se descartan; sin ninguno valido no hay narrativa", async () => {
    const malos = JSON.stringify({
      hallazgos: [
        { tipo: "kpi", texto: "Las ventas subieron 73%.", fuentes: [{ herramienta: "ventas_por_dia", fila: 1 }] },
        { tipo: "kpi", texto: "Se vendieron 980 pesos.", fuentes: [{ herramienta: "ventas_por_dia", fila: 99 }] },
        { tipo: "kpi", texto: "Se vendieron 980 pesos.", fuentes: [{ herramienta: "otra_cosa", fila: 1 }] },
        { tipo: "kpi", texto: "Se vendieron 980 pesos.", fuentes: [] },
        { tipo: "invento", texto: "Se vendieron 980 pesos.", fuentes: [{ herramienta: "ventas_por_dia", fila: 2 }] },
      ],
    });
    const a = scriptedCompletion([{ text: malos }]);
    const r = scriptedCompletion([{ text: REDACCION_OK }]);
    const c = await correr(a, r);
    expect(c.narrativa).toBeNull();
    expect(c.motivoSinNarrativa).toBe("guardia");
    expect(r.requests).toHaveLength(0);
  });

  it("un hallazgo valido sobrevive aunque otros se descarten", async () => {
    const mixto = JSON.stringify({
      hallazgos: [
        { tipo: "kpi", texto: "Las ventas subieron 73%.", fuentes: [{ herramienta: "ventas_por_dia", fila: 1 }] },
        { tipo: "kpi", texto: "Se vendieron 980 pesos en 8 pedidos.", fuentes: [{ herramienta: "ventas_por_dia", fila: 2 }] },
      ],
    });
    const c = await correr(scriptedCompletion([{ text: mixto }]), scriptedCompletion([{ text: REDACCION_OK }]));
    expect(c.hallazgos).toHaveLength(1);
    expect(c.narrativa).not.toBeNull();
  });

  it("JSON invalido del analista: sin narrativa por la guardia (nunca texto sin verificar)", async () => {
    const c = await correr(scriptedCompletion([{ text: "claro, aquí tienes tu reporte" }]), scriptedCompletion([{ text: REDACCION_OK }]));
    expect(c.narrativa).toBeNull();
    expect(c.motivoSinNarrativa).toBe("guardia");
  });

  it("sin proveedor de IA: PDF solo con datos y motivo sin_ia", async () => {
    const c = await generarContenidoReporte({ tablas: [TABLA], vertical: "restaurantes" });
    expect(c.narrativa).toBeNull();
    expect(c.motivoSinNarrativa).toBe("sin_ia");
    expect(c.uso.llmCalls).toBe(0);
    expect(c.graficas).toHaveLength(1);
  });

  it("tope agotado, interruptor apagado y proveedor caido: datos solamente con su motivo, sin reintentar", async () => {
    const casos: [Error, string][] = [
      [new GatewayBudgetExceededError("tenant", 1, 1), "tope"],
      [new KillSwitchEngagedError("agente:reportes:analisis_general", "reportes:analisis_general"), "interruptor"],
      [new Error("503"), "proveedor"],
    ];
    for (const [err, motivo] of casos) {
      const a = scriptedCompletion([() => err]);
      const r = scriptedCompletion([{ text: REDACCION_OK }]);
      const c = await correr(a, r);
      expect(c.narrativa).toBeNull();
      expect(c.motivoSinNarrativa).toBe(motivo);
      expect(a.requests).toHaveLength(1);
      expect(c.tablas).toHaveLength(1);
    }
  });

  it("sin tiempo en el presupuesto: no llama al modelo y entrega datos (motivo tiempo)", async () => {
    const a = scriptedCompletion([{ text: ANALISIS_OK }]);
    const r = scriptedCompletion([{ text: REDACCION_OK }]);
    const c = await generarContenidoReporte({ tablas: [TABLA], vertical: "restaurantes", analisis: a.complete, redaccion: r.complete, presupuestoMs: 500 });
    expect(c.motivoSinNarrativa).toBe("tiempo");
    expect(a.requests).toHaveLength(0);
  });

  it("la entrada al modelo no contiene telefonos, correos, tarjetas ni enlaces (PII redactada)", async () => {
    const conPii: ReporteTabla = {
      ...TABLA,
      tool: "clientes",
      title: "Clientes",
      columns: [
        { key: "cliente", label: "Cliente", kind: "text" },
        { key: "nota", label: "Nota", kind: "text" },
        { key: "total", label: "Total", kind: "mxn" },
      ],
      rows: [
        { cliente: "Ana López ana.lopez@correo.mx", nota: "llamar al 999 123 4567 o +52 55 1234 5678 tarjeta 4111 1111 1111 1111 https://x.example/a", total: 500 },
      ],
      chart: undefined,
      summary: undefined,
    };
    const a = scriptedCompletion([{ text: JSON.stringify({ hallazgos: [] }) }]);
    const r = scriptedCompletion([{ text: REDACCION_OK }]);
    await correr(a, r, [conPii]);
    const entrada = a.requests[0]!.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
    expect(entrada).not.toMatch(/ana\.lopez@correo\.mx/);
    expect(entrada).not.toMatch(/999 123 4567|1234 5678|4111/);
    expect(entrada).not.toMatch(/https?:\/\//);
    expect(entrada).toContain("[correo]");
    expect(entrada).toContain("[teléfono]");
    expect(entrada).toContain("[tarjeta]");
  });

  it("la entrada del analista respeta el tope de ~8k tokens recortando filas por igual", async () => {
    const filas = Array.from({ length: 50 }, (_, i) => ({ dia: `2026-08-${String((i % 28) + 1).padStart(2, "0")} ${"x".repeat(55)}`, ventas: 100 + i, pedidos: i }));
    const grande: ReporteTabla = { ...TABLA, rows: filas };
    const a = scriptedCompletion([{ text: JSON.stringify({ hallazgos: [] }) }]);
    await correr(a, scriptedCompletion([{ text: REDACCION_OK }]), [grande, { ...grande, tool: "t2", title: "T2" }, { ...grande, tool: "t3", title: "T3" }, { ...grande, tool: "t4", title: "T4" }]);
    const entrada = a.requests[0]!.messages.map((m) => ("content" in m ? m.content : "")).join("");
    expect(entrada.length).toBeLessThanOrEqual(24_000);
    expect(entrada).toContain("filasTotales");
  });
});

describe("rol financiero y graficas del catalogo", () => {
  it("despachos y cualquier tabla con MXN usan el rol financiero; lo demas, el general", () => {
    expect(esReporteFinanciero("despachos", [])).toBe(true);
    expect(esReporteFinanciero("restaurantes", [TABLA])).toBe(true);
    const sinDinero: ReporteTabla = { ...TABLA, columns: [{ key: "dia", label: "Día", kind: "text" }, { key: "n", label: "N", kind: "integer" }], rows: [{ dia: "a", n: 1 }] };
    expect(esReporteFinanciero("citas", [sinDinero])).toBe(false);
  });

  it("solo propone graficas con columnas reales y al menos 2 filas", () => {
    expect(graficasDelCatalogo([TABLA])).toHaveLength(1);
    expect(graficasDelCatalogo([{ ...TABLA, rows: [TABLA.rows[0]!] }])).toHaveLength(0);
    expect(graficasDelCatalogo([{ ...TABLA, chart: { kind: "bar", x: "no_existe", y: "ventas" } }])).toHaveLength(0);
    expect(graficasDelCatalogo([{ ...TABLA, chart: { kind: "kpi", x: "dia", y: "ventas" } }])).toHaveLength(0);
  });
});

describe("ejecutarHerramientasReporte: re-ejecuta con el alcance ACTUAL", () => {
  it("usa el scope dado, no cifras guardadas, y omite herramientas inexistentes o con argumentos que ya no validan", async () => {
    const seen: Parameters<ReturnType<typeof salesTool>["run"]>[0][] = [];
    const catalog = catalogOf(salesTool({}, seen));
    const { tablas, omitidas } = await ejecutarHerramientasReporte({
      catalog,
      scope: SCOPE_A,
      now: NOW,
      calls: [
        { tool: "ventas_por_dia", args: { periodo: "ultimos_30_dias" } },
        { tool: "ventas_por_dia", args: { periodo: "ultimos_30_dias" } }, // duplicada
        { tool: "ya_no_existe", args: {} },
        { tool: "ventas_por_dia", args: { periodo: "nunca" } },
      ],
    });
    expect(tablas).toHaveLength(1);
    expect(tablas[0]!.rows[0]).toMatchObject({ ventas: 1500.5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.scope).toBe(SCOPE_A);
    expect(seen[0]!.maxRows).toBe(50);
    expect(omitidas.map((o) => o.tool)).toEqual(["ya_no_existe", "ventas_por_dia"]);
  });

  it("una herramienta que lanza o regresa vacio queda como omitida con su motivo (nunca ceros inventados)", async () => {
    const roto = { ...salesTool(), run: async () => { throw new Error("boom"); } };
    const vacio = { ...salesTool({ rows: [] }), name: "vacia", label: "Vacía" };
    const { tablas, omitidas } = await ejecutarHerramientasReporte({
      catalog: catalogOf(roto, vacio),
      scope: SCOPE_A,
      now: NOW,
      calls: [
        { tool: "ventas_por_dia", args: { periodo: "hoy" } },
        { tool: "vacia", args: { periodo: "hoy" } },
      ],
    });
    expect(tablas).toHaveLength(0);
    expect(omitidas).toHaveLength(2);
    expect(omitidas[0]!.motivo).toContain("No pude consultar");
    expect(omitidas[1]!.motivo).toContain("Sin datos");
  });
});
