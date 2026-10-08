// Ronda 5 del loop de PM: los escenarios de regresion (parafraseados y anonimizados) tienen estructura valida, ningun dato personal (el repo es publico) y cada
// uno apunta a una prueba determinista que EXISTE en el repo. Ademas ata las reglas de prompt (WhatsApp y voz) que no se pueden probar sin modelo.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cargarEscenariosR5 } from "../src/evals/agente-pm/escenarios-r5.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";
import { REGLAS_VIVAS_VOZ, comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { MENSAJE_ESCALACION_VOZ, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const suite = cargarEscenariosR5();
const RAIZ_PAQUETE = new URL("../", import.meta.url);
const RAIZ_REPO = new URL("../../../", import.meta.url);

describe("escenarios de la ronda 5: estructura", () => {
  it("ids R5-NNN consecutivos, defecto QA-PM-R5-*, textos no vacios", () => {
    expect(suite.escenarios.map((e) => e.id)).toEqual(Array.from({ length: suite.escenarios.length }, (_, i) => `R5-${String(i + 1).padStart(3, "0")}`));
    expect(suite.escenarios.length).toBeGreaterThanOrEqual(30);
    for (const e of suite.escenarios) {
      expect(e.defecto, e.id).toMatch(/^QA-PM-R5-(?:whatsapp|voz|reglas)-[\w-]+$/);
      expect(["chat", "llamada", "ambos"]).toContain(e.canal);
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
    }
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(suite.escenarios.length);
  });

  it("cubre cada defecto P0 y P1 de la ronda 5", () => {
    const defectos = new Set(suite.escenarios.map((e) => e.defecto));
    for (const d of ["reglas-01", "reglas-02", "reglas-03", "whatsapp-01", "voz-01", "voz-03"]) expect(defectos.has(`QA-PM-R5-${d}`), d).toBe(true);
  });

  it("lo que depende de un dato o una decision esta marcado pendiente_decision y dice de que depende", () => {
    for (const e of suite.escenarios.filter((x) => x.estado === "pendiente_decision")) expect(e.dudas.length, e.id).toBeGreaterThan(0);
    for (const e of suite.escenarios.filter((x) => x.estado === "activo")) expect(e.dudas, e.id).toEqual([]);
  });
});

describe("escenarios de la ronda 5: sin datos personales", () => {
  const texto = (e: (typeof suite.escenarios)[number]) => [...e.turnos_cliente, e.comportamiento_esperado, e.que_no_debe_hacer, e.intencion].join("\n");
  const PATRONES: ReadonlyArray<readonly [string, RegExp]> = [
    ["telefono", /(?:\+?\d[\s().-]?){7,}/],
    ["correo", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["enlace", /https?:\/\/|www\.|maps\.app|goo\.gl/i],
    ["coordenadas", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
    ["presentacion con nombre propio", /\b(?:me llamo|mi nombre es|soy)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/],
  ];
  it.each(PATRONES)("ningun escenario trae %s", (_n, patron) => {
    expect(suite.escenarios.filter((e) => patron.test(texto(e))).map((e) => e.id)).toEqual([]);
  });
});

describe("escenarios de la ronda 5: cada uno apunta a una prueba que existe", () => {
  it("la ruta de `cubierto_por` existe, o es un guion de voz que existe", () => {
    const faltan: string[] = [];
    const guiones = new Set(GUIONES_ES_MX.map((g) => g.id));
    for (const e of suite.escenarios) {
      if (/^V\d+-/.test(e.cubierto_por)) {
        if (!guiones.has(e.cubierto_por)) faltan.push(`${e.id}: guion ${e.cubierto_por}`);
        continue;
      }
      const rutas = e.cubierto_por.match(/(?:apps|packages|tests)\/[\w./-]+\.spec\.ts/g) ?? [];
      if (rutas.length === 0) faltan.push(`${e.id}: sin ruta`);
      for (const r of rutas) if (!existsSync(new URL(r, RAIZ_PAQUETE)) && !existsSync(new URL(r, RAIZ_REPO))) faltan.push(`${e.id}: ${r}`);
    }
    expect(faltan).toEqual([]);
  });
});

const BRANCHES: BranchSummary[] = [{ propertyId: "p1", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null } as BranchSummary];
const promptWhatsApp = buildPmSystemPrompt({
  businessName: "Los Taquitos de PM",
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: BRANCHES,
  entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
  customer: { isNew: true },
  fechaHoraLocal: "7 de octubre de 2026, 12:00",
  diaSemana: "miércoles",
});

describe("reglas de prompt de WhatsApp de la ronda 5", () => {
  it("precio antes que datos, lo que no esta en el menu, ordenes y media", () => {
    expect(promptWhatsApp).toMatch(/PRECIO ANTES QUE DATOS/);
    expect(promptWhatsApp).toMatch(/pizza no la manejamos/);
    expect(promptWhatsApp).toMatch(/Boyo-Hamburguesa/);
    expect(promptWhatsApp).toMatch(/N órdenes y media" de nachos = N órdenes completas MÁS una media orden/);
  });
  it("corregir el nombre antes de crear no se escala; '¿ya quedo?' tras crear confirma", () => {
    expect(promptWhatsApp).toMatch(/ANTES de crear el pedido, aplíquelo, vuelva a cotizar y repita el resumen/);
    expect(promptWhatsApp).toMatch(/nunca diga que no quedó registrado ni escale sin llamar antes buscar_cliente/);
  });
  it("una sola despedida, hora pedida en el cierre y herramientas agrupadas", () => {
    expect(promptWhatsApp).toMatch(/despídase UNA vez y no vuelva a preguntar/);
    expect(promptWhatsApp).toMatch(/repita ESA hora \(nunca el tiempo genérico de 25 a 35 minutos\)/);
    expect(promptWhatsApp).toMatch(/UNA sola respuesta todas las herramientas independientes/);
  });
  it("negativo: el estado del pedido sigue sin inventarse", () => {
    expect(promptWhatsApp).toMatch(/Nunca invente un estado, una hora ni que el repartidor va en camino/);
  });
});

describe("reglas vivas de voz de la ronda 5", () => {
  it("rellamada sin estado de cocina, hora al cerrar, orden del cierre, pide persona, nunca callar", () => {
    expect(REGLAS_VIVAS_VOZ).toMatch(/NO traen el estado de cocina/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/NUNCA «ya se está preparando»/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/diga ESA hora/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/espere un «sí» NUEVO antes de crear_pedido/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/SIN pedirle antes el nombre/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/nunca se quede callado/);
  });
  it("el comportamiento compacto sembrado sigue cabiendo en el tope", () => {
    const texto = comportamientoVozPm({ businessName: "Los Taquitos de PM", agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches: BRANCHES });
    expect(texto.length).toBeLessThanOrEqual(8000);
  });
  it("escalar_a_humano por voz devuelve la frase para el cliente; por WhatsApp no (negativo)", async () => {
    const f = buildRestaurantFixture();
    const voz = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "voz", phone: "9991234567" }, "escalar_a_humano", { motivo: "cliente_lo_pide", resumen: "pide una persona" });
    expect(voz.result).toMatchObject({ ok: true, mensaje_al_cliente: MENSAJE_ESCALACION_VOZ });
    const wa = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234568" }, "escalar_a_humano", { motivo: "cliente_lo_pide", resumen: "pide una persona" });
    expect(wa.result).toEqual({ ok: true });
  });
});
