// QA-PM-R2: reglas de conversacion que el prompt debe llevar (recogida inmediata, hora relativa, kilos, promo una vez, telefono, estado del pedido, insulto, combo
// del martes) y el reloj local de la sucursal que consultar_sucursal entrega al modelo (la voz no trae la hora en su prompt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { bloqueReglasVozPm } from "../src/voz/perfil-voz-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const prompt = () =>
  buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: [{ propertyId: "p7", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null }],
    entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
    customer: { isNew: true },
    fechaHoraLocal: "6 de octubre de 2026, 13:00",
    diaSemana: "martes",
  });

describe("prompt de WhatsApp: reglas nuevas de la ronda 2", () => {
  const p = prompt();
  it("whatsapp-07: 'en cuanto este' es recogida inmediata (sin hora) y programado_para nunca va vacio ni para 'en 20 minutos'", () => {
    expect(p).toMatch(/"en cuanto esté", "ahorita", "lo antes posible" o "ya", es recogida inmediata: NO mande hora_recogida ni programado_para/);
    expect(p).toMatch(/Nunca mande programado_para vacío ni para "en 20 minutos"/);
    expect(p).toMatch(/tanto en cotizar_pedido como en crear_pedido \(la MISMA\)/);
  });
  it("whatsapp-10: la promo sugerida se ofrece una vez ANTES del resumen, nunca en el turno del si", () => {
    expect(p).toMatch(/promociones_sugeridas, ofrézcalas UNA sola vez, ANTES del resumen; nunca después del "no, es todo" ni en el turno del "sí"/);
  });
  it("whatsapp-16: no repite el numero ya dado y pide como maximo dos datos por mensaje", () => {
    expect(p).toMatch(/"es este mismo" o "mi número es este", no vuelva a preguntarlo/);
    expect(p).toMatch(/como máximo DOS datos por mensaje/);
  });
  it("R2W28: si a la pregunta del numero del chat contesta otra cosa, se da por bueno el numero y no se repregunta", () => {
    expect(p).toMatch(/contesta otra cosa, como "no, es todo" o "sí" sin referirse al número, dé por bueno el número de este chat/);
  });
  it("VX13: tras una llamada cortada, un pedido_reciente con lo mismo ya esta registrado y no se crea otro (bloque de voz)", () => {
    expect(bloqueReglasVozPm()).toMatch(/LLAMADA CORTADA: .*pedido_reciente .*YA está registrado: dígaselo y NO cree otro/);
  });
  it("reglas-07: 2 kilos es UN renglon de 2 kg con requested_quantity 1", () => {
    expect(p).toMatch(/"2 kilos" es UN renglón del producto de 2 kg con requested_quantity 1/);
  });
  it("reglas-06: con media orden de nachos no hay aguas de cortesia", () => {
    expect(p).toMatch(/con MEDIA orden de nachos NO hay aguas de cortesía/);
  });
  it("voz-10: un insulto no es queja de pedido", () => {
    expect(p).toMatch(/Un insulto contra usted .* no es queja de pedido ni pide persona/);
  });
});

describe("bloque de reglas vivas de la VOZ (no borrable)", () => {
  const b = bloqueReglasVozPm();
  it("lleva el reloj local, el telefono una sola vez, el resumen completo, los kilos, el estado del pedido, el insulto y el combo", () => {
    expect(b).toMatch(/hora_local, fecha_local, dia_semana/);
    expect(b).toMatch(/nunca la hora UTC/);
    expect(b).toMatch(/confirme UNA sola vez el número de la llamada, sin pedirle que lo dicte/);
    expect(b).toMatch(/diga el pedido completo con el total de cotizar_pedido; si se corta/);
    expect(b).toMatch(/"2 kilos" es UN renglón del producto de 2 kg/);
    expect(b).toMatch(/llame buscar_cliente \(trae pedido_reciente\)/);
    expect(b).toMatch(/Un insulto contra usted no es una queja de pedido/);
    expect(b).toMatch(/con media orden no hay aguas de cortesía/);
  });
});

describe("consultar_sucursal entrega el reloj LOCAL de la sucursal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T01:30:00Z")); // martes 6 de octubre 19:30 en Merida (UTC-6): en UTC ya es miercoles
  });
  afterEach(() => vi.useRealTimers());

  it("hora_local, fecha_local y dia_semana salen de la zona de la sucursal, no de UTC (VX01: la hora de recogida quedaba 6 h tarde)", async () => {
    const f = buildRestaurantFixture();
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    const r = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "voz", phone: "9991234567" }, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(r.result).toMatchObject({ hora_local: "19:30", fecha_local: "2026-10-06", dia_semana: "martes", zona_horaria: "America/Merida", utc_offset: "GMT-06:00" });
  });
});
