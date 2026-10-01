import { describe, expect, it } from "vitest";
import { formatCell, runDataChatTurn, scriptedCompletion, toJsonSchema, type DataChatTool, type DataChatToolContext, type ScriptStep } from "@atiende/agent-core/data-chat";
import { buildDespachosDataChatCatalog, buildDespachosDataChatTools, resolveClientSelection } from "../../src/data-chat/index.ts";
import { ADMIN_SCOPE, ALL_CLIENTS, CLIENT_ABARROTES, CLIENT_CLINICA, CLIENT_TALLER, CONTADOR_TALLER_SCOPE, FakeReader, NOW, ORG_A, unavailable } from "./support.ts";

function ctx(scope = ADMIN_SCOPE, now = NOW): DataChatToolContext {
  return { scope, now, signal: new AbortController().signal, maxRows: 50 };
}

function toolOf(reader: FakeReader, name: string): DataChatTool {
  return buildDespachosDataChatTools(reader).find((t) => t.name === name)!;
}

describe("catálogo de despachos — cerrado y sin escape", () => {
  const tools = buildDespachosDataChatTools(new FakeReader());

  it("expone exactamente las 8 herramientas del catálogo", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "cartera_por_cliente",
      "cobranza_antiguedad",
      "cfdi_por_periodo",
      "impuestos_del_mes",
      "obligaciones_fiscales",
      "cierres_pendientes",
      "alertas_efos",
      "carga_de_trabajo",
    ]);
  });

  it("ninguna herramienta acepta organización, cliente por id, rol, RFC, SQL ni identificadores crudos", () => {
    const forbidden = /org|tenant|property|propiedad|role|rol|sql|query|user|usuario|rfc|id$/i;
    for (const t of tools) {
      for (const key of Object.keys(t.params)) expect(key, `${t.name}.${key}`).not.toMatch(forbidden);
      expect(toJsonSchema(t.params)).toMatchObject({ additionalProperties: false });
    }
  });

  it("las herramientas con periodo exponen solo periodo/desde/hasta/cliente; las demás solo cliente", () => {
    const keys = (n: string) => Object.keys(tools.find((t) => t.name === n)!.params).sort();
    for (const n of ["cfdi_por_periodo", "impuestos_del_mes", "obligaciones_fiscales"]) expect(keys(n)).toEqual(["cliente", "desde", "hasta", "periodo"]);
    for (const n of ["cartera_por_cliente", "cobranza_antiguedad", "cierres_pendientes", "alertas_efos", "carga_de_trabajo"]) expect(keys(n)).toEqual(["cliente"]);
  });

  it("toda herramienta declara una fuente con terminología MX (CFDI/SAT/cobranza) y la descripción no promete lo que el modelo no tiene", () => {
    const desc = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    expect(desc["impuestos_del_mes"]).toMatch(/NO calcula IVA trasladado/);
    expect(desc["carga_de_trabajo"]).toMatch(/NO existe carga por contador/);
    expect(desc["alertas_efos"]).toMatch(/69-B del SAT/);
    expect(desc["cfdi_por_periodo"]).toMatch(/No incluye CFDI emitidos/);
  });
});

describe("fechas y zona horaria (America/Merida)", () => {
  it("'hoy' a las 23:30 de Mérida es 29-sep aunque en UTC ya sea 30-sep", async () => {
    const reader = new FakeReader();
    await toolOf(reader, "cartera_por_cliente").run(ctx(), {});
    const w = reader.calls.find((c) => c.method === "carteraPorCliente")!.window!;
    expect(w.hoy).toBe("2026-09-29");
    expect(w.limit).toBe(51);
    expect(w.organizationId).toBe(ORG_A);
    expect(w.propertyIds).toBeNull();
  });

  it("este_mes -> del 1 al día de hoy local; mes_pasado -> agosto completo", async () => {
    const reader = new FakeReader();
    await toolOf(reader, "cfdi_por_periodo").run(ctx(), { periodo: "este_mes" });
    await toolOf(reader, "cfdi_por_periodo").run(ctx(), { periodo: "mes_pasado" });
    const ws = reader.calls.filter((c) => c.method === "cfdiPorPeriodo").map((c) => c.window!);
    expect([ws[0]!.fromDate, ws[0]!.toDate]).toEqual(["2026-09-01", "2026-09-29"]);
    expect([ws[1]!.fromDate, ws[1]!.toDate]).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("respeta la zona del alcance (Ciudad de México vs. UTC al filo de la medianoche)", async () => {
    const reader = new FakeReader();
    const now = new Date("2026-10-01T05:30:00.000Z"); // 30-sep 23:30 en Mérida/CDMX, 1-oct en UTC
    await toolOf(reader, "obligaciones_fiscales").run(ctx({ ...ADMIN_SCOPE, timezone: "America/Mexico_City" }, now), { periodo: "hoy" });
    expect(reader.calls.find((c) => c.method === "obligacionesFiscales")!.window).toMatchObject({ fromDate: "2026-09-30", toDate: "2026-09-30", hoy: "2026-09-30" });
  });

  it("periodo ambiguo: pide aclaración y NO consulta datos", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "impuestos_del_mes").run(ctx(), {});
    expect(r.status).toBe("needs_clarification");
    expect(reader.calls.some((c) => c.method === "ivaAcreditable")).toBe(false);
  });

  it("fechas inválidas o invertidas no llegan al lector", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "cfdi_por_periodo").run(ctx(), { desde: "2026-09-10", hasta: "2026-09-01" });
    expect(r.status).toBe("error");
    expect(reader.calls.some((c) => c.method === "cfdiPorPeriodo")).toBe(false);
  });
});

describe("cartera y cobranza (MXN)", () => {
  it("cartera_por_cliente: montos redondeados a centavos y resumen con los totales de las filas", async () => {
    const r = await toolOf(new FakeReader(), "cartera_por_cliente").run(ctx(), {});
    expect(r.status).toBe("ok");
    expect(r.scopeLabel).toBe("todos tus clientes");
    expect(r.rows[0]).toMatchObject({ cliente: "Abarrotes La Esquina SA de CV", cuentas: 4, pendiente: 120000.5, vencidas: 2, vencido: 45000.25 });
    expect(r.summary).toBe("Cartera pendiente a hoy (2026-09-29): $128,000.50 MXN, de los cuales $45,000.25 MXN están vencidos (todos tus clientes).");
    expect(r.columns.find((c) => c.key === "pendiente")!.kind).toBe("mxn");
    expect(formatCell("mxn", 128000.5)).toContain("128,000.50");
  });

  it("sin cartera pendiente: status empty, nunca un 0 inventado", async () => {
    const reader = new FakeReader();
    reader.cartera = [];
    const r = await toolOf(reader, "cartera_por_cliente").run(ctx(), {});
    expect(r.status).toBe("empty");
    expect(r.summary).toContain("Sin cuentas por cobrar pendientes");
  });

  it("cobranza_antiguedad: buckets de antigüedad y cuentas/monto vencidos (excluye lo vigente)", async () => {
    const r = await toolOf(new FakeReader(), "cobranza_antiguedad").run(ctx(), {});
    expect(r.rows.map((x) => x["antiguedad"])).toEqual(["Vigente (aún no vence)", "1 a 30 días vencida", "Más de 90 días vencida"]);
    expect(r.summary).toBe("Cobranza vencida a hoy (2026-09-29): 2 cuentas por $45,000.25 MXN (todos tus clientes).");
  });

  it("la fuente aclara que el monto es el total del CFDI (el modelo no guarda pagos parciales)", async () => {
    const r = await toolOf(new FakeReader(), "cobranza_antiguedad").run(ctx(), {});
    expect(r.source).toContain("monto = total del CFDI");
  });
});

describe("CFDI e impuestos (SAT)", () => {
  it("cfdi_por_periodo traduce tipos de comprobante y declara que no hay CFDI emitidos", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "cfdi_por_periodo").run(ctx(), { periodo: "este_mes" });
    expect(r.rows[0]).toMatchObject({ tipo: "Ingreso (I)", cfdi: 40, total: 250000.1, invalidos: 3, revision: 2 });
    expect(r.rows[1]).toMatchObject({ tipo: "Nómina (N)" });
    expect(r.source).toContain("no guarda los CFDI emitidos");
    expect(r.periodLabel).toContain("este mes");
    expect(r.summary).toBe("CFDI ingeridos en este mes (1 sep al 29 sep 2026): 52, 3 con hallazgos de validación y 2 en revisión (todos tus clientes).");
  });

  it("impuestos_del_mes: IVA acreditable, sin afirmar IVA trasladado ni saldo", async () => {
    const r = await toolOf(new FakeReader(), "impuestos_del_mes").run(ctx(), { periodo: "mes_pasado" });
    expect(r.rows[0]).toMatchObject({ cliente: "Abarrotes La Esquina SA de CV", cfdi: 30, iva: 32000 });
    expect(r.summary).toContain("$40,000.02 MXN");
    expect(r.summary).toContain("No incluye IVA trasladado ni saldo a cargo");
    expect(r.source).toContain("acreditable");
  });

  it("obligaciones_fiscales: estados en español, vencidas contadas aparte", async () => {
    const r = await toolOf(new FakeReader(), "obligaciones_fiscales").run(ctx(), { desde: "2026-09-01", hasta: "2026-10-31" });
    expect(r.rows.map((x) => x["estado"])).toEqual(["Pendiente", "Vencido", "Completado"]);
    expect(r.summary).toContain("3");
    expect(r.summary).toContain("2 sin completar (1 vencidas)");
  });

  it("cierres_pendientes: periodo con nombre de mes y estado en español", async () => {
    const r = await toolOf(new FakeReader(), "cierres_pendientes").run(ctx(), {});
    expect(r.rows[0]).toMatchObject({ periodo: "agosto 2026", estado: "Vencido", pendientes: 4, vencidas: 3, total: 10 });
    expect(r.summary).toContain("13 tareas pendientes");
  });
});

describe("alertas EFOS 69-B (#233)", () => {
  it("lista cargada con alertas: RFC/emisor/situación/CFDI/total; definitivos primero", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "alertas_efos").run(ctx(), {});
    expect(r.status).toBe("ok");
    expect(r.rows[0]).toMatchObject({ rfc: "AAA010101AAA", situacion: "Definitivo", cfdi: 3, total: 58000.5 });
    expect(r.rows[1]).toMatchObject({ situacion: "Presunto", emisor: "—" });
    expect(r.periodLabel).toBe("lista 69-B edición 2026-09");
    expect(reader.calls.find((c) => c.method === "efosAlertas")!.extra).toEqual([CLIENT_ABARROTES, CLIENT_TALLER, CLIENT_CLINICA]);
  });

  it("lista cargada sin alertas: empty con mensaje de 'ningún emisor' (no confunde con lista ausente)", async () => {
    const reader = new FakeReader();
    reader.efos = { estado: "disponible", periodoLista: "2026-09", truncado: false, alertas: [] };
    const r = await toolOf(reader, "alertas_efos").run(ctx(), {});
    expect(r.status).toBe("empty");
    expect(r.summary).toContain("Ningún CFDI ingerido tiene emisor presunto o definitivo");
  });

  it("lista NO cargada: 'unavailable' y nunca 'sin riesgo'", async () => {
    const reader = new FakeReader();
    reader.efos = { estado: "no_disponible", periodoLista: null, truncado: false, alertas: [] };
    const r = await toolOf(reader, "alertas_efos").run(ctx(), {});
    expect(r.status).toBe("unavailable");
    expect(r.message).toContain("no puedo descartar riesgo");
    expect(r.rows).toEqual([]);
  });

  it("más clientes que el tope de revisión: avisa que no se revisaron todos", async () => {
    const reader = new FakeReader();
    reader.efos = { ...reader.efos, truncado: true };
    const r = await toolOf(reader, "alertas_efos").run(ctx(), {});
    expect(r.summary).toContain("Solo se revisaron los primeros clientes");
  });

  it("un contador solo manda al lector los clientes de su alcance", async () => {
    const reader = new FakeReader();
    await toolOf(reader, "alertas_efos").run(ctx(CONTADOR_TALLER_SCOPE), {});
    expect(reader.calls.find((c) => c.method === "efosAlertas")!.extra).toEqual([CLIENT_TALLER]);
  });
});

describe("carga de trabajo (por cliente, no por contador)", () => {
  it("suma pendientes accionables y lo aclara en el resumen", async () => {
    const r = await toolOf(new FakeReader(), "carga_de_trabajo").run(ctx(), {});
    expect(r.rows[0]).toMatchObject({ cliente: "Abarrotes La Esquina SA de CV", revisiones: 5, vencimientos: 3, vencidos: 1, cierre: 4 });
    expect(r.summary).toContain("22 entre revisiones, vencimientos abiertos y tareas de cierre");
    expect(r.summary).toContain("por cliente, no por contador");
    expect(r.source).toContain("no registra un contador responsable");
  });
});

describe("alcance por cliente (cross-cliente)", () => {
  it("un contador con un solo cliente: los ids permitidos llegan al lector y a listVisibleClients", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "cartera_por_cliente").run(ctx(CONTADOR_TALLER_SCOPE), {});
    expect(reader.calls.find((c) => c.method === "carteraPorCliente")!.window!.propertyIds).toEqual([CLIENT_TALLER]);
    expect(reader.calls.find((c) => c.method === "listVisibleClients")!.extra).toMatchObject({ propertyIds: [CLIENT_TALLER] });
    expect(r.scopeLabel).toBe("cliente Taller Mecánico Peninsular");
  });

  it("pedir un cliente ajeno por nombre se trata como inexistente: no consulta y no revela que existe", async () => {
    const reader = new FakeReader();
    const r = await toolOf(reader, "cartera_por_cliente").run(ctx(CONTADOR_TALLER_SCOPE), { cliente: "Clínica Dental" });
    expect(r.status).toBe("needs_clarification");
    expect(r.message).toBe("No encontré ese cliente entre los que puedes consultar: Taller Mecánico Peninsular.");
    expect(r.message).not.toContain("Clínica");
    expect(reader.calls.some((c) => c.method === "carteraPorCliente")).toBe(false);
  });

  it("el dueño elige un cliente por nombre parcial, sin acentos ni mayúsculas -> solo ese", async () => {
    const reader = new FakeReader();
    await toolOf(reader, "carga_de_trabajo").run(ctx(), { cliente: "clinica dental merida" });
    expect(reader.calls.find((c) => c.method === "cargaDeTrabajo")!.window!.propertyIds).toEqual([CLIENT_CLINICA]);
  });

  it("nombre ambiguo pide aclaración con las opciones", () => {
    const r = resolveClientSelection([...ALL_CLIENTS, { propertyId: "x", name: "Taller Mecánico del Norte" }], null, "taller");
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain("Taller Mecánico Peninsular, Taller Mecánico del Norte");
  });

  it("membresía con varios clientes: etiqueta y ids = su lista", async () => {
    const reader = new FakeReader();
    const scope = { ...ADMIN_SCOPE, allowedPropertyIds: [CLIENT_ABARROTES, CLIENT_TALLER] };
    const r = await toolOf(reader, "cierres_pendientes").run(ctx(scope), {});
    expect(reader.calls.find((c) => c.method === "cierresPendientes")!.window!.propertyIds).toEqual([CLIENT_ABARROTES, CLIENT_TALLER]);
    expect(r.scopeLabel).toBe("tus 2 clientes asignados");
  });

  it("membresía acotada a clientes que ya no están activos: el filtro sigue siendo la lista (nunca null)", async () => {
    const reader = new FakeReader();
    const gone = "00000000-0000-0000-0000-00000000ffff";
    await toolOf(reader, "cartera_por_cliente").run(ctx({ ...ADMIN_SCOPE, allowedPropertyIds: [gone] }), {});
    expect(reader.calls.find((c) => c.method === "carteraPorCliente")!.window!.propertyIds).toEqual([gone]);
  });
});

describe("base sin migrar / errores", () => {
  it.each(["cartera_por_cliente", "cobranza_antiguedad", "cfdi_por_periodo", "impuestos_del_mes", "obligaciones_fiscales", "cierres_pendientes", "alertas_efos", "carga_de_trabajo"])(
    "%s: DataChatUnavailableError -> status unavailable (honesto), no excepción",
    async (name) => {
      const reader = new FakeReader();
      reader.failWith = unavailable();
      const r = await toolOf(reader, name).run(ctx(), { periodo: "hoy" });
      expect(r.status).toBe("unavailable");
      expect(r.message).toContain("todavía no está disponible");
    },
  );

  it("un error que NO es de migración pendiente se propaga (no se enmascara)", async () => {
    const reader = new FakeReader();
    reader.failWith = new Error("57014 statement timeout");
    await expect(toolOf(reader, "cartera_por_cliente").run(ctx(), {})).rejects.toThrow(/timeout/);
  });
});

describe("de punta a punta con el motor (guion, cero red)", () => {
  const CALL = (name: string, args: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name, argumentsJson: JSON.stringify(args) }] });

  it("pregunta de cobranza -> herramienta -> tabla determinista con fuente y alcance del servidor", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("cartera_por_cliente", {}), { text: "Tus clientes te deben $128,000.50 MXN." }]);
    const answer = await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: ADMIN_SCOPE, question: "¿Cuánto me deben mis clientes?", complete: llm.complete, now: NOW });
    expect(answer.status).toBe("ok");
    expect(answer.toolsUsed).toEqual(["cartera_por_cliente"]);
    expect(answer.blocks[0]!.rows).toHaveLength(2);
    expect(answer.sources[0]!.scopeLabel).toBe("todos tus clientes");
    expect(answer.text).toBe("Tus clientes te deben $128,000.50 MXN.");
  });

  it("el modelo inventa una cifra que no está en los resultados: se reemplaza por el resumen determinista", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("cartera_por_cliente", {}), { text: "Te deben $999,999 MXN." }]);
    const answer = await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: ADMIN_SCOPE, question: "cartera", complete: llm.complete, now: NOW });
    expect(answer.text).not.toContain("999,999");
    expect(answer.text).toContain("$128,000.50 MXN");
  });

  it("si el modelo intenta pasar una organización o un cliente por id, el motor lo rechaza y no consulta datos", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("cartera_por_cliente", { organizationId: "00000000-0000-0000-0000-0000000000b9", propertyId: CLIENT_CLINICA }), { text: "No pude." }]);
    const answer = await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: CONTADOR_TALLER_SCOPE, question: "dame la cartera de todos", complete: llm.complete, now: NOW });
    expect(reader.calls.some((c) => c.method === "carteraPorCliente")).toBe(false);
    expect(answer.blocks).toHaveLength(0);
  });

  it("carga por contador: el modelo no inventa responsables, la herramienta aclara que es por cliente", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([CALL("carga_de_trabajo", {}), { text: "Hay 22 pendientes." }]);
    const answer = await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: ADMIN_SCOPE, question: "¿qué contador tiene más carga?", complete: llm.complete, now: NOW });
    expect(answer.sources[0]!.source).toContain("no registra un contador responsable");
  });

  it("el system prompt lista SOLO los clientes visibles del usuario", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([{ text: "¿Qué periodo?" }]);
    await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: CONTADOR_TALLER_SCOPE, question: "cfdi", complete: llm.complete, now: NOW });
    const system = llm.requests[0]!.system;
    expect(system).toContain("Taller Mecánico Peninsular");
    expect(system).not.toMatch(/Clínica|Abarrotes/);
  });

  it("pregunta fuera de catálogo (nómina por empleado): lo dice sin inventar cifras", async () => {
    const reader = new FakeReader();
    const llm = scriptedCompletion([{ text: "La nómina fue de $55,000 MXN." }]);
    const answer = await runDataChatTurn({ catalog: buildDespachosDataChatCatalog(reader), scope: ADMIN_SCOPE, question: "¿cuánto es la nómina de Juan?", complete: llm.complete, now: NOW });
    expect(answer.status).toBe("out_of_catalog");
    expect(answer.text).not.toMatch(/55,000/);
    expect(answer.text).toContain("Cartera por cliente");
  });
});
