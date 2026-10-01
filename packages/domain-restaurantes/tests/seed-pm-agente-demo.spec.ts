// R-19/R-20 -- el seed deja el agente de WhatsApp de PM COMPLETO (perfil taqueria_pm con los datos del dueño) y puede
// cargar la cuenta como DEMO. Los pendientes del dueño NO se inventan. Postgres real: scripts/verify-restaurantes-seed-pm/ (E1-E8).
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql, renderSchemaPreflightSql, WHATSAPP_AGENT_LIMITES } from "../src/seed/pm-demo.ts";
import { parseSeedArgs } from "../src/seed/target-safety.ts";
import { aplicarFilaAConfig, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import { prepareCreateOrder } from "../src/orders.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("configuracion del agente de WhatsApp en el seed", () => {
  const plan = buildPmSeedPlan(data, agent);

  it("perfil taqueria_pm, tono formal (usted), tiempos y salsas del dueño; el nombre del asistente NO se inventa", () => {
    expect(plan.whatsappAgent).toMatchObject({
      perfil: "taqueria_pm",
      toneStyle: "formal_directo",
      businessName: "Los Taquitos de PM",
      agentName: null,
      escalationReasonsOff: [],
    });
    expect(plan.whatsappAgent.deliveryTimeText).toMatch(/^de 40 a 50 minutos/);
    expect(plan.whatsappAgent.salsasText).toContain("guacamolera");
  });

  it("las promociones que anuncia el agente son SOLO las cargadas (lunes 2x1 en recoger): nunca promete el combo del martes", () => {
    expect(plan.whatsappAgent.promosText).toMatch(/lunes 2x1/i);
    expect(plan.whatsappAgent.promosText).not.toMatch(/martes|nachos/i);
    expect(plan.promotions.map((p) => p.code)).toEqual(["LUNES2X1PM"]);
    const malo = clone(data);
    (malo.agente_whatsapp as unknown as { promociones: string }).promociones = "lunes 2x1 en pastor; martes nachos con 2 aguas";
    expect(() => buildPmSeedPlan(malo, agent)).toThrow(PmSeedError);
  });

  it("los textos respetan los limites de la tabla (CHECK de las migraciones 029/033) y los motivos solo son los apagables", () => {
    expect(plan.whatsappAgent.deliveryTimeText.length).toBeLessThanOrEqual(WHATSAPP_AGENT_LIMITES.deliveryTimeText);
    expect(plan.whatsappAgent.salsasText.length).toBeLessThanOrEqual(WHATSAPP_AGENT_LIMITES.salsasText);
    expect(plan.whatsappAgent.promosText.length).toBeLessThanOrEqual(WHATSAPP_AGENT_LIMITES.promosText);
    const largo = clone(data);
    (largo.agente_whatsapp as unknown as { salsas: string }).salsas = "x".repeat(WHATSAPP_AGENT_LIMITES.salsasText + 1);
    expect(() => buildPmSeedPlan(largo, agent)).toThrow(/salsasText/);
    const motivo = clone(data);
    (motivo.agente_whatsapp as unknown as { motivos_escalacion_apagados: string[] }).motivos_escalacion_apagados = ["queja"];
    expect(() => buildPmSeedPlan(motivo, agent)).toThrow(/no se puede apagar/);
  });

  it("el prompt que resulta de la config sembrada lleva las reglas duras: alcohol sin domicilio, minimo $200, propina solo con tarjeta, bistec en ordenes de 3, usted", () => {
    const config = aplicarFilaAConfig({
      perfil: plan.whatsappAgent.perfil,
      agentName: plan.whatsappAgent.agentName,
      businessName: plan.whatsappAgent.businessName,
      toneStyle: plan.whatsappAgent.toneStyle as "formal_directo",
      deliveryTimeText: plan.whatsappAgent.deliveryTimeText,
      salsasText: plan.whatsappAgent.salsasText,
      promosText: plan.whatsappAgent.promosText,
      escalationReasonsOff: [],
    });
    const prompt = buildSystemPrompt(config, [{ id: "p1", name: "Victory Altabrisa", slug: "altabrisa", address: null }] as never, { isNew: true }, new Date("2026-10-05T15:00:00Z"), null);
    expect(prompt).toMatch(/Nada de alcohol a domicilio/);
    expect(prompt).toMatch(/\$200/);
    expect(prompt).toMatch(/Propina solo con tarjeta/i);
    expect(prompt).toMatch(/órdenes de 3/);
    expect(prompt).toMatch(/usted/i);
    expect(prompt).toContain("lunes 2x1 en tacos al pastor, solo para recoger");
    expect(prompt).toContain("Los Taquitos de PM");
    expect(prompt).toContain("de 40 a 50 minutos");
  });

  it("la regla de '3 de bistec' queda documentada en los datos para que el guion y la prueba la usen", () => {
    expect(data.agente_whatsapp.reglas_duras.join(" ")).toMatch(/3 de bistec/);
  });

  it("la voz sigue DESHABILITADA en el SQL del seed (sin gasto de proveedores) y la config del agente no pisa la del dueño", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.branch_voice_config[\s\S]*?false, v->'voice'->>'voiceId'/);
    expect(sql).toMatch(/insert into restaurantes\.whatsapp_agent_config[\s\S]*?on conflict \(organization_id\) where property_id is null do nothing/);
  });
});

describe("pendientes del dueño (checklist R-33): visibles y sin inventar", () => {
  const plan = buildPmSeedPlan(data, agent);

  it("estan los cinco datos que faltan mas los que dependen de ellos", () => {
    const ids = plan.pendientes.map((p) => p.id);
    for (const id of ["cambio_turno", "whatsapp_sucursal", "coordenadas_t3", "mapa_colonias", "catalogo_softrestaurant"]) expect(ids).toContain(id);
  });

  it("ningun pendiente trae un valor inventado en los datos: T3 sin coordenadas, sin cobertura, sin numero de WhatsApp, una sola franja", () => {
    expect(plan.branches.find((b) => b.slug === "pensiones")).toMatchObject({ lat: null, lng: null });
    expect(plan.summary.zones).toBe(4);
    expect(JSON.stringify(plan.policy.horario)).not.toMatch(/"abre":"(?!12:00)/);
    expect(plan.pendientes.every((p) => p.detalle.length > 20 && ["dueno", "distribuidor_pos", "plataforma"].includes(p.quien))).toBe(true);
  });

  it("un pendiente duplicado invalida el seed", () => {
    const malo = clone(data);
    (malo as unknown as { pendientes_dueno: unknown[] }).pendientes_dueno = [data.pendientes_dueno[0], data.pendientes_dueno[0]];
    expect(() => buildPmSeedPlan(malo, agent)).toThrow(PmSeedError);
  });
});

describe("carga como demo (--demo)", () => {
  it("la cuenta normal conserva su slug y no se marca; la demo usa slug propio, nombre con (demo) y marca", () => {
    const normal = buildPmSeedPlan(data, agent);
    const demo = buildPmSeedPlan(data, agent, { demo: true });
    expect(normal.organization.slug).toBe("los-taquitos-de-pm");
    expect(normal.demo).toBeNull();
    expect(demo.organization).toMatchObject({ slug: "los-taquitos-de-pm-demo", name: "Los Taquitos de PM (demo)" });
    expect(demo.demo).toEqual({ seedVersion: data.version });
    // Misma configuracion, solo cambia la identidad: la demo no pierde nada del seed real.
    expect(demo.products).toEqual(normal.products);
    expect(demo.whatsappAgent).toEqual(normal.whatsappAgent);
  });

  it("el SQL de la demo marca la organizacion sin reactivar un widget apagado; el de la cuenta normal no escribe la marca", () => {
    const sqlDemo = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent, { demo: true }));
    expect(sqlDemo).toMatch(/insert into restaurantes\.demo_organization \(organization_id, seed_version\)[\s\S]*?do update set seed_version = excluded\.seed_version/);
    expect(sqlDemo).not.toMatch(/set activo/);
    expect(renderPmSeedPlpgsql(buildPmSeedPlan(data, agent))).toContain('"demo":null');
  });

  it("la verificacion de esquema exige la migracion 036 SOLO en modo demo, y la 033 siempre", () => {
    expect(renderSchemaPreflightSql()).toContain("033_agente_config_historial_y_callbacks_estado.sql");
    expect(renderSchemaPreflightSql()).not.toContain("demo_organization");
    expect(renderSchemaPreflightSql({ demo: true })).toContain("036_demo_organization.sql");
  });

  it("la CLI reconoce --demo", () => {
    expect(parseSeedArgs([]).demo).toBe(false);
    expect(parseSeedArgs(["--demo", "--apply"])).toMatchObject({ demo: true, apply: true });
  });
});

describe("la promocion 2x1 del lunes se carga AUTOMATICA (el agente no manda codigos)", () => {
  it("el plan la marca auto_apply y el SQL la persiste y la repara al re-ejecutar", () => {
    const plan = buildPmSeedPlan(data, agent);
    expect(plan.promotions.every((p) => p.autoApply === true)).toBe(true);
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.promotions \([^)]*auto_apply\)/);
    expect(sql).toMatch(/auto_apply = excluded\.auto_apply/);
    expect(renderSchemaPreflightSql()).toContain("031_recoger_promociones_automaticas_puentes.sql");
  });

  it("al cotizar SIN codigo, el motor aplica el 2x1 el lunes al recoger; a domicilio o en otro dia no", async () => {
    const plan = buildPmSeedPlan(data, agent);
    const world = await buildInMemoryPmWorld(plan);
    const lunes = new Date("2026-10-12T20:00:00Z"); // lunes 14:00 en Merida
    const martes = new Date("2026-10-13T20:00:00Z");
    const pedido = (canal: "recoger" | "domicilio") => ({
      organizationId: world.organizationId,
      branchSlug: "altabrisa",
      customerName: "Cliente Prueba",
      customerPhone: "0001000001",
      ...(canal === "domicilio" ? { customerAddress: "Calle 7 #270, Vista Alegre" } : {}),
      canal,
      source: "web" as const,
      items: [
        { productId: world.productIds.get("Taco Al Pastor (individual)")!, requestedQuantity: 4, tortilla: "maiz" as const },
        { productId: world.productIds.get("Coca-Cola")!, requestedQuantity: 6 },
      ],
    });
    const base = await prepareCreateOrder(world.repo, pedido("recoger"), { asOf: martes });
    const conPromo = await prepareCreateOrder(world.repo, pedido("recoger"), { asOf: lunes });
    expect(base.discount).toBe(0);
    expect(conPromo.discount).toBeGreaterThan(0);
    expect(conPromo.appliedPromotion?.code).toBe("LUNES2X1PM");
    expect(conPromo.total).toBeCloseTo(base.total - conPromo.discount, 2);
    const domicilio = await prepareCreateOrder(world.repo, pedido("domicilio"), { asOf: lunes });
    expect(domicilio.discount).toBe(0);
  });
});
