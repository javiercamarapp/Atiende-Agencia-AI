// PM-C3 -- WhatsApp y voz comparten UNA fuente (`whatsapp/perfil-pm.ts`). El comportamiento de voz es su version compacta (tope de 8000
// caracteres de la migracion 025): estas pruebas atan que la version compacta no pierda ninguna regla, motivo ni dato de la completa, que
// solo nombre herramientas que existen y que el simulador y el seed produzcan el mismo texto base.
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_PROMOS_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { APENDICE_VOZ, COMPORTAMIENTO_VOZ_MAX, comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { instruccionVozPm } from "../src/voz/simulador/prompt-voz.ts";
import { MENSAJES_PREGRABADOS, mensajeSaludoRespaldo } from "../src/voz/llamada/mensajes.ts";
import { evaluarInicioLlamada } from "../src/voz/llamada/inicio.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { dataConP5Aprobado } from "./support/pm-seed-p5.ts";
import type { BranchSummary } from "../src/types.ts";

const SIETE: BranchSummary[] = [
  ["prol-montejo", "Prolongación Montejo"],
  ["fco-montejo", "Francisco de Montejo"],
  ["pensiones", "Pensiones"],
  ["galerias", "Galerías"],
  ["playa", "Playa (Chicxulub)"],
  ["garcia-lavin", "García Lavín (Victory Platz)"],
  ["altabrisa", "Victory Altabrisa"],
].map(([slug, name], i) => ({ propertyId: `p${i}`, slug: slug!, name: name!, address: null }));

const REGISTRO: readonly string[] = AGENT_TOOL_DEFINITIONS.map((t) => t.name);
const TOOL_RE = /\b(?:buscar|cotizar|confirmar|crear|escalar|registrar|consultar|asignar)_[a-z_]+\b/g;
const NO_SON_TOOLS = new Set(["modificacion_platillo", "tiempos_entrega", "pedido_grande", "zona_no_reconocida", "producto_agotado", "falla_sistema", "no_entiende", "cancelacion_modificacion", "reposicion_descuento", "alergia_salud", "zona_ambigua", "cliente_lo_pide"]);

const voz = comportamientoVozPm({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  branches: SIETE,
});
const whatsapp = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SIETE,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("comportamiento de voz = el mismo perfil de WhatsApp en version compacta", () => {
  it("incluye FLUJO y ESCALACION (la voz sembrada antes solo recibia 4 secciones) ademas de trato, reglas, seguridad y datos", () => {
    for (const seccion of ["# VOZ Y TRATO", "# REGLAS DURAS", "# FLUJO DE TOMA DE PEDIDO", "# ESCALACIÓN A HUMANO", "# SEGURIDAD", "# DATOS DEL NEGOCIO"]) expect(voz).toContain(seccion);
    expect(voz).toContain("# LLAMADA (voz)");
  });

  it("cabe en el tope de branch_voice_config.comportamiento incluso con las 7 sucursales, y lanza si se pasara", () => {
    expect(voz.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
    expect(voz.endsWith(APENDICE_VOZ)).toBe(true);
    const larga = [...SIETE, ...SIETE.map((b) => ({ ...b, slug: `${b.slug}-x`, name: `${b.name} con un nombre larguisimo para forzar el tope`.repeat(3) }))];
    expect(() => comportamientoVozPm({ businessName: "X", agentName: "el asistente virtual", deliveryTimeText: "40 min", branches: larga })).toThrow(/maximo/);
  });

  it("cada nombre con forma de herramienta que cita existe en agent-tools/registry.ts (ninguna inventada ni del prompt viejo)", () => {
    const citados = new Set(voz.match(TOOL_RE) ?? []);
    expect(citados.size).toBeGreaterThan(5);
    for (const nombre of citados) expect(NO_SON_TOOLS.has(nombre) || REGISTRO.includes(nombre)).toBe(true);
    for (const viejo of ["asignar_sucursal", "consultar_menu", "crear_comanda", "buscar_ultimo_pedido", "escalar(", "cotizar(", "{{"]) expect(voz).not.toContain(viejo);
  });

  it("tiene las mismas reglas duras H1-H18 que WhatsApp (ninguna se pierde al compactar)", () => {
    for (let n = 1; n <= 18; n++) {
      expect(whatsapp).toContain(`H${n}. `);
      expect(voz).toContain(`H${n}. `);
    }
  });

  it("H7 de voz conserva la regla de tarjeta: no pedir, no repetir y decir que no la necesita si la dicta", () => {
    expect(voz).toMatch(/H7\. Nunca pida ni repita datos de tarjeta[^\n]*Si el cliente los dicta, diga que no los necesita/);
  });

  it("tiene los mismos motivos de escalacion y los mismos nombres de herramienta del flujo que WhatsApp", () => {
    const motivosWa = /con estos motivos: ([^\n]+)\./.exec(whatsapp)![1]!.split(", ").map((m) => m.split(" ")[0]!);
    expect(motivosWa.length).toBeGreaterThanOrEqual(15);
    for (const m of motivosWa) expect(voz).toContain(m);
    for (const tool of ["buscar_cliente", "buscar_sucursal_cercana", "buscar_producto", "cotizar_pedido", "confirmar_resumen", "crear_pedido", "escalar_a_humano", "consultar_sucursal"]) {
      expect(REGISTRO).toContain(tool);
      expect(voz).toContain(tool);
    }
  });

  it("conserva lo que PM-C3 pide en voz: H2/H8 sin aflojar, combo del martes, horario solo de los datos, hora_recogida y el umbral de pedido grande", () => {
    expect(voz).toContain("puede adquirirlo directamente en la sucursal al recoger");
    expect(voz).toMatch(/H8\. Escale.*alergias/);
    // CR09: el combo del martes esta cargado: la voz dice que lo aplica cotizar_pedido y ya no que lo confirma la sucursal.
    expect(voz).toContain("H13. Combo del martes (nachos de pastor + 2 aguas, recoger): lo aplica cotizar_pedido; diga lo que devuelve.");
    expect(voz).not.toContain("la confirma la sucursal al recoger");
    expect(voz).not.toMatch(/6 pm a (12|1) am|HORARIO PARA TOMAR PEDIDOS/);
    expect(voz).toMatch(/H16\. Horario: solo lo dicen los datos de la sucursal/);
    expect(voz).toContain("hora_recogida");
    expect(voz).toMatch(/Pedido grande \(más de \$4,000 o más de 5 kg; más de \$2,500 si el número no tiene historial y paga en efectivo\)/);
    expect(voz).toContain(PM_PROMOS_POR_OMISION);
    // La voz es compacta (tope de 8000 caracteres): no lista las salsas, dice cuales van siempre y cuales solo si las piden.
    expect(voz).toContain("las salsas incluidas (las básicas siempre; las demás, solo si el cliente las pide) van sin costo");
    expect(voz).not.toContain("Precios iguales");
    expect(voz).toMatch(/Sucursal.*\[prol-montejo\]/);
  });

  it("la voz no tiene reloj: manda a consultar_sucursal en vez de afirmar una hora fija", () => {
    expect(voz).toContain("consultar_sucursal dice si está abierta ahora");
    expect(voz).not.toMatch(/Buenas tardes|buenas tardes, gracias/);
  });
});

describe("simulador de voz (prueba ciega) usa el mismo perfil", () => {
  const branches = [SIETE[1]!, SIETE[0]!];

  it("la sucursal de contexto es la MARCADA, no branches[0]", () => {
    const i = instruccionVozPm(branches, "lunes 18:30", "lunes", "prol-montejo");
    expect(i).toContain('Llamada a "Prolongación Montejo" (branch_slug "prol-montejo")');
    expect(i).not.toContain('Llamada a "Francisco de Montejo"');
    // Sin sucursal marcada la llamada no pertenece a ninguna (antes tomaba la primera de la lista).
    expect(instruccionVozPm(branches, "lunes 18:30", "lunes")).not.toContain("Llamada a \"");
  });

  it("una sucursal marcada que no existe lanza (simular otra en silencio falsearia la prueba)", () => {
    expect(() => instruccionVozPm(branches, "lunes 18:30", "lunes", "no-existe")).toThrow(/no esta en la lista/);
  });

  it("saluda segun la hora de la prueba y termina con el apendice de la llamada", () => {
    expect(instruccionVozPm(branches, "lunes 09:00", "lunes", "fco-montejo")).toContain('("Buenos días, gracias por llamar a Los Taquitos de PM")');
    expect(instruccionVozPm(branches, "lunes 18:30", "lunes", "fco-montejo")).toContain('("Buenas tardes, gracias por llamar a Los Taquitos de PM")');
    expect(instruccionVozPm(branches, "lunes 23:10", "lunes", "fco-montejo")).toContain('("Buenas noches, gracias por llamar a Los Taquitos de PM")');
    expect(instruccionVozPm(branches, "lunes 18:30", "lunes", "fco-montejo").endsWith(APENDICE_VOZ)).toBe(true);
  });
});

describe("seed: el comportamiento sembrado sale del perfil, no de un archivo aparte", () => {
  const { data, agent } = loadSeedInputs();

  it("coincide con comportamientoVozPm de las sucursales activas y de los textos del agente de WhatsApp del seed", () => {
    const plan = buildPmSeedPlan(data, agent);
    const esperado = comportamientoVozPm({
      businessName: data.organizacion.nombre,
      agentName: "el asistente virtual",
      deliveryTimeText: data.agente_whatsapp.tiempo_entrega,
      branches: data.sucursales.filter((b) => b.activa).map((b) => ({ propertyId: b.id, slug: b.slug, name: b.nombre, address: null })),
      salsasTexto: data.agente_whatsapp.salsas,
      promosTexto: data.agente_whatsapp.promociones,
      motivosDesactivados: data.agente_whatsapp.motivos_escalacion_apagados,
    });
    expect(plan.voice.comportamiento).toBe(esperado);
  });

  it("con P5 aprobado (5 sucursales activas) sigue cabiendo en 8000 y trae sus slugs", () => {
    const { data: aprobado } = { data: dataConP5Aprobado(data) };
    const plan = buildPmSeedPlan(aprobado, agent);
    expect(plan.voice.comportamiento.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
    for (const slug of ["prol-montejo", "fco-montejo", "pensiones", "garcia-lavin", "altabrisa"]) expect(plan.voice.comportamiento).toContain(`[${slug}]`);
  });

  it("el saludo inicial sembrado no lleva palabra de hora (es un texto fijo: decir 'buenas tardes' a toda hora era X40)", () => {
    const plan = buildPmSeedPlan(data, agent);
    for (const g of plan.voice.greetings) expect(g.mensajeInicial).not.toMatch(/buen(os|as) (d[ií]as|tardes|noches)/i);
  });
});

describe("pregrabado de saludo de respaldo segun la hora (X40)", () => {
  it("el id sigue la franja de Merida y cada texto dice su franja; el de reserva no dice ninguna", () => {
    expect(mensajeSaludoRespaldo("11:59")).toBe("saludo_respaldo_dias");
    expect(mensajeSaludoRespaldo("12:00")).toBe("saludo_respaldo_tardes");
    expect(mensajeSaludoRespaldo(19)).toBe("saludo_respaldo_tardes");
    expect(mensajeSaludoRespaldo("19:59")).toBe("saludo_respaldo_tardes");
    expect(mensajeSaludoRespaldo("20:00")).toBe("saludo_respaldo_noches");
    expect(mensajeSaludoRespaldo("00:30")).toBe("saludo_respaldo_noches");
    expect(MENSAJES_PREGRABADOS.saludo_respaldo_dias).toMatch(/^Buenos días/);
    expect(MENSAJES_PREGRABADOS.saludo_respaldo_tardes).toMatch(/^Buenas tardes/);
    expect(MENSAJES_PREGRABADOS.saludo_respaldo_noches).toMatch(/^Buenas noches/);
    expect(MENSAJES_PREGRABADOS.saludo_respaldo).not.toMatch(/buen(os|as)/i);
  });

  it("la llamada a una sucursal con voz deshabilitada dice el saludo de la hora; sin hora, el de reserva", () => {
    const base = { habilitado: false, gastoMesMicroUsd: 0, topeMensualMicroUsd: null } as const;
    expect(evaluarInicioLlamada({ ...base, horaLocal: "21:15" })).toMatchObject({ ok: false, mensaje: "saludo_respaldo_noches" });
    expect(evaluarInicioLlamada({ ...base, horaLocal: 10 })).toMatchObject({ ok: false, mensaje: "saludo_respaldo_dias" });
    expect(evaluarInicioLlamada(base)).toMatchObject({ ok: false, mensaje: "saludo_respaldo" });
  });
});
