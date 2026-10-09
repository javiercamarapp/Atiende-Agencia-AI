// Ronda 5 del loop de PM: los escenarios de regresion (parafraseados y anonimizados) tienen estructura valida, ningun dato personal (el repo es publico) y cada
// uno apunta a una prueba determinista que EXISTE en el repo. Ademas ata las reglas de prompt (WhatsApp y voz) que no se pueden probar sin modelo.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cargarEscenariosR5 } from "../src/evals/agente-pm/escenarios-r5.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";
import { REGLAS_VIVAS_VOZ, comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import * as registro from "../src/agent-tools/registry.ts";
import { AGENT_TOOL_DEFINITIONS, AVISO_SIN_ESTADO_DE_PEDIDO, INSTRUCCION_ESCALACION_VOZ, MENSAJE_ESCALACION_VOZ, invokeAgentTool } from "../src/agent-tools/registry.ts";
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
    expect(REGLAS_VIVAS_VOZ).toMatch(/historial_pedidos NO trae el estado de cocina/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/NUNCA «ya se está preparando» ni «ya salió» sin ese dato/);
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
    expect(voz.result).toMatchObject({ ok: true, mensaje_al_cliente: MENSAJE_ESCALACION_VOZ, instruccion: INSTRUCCION_ESCALACION_VOZ });
    const wa = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234568" }, "escalar_a_humano", { motivo: "cliente_lo_pide", resumen: "pide una persona" });
    expect(wa.result).toEqual({ ok: true });
  });
});

describe("buscar_cliente no deja inventar el estado de cocina (QA-PM-R5-voz-04)", () => {
  const ctxDe = (f: ReturnType<typeof buildRestaurantFixture>) => ({ organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567" });
  const crear = (f: ReturnType<typeof buildRestaurantFixture>) =>
    invokeAgentTool(f.repo, ctxDe(f), "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });

  it("cliente nuevo: sin aviso", async () => {
    const f = buildRestaurantFixture();
    const nuevo = (await invokeAgentTool(f.repo, ctxDe(f), "buscar_cliente", {})).result as Record<string, unknown>;
    expect(nuevo.isNew).toBe(true);
    expect(nuevo.aviso_estado_pedido).toBeUndefined();
  });
  it("cliente con pedido y estado de cocina legible (pedidoReciente): sin aviso", async () => {
    const f = buildRestaurantFixture();
    await crear(f);
    const r = (await invokeAgentTool(f.repo, ctxDe(f), "buscar_cliente", {})).result as Record<string, unknown>;
    expect(r.isNew).toBe(false);
    expect(r.pedidoReciente).toMatchObject({ estado: "preparando" });
    expect(r.aviso_estado_pedido).toBeUndefined();
  });
  it("cliente con pedido y SIN lectura del estado de cocina (pedidoReciente indefinido): el resultado trae el aviso", async () => {
    const f = buildRestaurantFixture();
    await crear(f);
    vi.spyOn(f.repo, "findLatestOrderByPhone").mockResolvedValue(undefined);
    const r = (await invokeAgentTool(f.repo, ctxDe(f), "buscar_cliente", {})).result as Record<string, unknown>;
    expect(r.isNew).toBe(false);
    expect(r.pedidoReciente).toBeUndefined();
    expect(r.aviso_estado_pedido).toBe(AVISO_SIN_ESTADO_DE_PEDIDO);
  });
});

// Todo lo que va en `mensaje_al_cliente` se LEE tal cual al cliente (regla viva de voz: «diga el mensaje_al_cliente que devuelve»): ahi no caben instrucciones para el modelo.
const INSTRUCCION_AL_MODELO = /d[ií]gaselo|d[ií]gale|antes de despedirse|sin prometer|no prometa|no diga|no avise|responda|\bllame\b|\bpregunte\b|\bescale\b|herramienta|el cliente|al cliente/i;
function mensajesAlCliente(valor: unknown, acc: string[] = []): string[] {
  if (Array.isArray(valor)) valor.forEach((v) => mensajesAlCliente(v, acc));
  else if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) {
      if (k === "mensaje_al_cliente" && typeof v === "string") acc.push(v);
      else mensajesAlCliente(v, acc);
    }
  }
  return acc;
}

describe("mensaje_al_cliente no lleva instrucciones al modelo (QA-PM-R5-voz-05)", () => {
  it("barrido: toda constante MENSAJE_* exportada por el registro", () => {
    const constantes = Object.entries(registro).filter(([k, v]) => k.startsWith("MENSAJE_") && typeof v === "string") as Array<[string, string]>;
    expect(constantes.length).toBeGreaterThanOrEqual(3);
    for (const [nombre, texto] of constantes) expect(texto, nombre).not.toMatch(INSTRUCCION_AL_MODELO);
  });
  it("barrido: cada `mensaje_al_cliente:` del registro apunta a una constante exportada (ninguno en linea sin revisar)", () => {
    const fuente = readFileSync(new URL("../src/agent-tools/registry.ts", import.meta.url), "utf8");
    const usos = [...fuente.matchAll(/mensaje_al_cliente:\s*([^,}\s]+)/g)].map((m) => m[1]!);
    expect(usos.length).toBeGreaterThanOrEqual(4);
    // `fijo` es la derivada local de MENSAJE_LLEGADA_REGISTRADA / MENSAJE_PEDIDO_TELEFONICO_REGISTRADO (ya barridas arriba).
    for (const uso of usos.filter((u) => u !== "fijo")) expect(Object.keys(registro), uso).toContain(uso);
  });
  it("barrido: el resultado real de TODAS las herramientas por voz (sin entrada y con las entradas de los avisos)", async () => {
    const f = buildRestaurantFixture();
    const ctx = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567" };
    await invokeAgentTool(f.repo, ctx, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
    const entradas: Array<[string, Record<string, unknown>]> = [
      ["escalar_a_humano", { motivo: "cliente_lo_pide", resumen: "pide una persona" }],
      ["registrar_contacto", { reason: "cliente_llego" }],
      ["registrar_contacto", { reason: "pedido_telefonico", message: "pin de maps" }],
      ["registrar_contacto", { reason: "otro", message: "x", customer_name: "Nora" }],
    ];
    for (const d of AGENT_TOOL_DEFINITIONS) entradas.push([d.name, {}]);
    const vistos: string[] = [];
    for (const [nombre, input] of entradas) {
      const r = await invokeAgentTool(f.repo, ctx, nombre as never, input).catch(() => null);
      if (r) vistos.push(...mensajesAlCliente(r.result));
    }
    expect(vistos).toContain(MENSAJE_ESCALACION_VOZ);
    for (const m of vistos) expect(m).not.toMatch(INSTRUCCION_AL_MODELO);
  });
});
