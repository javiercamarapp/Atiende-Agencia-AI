import { describe, expect, it } from "vitest";
import { runDataChatTurn, scriptedCompletion, toJsonSchema, type DataChatTool, type DataChatToolContext, type ScriptStep } from "@atiende/agent-core/data-chat";
import { buildLicitacionesDataChatCatalog, buildLicitacionesDataChatTools, semaforoPorDias, SEMAFORO_AMARILLO_DIAS, SEMAFORO_ROJO_DIAS } from "../../src/data-chat/index.ts";
import { ALL_DATA_CHAT_SQL } from "../../src/data-chat/index.ts";
import { FakeReader, NOW, ORG_A, OWNER_SCOPE, unavailable } from "./support.ts";

function ctx(scope = OWNER_SCOPE, now = NOW): DataChatToolContext {
  return { scope, now, signal: new AbortController().signal, maxRows: 50 };
}

function toolOf(reader: FakeReader, name: string): DataChatTool {
  return buildLicitacionesDataChatTools(reader).find((t) => t.name === name)!;
}

describe("catálogo de licitaciones — cerrado y sin escape", () => {
  const tools = buildLicitacionesDataChatTools(new FakeReader());

  it("expone exactamente las 6 herramientas del catálogo (sin preguntas de junta: #240 no está en main)", () => {
    expect(tools.map((t) => t.name)).toEqual(["convocatorias_abiertas", "plazos_semaforo", "go_no_go", "propuestas_por_estado", "fallos", "renovaciones"]);
    expect(tools.some((t) => /junta|pregunta/i.test(t.name))).toBe(false);
  });

  it("ninguna herramienta acepta organización, tenant, rol, SQL ni identificadores crudos", () => {
    const forbidden = /org|tenant|property|propiedad|role|rol|sql|query|user|usuario|rfc|id$/i;
    for (const t of tools) {
      for (const key of Object.keys(t.params)) expect(key, `${t.name}.${key}`).not.toMatch(forbidden);
      expect(toJsonSchema(t.params)).toMatchObject({ additionalProperties: false });
    }
  });

  it("parámetros por herramienta: periodo solo en go_no_go y fallos; el resto acotado a enteros con rango", () => {
    const keys = (n: string) => Object.keys(tools.find((t) => t.name === n)!.params).sort();
    expect(keys("go_no_go")).toEqual(["desde", "hasta", "periodo"]);
    expect(keys("fallos")).toEqual(["desde", "hasta", "periodo"]);
    expect(keys("convocatorias_abiertas")).toEqual(["limite", "vencen_en_dias"]);
    expect(keys("renovaciones")).toEqual(["dentro_de_dias"]);
    expect(keys("plazos_semaforo")).toEqual([]);
    expect(keys("propuestas_por_estado")).toEqual([]);
  });

  it("terminología mexicana: ComprasMX y LAASSP en descripciones/dominio", () => {
    const all = tools.map((t) => t.description).join(" ") + buildLicitacionesDataChatCatalog(new FakeReader()).domain;
    expect(all).toMatch(/ComprasMX/);
    expect(all).toMatch(/LAASSP/);
    expect(buildLicitacionesDataChatCatalog(new FakeReader()).domain).toContain("junta de aclaraciones todavía no están disponibles");
  });
});

describe("semáforo de plazos", () => {
  it.each([
    [null, "Sin fecha límite"],
    [-1, "Vencida"],
    [0, "Rojo"],
    [SEMAFORO_ROJO_DIAS, "Rojo"],
    [SEMAFORO_ROJO_DIAS + 1, "Amarillo"],
    [SEMAFORO_AMARILLO_DIAS, "Amarillo"],
    [SEMAFORO_AMARILLO_DIAS + 1, "Verde"],
    [90, "Verde"],
  ])("dias=%s -> %s", (dias, esperado) => {
    expect(semaforoPorDias(dias)).toBe(esperado);
  });

  it("los umbrales de TypeScript coinciden con los del SQL (3 y 7 dias)", () => {
    const sql = ALL_DATA_CHAT_SQL["SQL_PLAZOS_SEMAFORO"]!;
    expect(sql).toContain(`<= ${SEMAFORO_ROJO_DIAS} then 'Rojo`);
    expect(sql).toContain(`<= ${SEMAFORO_AMARILLO_DIAS} then 'Amarillo`);
  });
});

describe("convocatorias_abiertas", () => {
  it("fechas en la zona del negocio: manda 'ahora' como instante y la zona America/Merida", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "convocatorias_abiertas").run(ctx(), {});
    const w = reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.window!;
    expect(w.timezone).toBe("America/Merida");
    expect(w.ahora.toISOString()).toBe(NOW.toISOString());
    expect(w.organizationId).toBe(ORG_A);
    expect(r.scopeLabel).toBe("toda tu organización");
    expect(reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.extra).toBeNull();
  });

  it("usa la zona configurada de la organización por encima de la del alcance", async () => {
    const reader = new FakeReader();
    reader.timezone = "America/Mexico_City";
    await toolOf(reader, "convocatorias_abiertas").run(ctx(), {});
    expect(reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.window!.timezone).toBe("America/Mexico_City");
  });

  it("una zona horaria invalida (configurada o del alcance) cae al default y NUNCA llega al SQL", async () => {
    const reader = new FakeReader();
    reader.timezone = "Mars/Olympus";
    await toolOf(reader, "convocatorias_abiertas").run(ctx({ ...OWNER_SCOPE, timezone: "Narnia/Cair" }), {});
    expect(reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.window!.timezone).toBe("America/Merida");
  });

  it("montos en MXN con redondeo; sin monto en otra moneda (no se convierte); semáforo por fila", async () => {
    const r = await toolOf(new FakeReader(), "convocatorias_abiertas").run(ctx(), {});
    expect(r.status).toBe("ok");
    expect(r.rows[0]).toMatchObject({ convocatoria: "Suministro de uniformes escolares", estatus: "Propuesta en elaboración", dias: 2, semaforo: "Rojo", monto: 1250000.5 });
    expect(r.rows[1]).toMatchObject({ estatus: "En revisión", semaforo: "Verde" });
    expect(r.rows[2]).toMatchObject({ fecha_limite: "Sin fecha registrada", semaforo: "Sin fecha límite", monto: null, dependencia: "—" });
    expect(r.columns.find((c) => c.key === "monto")!.kind).toBe("mxn");
    expect(r.summary).toBe("3 convocatorias abiertas; suman $1,730,000.50 MXN en las 2 con monto estimado en MXN.");
  });

  it("'por vencer': pasa el horizonte al lector y lo declara en la fuente", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "convocatorias_abiertas").run(ctx(), { vencen_en_dias: 7 });
    expect(reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.extra).toBe(7);
    expect(r.source).toContain("próximos 7 días");
    expect(r.summary).toContain("que vencen en los próximos 7 días");
  });

  it("límite del usuario: pide limite+1 filas para detectar que hay más", async () => {
    const reader = new FakeReader();
    reader.abiertas = Array.from({ length: 3 }, (_, i) => ({ titulo: `Conv ${i}`, dependencia: null, entidad: null, status: "go", fechaLimite: "2026-10-10 10:00", diasRestantes: 10, montoMxn: null, moneda: "MXN" }));
    const r = await toolOf(reader, "convocatorias_abiertas").run(ctx(), { limite: 2 });
    expect(reader.calls.find((c) => c.method === "convocatoriasAbiertas")!.window!.limit).toBe(3);
    expect(r.rows).toHaveLength(2);
    expect(r.summary).toContain("Se muestran 2 de más de 2");
  });

  it("sin convocatorias: empty con mensaje claro, nunca 0 inventado", async () => {
    const reader = new FakeReader();
    reader.abiertas = [];
    const r = await toolOf(reader, "convocatorias_abiertas").run(ctx(), {});
    expect(r.status).toBe("empty");
    expect(r.summary).toBe("No hay convocatorias abiertas.");
  });
});

describe("plazos_semaforo", () => {
  it("cuenta por semáforo y suma urgentes (rojo + vencidas)", async () => {
    const r = await toolOf(new FakeReader(), "plazos_semaforo").run(ctx(), {});
    expect(r.rows).toHaveLength(3);
    expect(r.summary).toBe("8 convocatorias abiertas, 3 en rojo o ya vencidas sin presentar.");
    expect(r.source).toContain("rojo 3 o menos, amarillo 4 a 7, verde más de 7");
  });
});

describe("go_no_go y fallos (periodo en America/Merida)", () => {
  it("este_mes -> ventana [1-sep 00:00, 30-sep 00:00 Mérida) = instantes UTC", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "go_no_go").run(ctx(), { periodo: "este_mes" });
    const w = reader.calls.find((c) => c.method === "goNoGo")!.window!;
    expect(w.desde.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    expect(w.hasta.toISOString()).toBe("2026-09-30T06:00:00.000Z");
    expect(r.rows[0]).toMatchObject({ decision: "Go", elegibilidad: "Cumple", puntaje: 87.5, motivo: "Experiencia comprobable" });
    expect(r.rows[1]).toMatchObject({ decision: "No-go", elegibilidad: "No cumple", motivo: "—" });
    expect(r.summary).toContain("2, 1 go y 1 no-go");
  });

  it("fallos: ganadas/perdidas, monto estimado de la convocatoria (no el adjudicado) y periodo en etiqueta", async () => {
    const r = await toolOf(new FakeReader(), "fallos").run(ctx(), { periodo: "mes_pasado" });
    expect(r.rows[0]).toMatchObject({ resultado: "Ganada", monto: 900000 });
    expect(r.rows[1]).toMatchObject({ resultado: "Perdida", monto: null });
    expect(r.summary).toContain("1 ganadas y 1 perdidas");
    expect(r.source).toContain("presupuesto estimado");
    expect(r.periodLabel).toContain("mes pasado");
  });

  it("sin periodo: aclaración y NO consulta datos", async () => {
    const reader = new FakeReader();
    for (const name of ["go_no_go", "fallos"]) {
      const r = await toolOf(reader, name).run(ctx(), {});
      expect(r.status).toBe("needs_clarification");
    }
    expect(reader.calls.some((c) => c.method === "goNoGo" || c.method === "fallos")).toBe(false);
  });

  it("fechas exactas inválidas o futuras no llegan al lector", async () => {
    const reader = new FakeReader();
    expect((await toolOf(reader, "fallos").run(ctx(), { desde: "2026-09-10", hasta: "2026-09-01" })).status).toBe("error");
    expect((await toolOf(reader, "go_no_go").run(ctx(), { desde: "2026-12-01", hasta: "2026-12-31" })).status).toBe("error");
    expect(reader.calls.some((c) => c.method === "goNoGo" || c.method === "fallos")).toBe(false);
  });

  it("más filas que el tope: avisa que hay más en vez de contar sobre un recorte", async () => {
    const reader = new FakeReader();
    reader.fallosRows = Array.from({ length: 51 }, (_, i) => ({ titulo: `F${i}`, dependencia: null, resultado: "won" as const, fecha: "2026-09-01", montoMxn: null }));
    const r = await toolOf(reader, "fallos").run(ctx(), { periodo: "este_mes" });
    expect(r.summary).toContain("más de 50 fallos");
    expect(r.summary).not.toContain("ganadas");
  });
});

describe("propuestas_por_estado y renovaciones", () => {
  it("propuestas por estatus con presentadas y sin montos", async () => {
    const r = await toolOf(new FakeReader(), "propuestas_por_estado").run(ctx(), {});
    expect(r.rows[0]).toMatchObject({ estado: "Presentada", propuestas: 4, presentadas: 4 });
    expect(r.rows.map((x) => x["estado"])).toEqual(["Presentada", "Propuesta en elaboración", "Ganada"]);
    expect(r.summary).toBe("9 propuestas, 6 con declaración de presentación.");
    expect(r.columns.some((c) => c.kind === "mxn")).toBe(false);
  });

  it("renovaciones: horizonte por defecto 90 días, opción de renovación y alerta del radar", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "renovaciones").run(ctx(), {});
    expect(reader.calls.find((c) => c.method === "renovaciones")!.extra).toBe(90);
    expect(r.rows[0]).toMatchObject({ contrato: "IMSS-2025-044", estatus: "En ejecución", opcion: "Sí", alerta: "Pendiente", dias: 47 });
    expect(r.rows[1]).toMatchObject({ contrato: "Sin número", opcion: "No", alerta: "—", dependencia: "—" });
    expect(r.summary).toBe("2 contratos terminan su vigencia en los próximos 90 días; 1 con opción de renovación.");
  });

  it("renovaciones con horizonte explícito y sin resultados: empty honesto", async () => {
    const reader = new FakeReader();
    reader.renov = [];
    const r = await toolOf(reader, "renovaciones").run(ctx(), { dentro_de_dias: 30 });
    expect(reader.calls.find((c) => c.method === "renovaciones")!.extra).toBe(30);
    expect(r.status).toBe("empty");
    expect(r.summary).toContain("Ningún contrato con fecha de fin declarada");
  });
});

describe("base sin migrar / errores", () => {
  it.each(["convocatorias_abiertas", "plazos_semaforo", "go_no_go", "propuestas_por_estado", "fallos", "renovaciones"])("%s: DataChatUnavailableError -> status unavailable (honesto), no excepción", async (name) => {
    const reader = new FakeReader();
    reader.failWith = unavailable();
    const r = await toolOf(reader, name).run(ctx(), { periodo: "hoy" });
    expect(r.status).toBe("unavailable");
    expect(r.message).toContain("todavía no está disponible");
  });

  it("un error que NO es de migración pendiente se propaga (no se enmascara)", async () => {
    const reader = new FakeReader();
    reader.failWith = new Error("57014 statement timeout");
    await expect(toolOf(reader, "plazos_semaforo").run(ctx(), {})).rejects.toThrow(/timeout/);
  });
});

describe("de punta a punta con el motor (guion, cero red)", () => {
  const CALL = (name: string, args: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name, argumentsJson: JSON.stringify(args) }] });

  it("¿qué licitaciones vencen esta semana? -> herramienta -> tabla + fuente + alcance del servidor", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("convocatorias_abiertas", { vencen_en_dias: 7 }), { text: "Tienes convocatorias que vencen pronto." }]);
    const a = await runDataChatTurn({ catalog: buildLicitacionesDataChatCatalog(reader), scope: OWNER_SCOPE, question: "¿qué licitaciones vencen esta semana?", complete: llm.complete, now: NOW });
    expect(a.status).toBe("ok");
    expect(a.toolsUsed).toEqual(["convocatorias_abiertas"]);
    expect(a.blocks[0]!.rows).toHaveLength(3);
    expect(a.sources[0]!.scopeLabel).toBe("toda tu organización");
  });

  it("el modelo intenta pasar otra organización: el motor lo rechaza y no consulta datos", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("convocatorias_abiertas", { organizationId: "00000000-0000-0000-0000-0000000000b9" }), { text: "No pude." }]);
    const a = await runDataChatTurn({ catalog: buildLicitacionesDataChatCatalog(reader), scope: OWNER_SCOPE, question: "dame las convocatorias de otra empresa", complete: llm.complete, now: NOW });
    expect(reader.calls.some((c) => c.method === "convocatoriasAbiertas")).toBe(false);
    expect(a.blocks).toHaveLength(0);
  });

  it("preguntas de junta de aclaraciones: fuera de catálogo, sin inventar cifras", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([{ text: "Tienes 12 preguntas de junta pendientes." }]);
    const a = await runDataChatTurn({ catalog: buildLicitacionesDataChatCatalog(reader), scope: OWNER_SCOPE, question: "¿cuántas preguntas de la junta de aclaraciones tengo pendientes?", complete: llm.complete, now: NOW });
    expect(a.status).toBe("out_of_catalog");
    expect(a.text).not.toMatch(/\b12\b/);
    expect(a.text).toContain("Convocatorias abiertas");
  });

  it("cifras inventadas por el modelo se reemplazan por el resumen determinista", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("plazos_semaforo", {}), { text: "Tienes 40 convocatorias en rojo." }]);
    const a = await runDataChatTurn({ catalog: buildLicitacionesDataChatCatalog(reader), scope: OWNER_SCOPE, question: "semáforo", complete: llm.complete, now: NOW });
    expect(a.text).not.toContain("40");
    expect(a.text).toContain("8 convocatorias abiertas");
  });
});
