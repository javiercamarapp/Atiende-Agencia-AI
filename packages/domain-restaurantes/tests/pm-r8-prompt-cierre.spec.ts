// Ronda 8 de medicion (PM, WhatsApp): reglas de cierre del prompt. Estas pruebas fijan la ESTRUCTURA del prompt (presencia de las reglas nuevas y
// ausencia de las contradictorias viejas). No hay modelo real en CI: que el agente CIERRE mejor solo lo mide la ronda con LLM real.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p7", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null }];

function prompt(over: Partial<Parameters<typeof buildPmSystemPrompt>[0]> = {}): string {
  return buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "el asistente virtual",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: SUCURSALES,
    entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
    customer: { isNew: true },
    ...over,
  });
}
const p = prompt();

describe("R8 causa 1: no escalar de más; el 'sí' crea el pedido (H19)", () => {
  it("H19: notas menores van en notes y no motivan escalar", () => {
    expect(p).toMatch(/H19\. NO ESCALE DE MÁS:.*limones, salsa habanera, "frijol extra".*no es motivo para escalar ni para no crear el pedido/);
    expect(p).toMatch(/Con el "sí" y todo cotizado, cree el pedido/);
  });
  it("paso 11: el 'sí' se cierra con crear_pedido, nunca con escalar ni 'falla técnica'", () => {
    expect(p).toMatch(/el siguiente paso es crear_pedido, nunca escalar_a_humano \(salvo pedido grande, paso 8\) ni un mensaje de falla \(H19\)/);
  });
  it("las notas menores sin costo caben en notes (no contradice la regla de seguridad)", () => {
    expect(p).toMatch(/Notes lleva únicamente ajustes permitidos y peticiones menores sin costo \(limones, salsa habanera\)/);
  });
});

describe("R8 causa 6: responder SIEMPRE tras escalar", () => {
  it("cierra el turno con texto y siguiente paso; postventa (queja, cambio, estado) cubierta", () => {
    expect(p).toMatch(/DESPUÉS de escalar responda SIEMPRE: cierre ese turno con texto para el cliente y su siguiente paso; nunca lo deje en silencio/);
    expect(p).toMatch(/Queja o faltante:.*Cancelación o cambio:.*Estado del pedido:/s);
    expect(p).toMatch(/Si el cliente vuelve a escribir, conteste/);
  });
});

describe("R8 causa 8: pasos de cierre", () => {
  it("con cuánto paga se pregunta SIEMPRE en efectivo, antes de repetir el pedido; ya no se dice que no se exige", () => {
    expect(p).not.toMatch(/no exija pin de ubicación, casa o depto, referencias, con cuánto paga/);
    expect(p).toMatch(/Con cuánto paga SÍ se pregunta siempre que el pago sea en efectivo/);
    expect(p).toMatch(/Efectivo: pregunte SIEMPRE con cuánto paga, antes de repetir el pedido/);
    expect(p).not.toMatch(/solo diga con cuánto paga si el cliente ya lo dijo/);
  });
  it("repite el pedido en lista con total antes de crear (G_REPETICION_ANTES_DE_CREAR) y el pin se ofrece una sola vez", () => {
    expect(p).toMatch(/Nunca llame crear_pedido si su mensaje anterior al "sí" no fue esa lista completa con el total\./);
    expect(p).toMatch(/PIN A REPARTO \(ayuda opcional, no requisito\): ofrézcalo UNA SOLA VEZ y ANTES de confirmar/);
  });
});

describe("R8 G1: primer mensaje sin aviso de privacidad largo", () => {
  it("el saludo es una sola frase y el modelo no escribe ni resume el aviso (lo antepone el sistema)", () => {
    expect(p).toMatch(/Saludo CORTO y de usted \(una sola frase; el aviso de privacidad lo antepone el sistema, no lo escriba ni lo resuma/);
    expect(p).toMatch(/lo antepone el sistema una sola vez en el primer mensaje: no lo repita ni lo parafrasee/);
  });
  it("la regla ARCO sigue en el prompt", () => {
    expect(p).toContain('"mis datos personales"');
  });
});

describe("R8 decisión de Javier 1: sucursal cerrada = tomar y PROGRAMAR", () => {
  it("H16 programa con programado_para y avisa que la sucursal confirma al abrir; sin 'no lo deje programado' ni escalar (otro)", () => {
    expect(p).not.toMatch(/no tome el pedido ni lo deje programado/);
    expect(p).not.toMatch(/si insiste, escale \(otro\)/);
    expect(p).toMatch(/TOME el pedido y PROGRÁMELO:.*programado_para, la MISMA en cotizar_pedido y crear_pedido/s);
    expect(p).toMatch(/queda PROGRAMADO y que la sucursal lo confirma al abrir; nunca que ya está en cocina/);
    expect(p).toMatch(/No le pida que vuelva a escribir ni escale por eso/);
  });
  it("paso 8: otro día o antes de abrir se programa, no se escala", () => {
    expect(p).not.toMatch(/Pedido para otro día o para antes de que abra la sucursal: escale/);
    expect(p).toMatch(/Pedido para otro día o para antes de que abra la sucursal: prográmelo con programado_para \(hasta 7 días/);
  });
  it("paso 11: un pedido programado se confirma como PROGRAMADO, no como en cocina", () => {
    expect(p).toMatch(/quedó registrado y PROGRAMADO para \[hora\]; la sucursal lo confirma al abrir/);
  });
  it("la versión de voz comparte la regla (y cabe en el tope de 8000 caracteres)", () => {
    const v = prompt({ canal: "voz" });
    expect(v).not.toMatch(/no programe/);
    expect(v).toMatch(/Cerrada: programe el pedido \(programado_para\)/);
    const cabe = comportamientoVozPm({ businessName: "Los Taquitos de PM", agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches: SUCURSALES });
    expect(cabe.length).toBeLessThanOrEqual(8000);
    expect(cabe).toMatch(/Cerrada: programe el pedido \(programado_para\)/);
  });
});

describe("R8 decisión de Javier 2: el menú va como PDF de la sucursal, no pegado", () => {
  it("WhatsApp: pedir 'el menú' llama enviar_menu con el branch_slug; enlace oficial o registrar_contacto menu_pdf solo como respaldo; dudas puntuales por texto", () => {
    expect(p).toMatch(/MENÚ: si pide "el menú" o "la carta", llame enviar_menu con el branch_slug de la sucursal/);
    expect(p).toMatch(/No lo pegue en texto\./);
    expect(p).toMatch(/enviado "pdf": diga en una frase que ya le mandó el menú en PDF/);
    expect(p).toMatch(/"enlace": comparta ESE enlace tal cual.*nunca otro/s);
    expect(p).toMatch(/"sin_menu" o da error:.*registrar_contacto con reason "menu_pdf"/s);
    expect(p).toMatch(/ofrezca resolver dudas puntuales por texto/);
    expect(p).not.toMatch(/https?:\/\/\S*menu/i); // el prompt nunca trae un enlace de menu inventado: lo da la herramienta
    expect(p).not.toMatch(/hoy no hay herramienta de envío/);
  });
  it("voz: el prompt compacto de llamada no promete ni usa enviar_menu (la herramienta es solo de WhatsApp)", () => {
    expect(prompt({ canal: "voz" })).not.toMatch(/enviar_menu/);
  });
});

describe("R8 causa 9: precios por kilo completos", () => {
  it("al listar kilos incluye TODAS las carnes (arrachera) con el precio de buscar_producto", () => {
    expect(p).toMatch(/liste TODAS esas carnes \(con arrachera\) con el precio de buscar_producto/);
  });
});

describe("R8 revisión: coherencia entre pasos", () => {
  it("voz: el paso 8 programa (otro día o antes de abrir) igual que H16", () => {
    const v = prompt({ canal: "voz" });
    expect(v).toMatch(/Otro día: prográmelo \(programado_para\)/);
    expect(v).not.toMatch(/Otro día: escale/);
  });
  it("H19 y paso 11 exceptúan el pedido grande (paso 8)", () => {
    expect(p).toMatch(/cree el pedido \(salvo pedido grande, paso 8\)/);
    expect(p).toMatch(/nunca escalar_a_humano \(salvo pedido grande, paso 8\)/);
  });
  it("paso 8 y H16: fuera del horario se ofrece programar para otro día o la siguiente apertura", () => {
    expect(p).toMatch(/ofrezca pasar antes o programarlo para otro día \(programado_para\)/);
    expect(p).toMatch(/prográmelo para la siguiente apertura \(programado_para\)/);
  });
  it("menú: el respaldo (sin_menu o error) no garantiza el envío, usa registrar_contacto como los pasos 17 y 18 y da categorías", () => {
    expect(p).toMatch(/la sucursal se lo puede enviar en PDF y que le dejó el aviso \(sin garantizar cuándo\)/);
    expect(p).not.toMatch(/única excepción a escalar|hará llegar el menú/);
    expect(p).toMatch(/registrar_contacto con reason "menu_pdf" \(branch_slug en message; no es escalar\)/);
    expect(p).toMatch(/dé las categorías y 3 o 4 platillos con su precio de buscar_producto/);
    expect(p).toMatch(/Si piden "el menú" \(vea la regla MENÚ\)/);
  });
  it("sin coincidencia exacta se pregunta con opciones; el OBJETIVO exige la lista con el total; la pregunta final ya no menciona el menú", () => {
    expect(p).toMatch(/Un producto sin coincidencia exacta se pregunta con opciones \(paso 5\), no se escala/);
    expect(p).toMatch(/cotice, repita el pedido en lista con el total y pida el sí/);
    expect(p).toMatch(/Si el cliente solo pregunta \(horario, envío, promociones, salsas\), responda/);
    expect(p).not.toMatch(/Si el cliente solo pregunta \([^)]*menú\)/);
  });
  it("tras escalar: 'no se quede callado'", () => {
    expect(p).toMatch(/no se quede callado/);
  });
});

