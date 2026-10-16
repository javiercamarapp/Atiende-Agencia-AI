// R-19/R-20 -- el seed deja el agente de WhatsApp de PM COMPLETO (perfil taqueria_pm con los datos del dueño) y puede
// cargar la cuenta como DEMO. Los pendientes del dueño NO se inventan. Postgres real: scripts/verify-restaurantes-seed-pm/ (E1-E8).
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql, renderSchemaPreflightSql, WHATSAPP_AGENT_LIMITES, type PmSeedData } from "../src/seed/pm-demo.ts";
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
    // Dato del dueño (cuestionario l.83-84): "de 40 a 50 minutos para recoger y domicilio; mas en hora pico". Los tiempos medidos en T7 (60-75 min)
    // viven en la fila propia de T7, no en la de la organizacion que aplicaria tambien a T1 y T3.
    expect(plan.whatsappAgent.deliveryTimeText).toBe("de 40 a 50 minutos para recoger y a domicilio; más en hora pico");
    expect(plan.whatsappAgent.deliveryByBranch).toEqual([{ branchId: "T7", deliveryTimeText: "a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)" }]);
    // CR15: espera de rafagas recomendada (chats reales, §g.17); CR16: tone_style no es el tono real y los datos lo dicen.
    expect(plan.whatsappAgent.replyDebounceSeconds).toBe(6);
    expect(data.agente_whatsapp.tono_nota).toMatch(/NO es el tono real.*usted suave y seguro.*l\.144/);
    expect(plan.whatsappAgent.salsasText).toContain("guacamolera");
  });

  it("las promociones que anuncia el agente son SOLO las cargadas (lunes 2x1 y martes nachos con 2 aguas, solo recoger, todas las sucursales)", () => {
    expect(plan.whatsappAgent.promosText).toBe("lunes 2x1 en tacos al pastor y martes nachos de pastor con 2 aguas de cortesía; solo para recoger, en todas las sucursales");
    expect(plan.whatsappAgent.promosText).not.toMatch(/Montejo|Pensiones|Galer/);
    expect(plan.promotions.map((p) => p.code)).toEqual(["LUNES2X1PM", "MARTESNACHOSPM"]);
    // Nunca se anuncia lo que la base no cargo: sin el combo cargado, mencionar el martes invalida el seed; igual con el 2x1.
    const sinCombo = clone(data) as { -readonly [K in keyof PmSeedData]: PmSeedData[K] };
    sinCombo.promociones = sinCombo.promociones.filter((p) => p.codigo !== "MARTESNACHOSPM");
    expect(() => buildPmSeedPlan(sinCombo, agent)).toThrow(/combo del martes/);
    const sinLunes = clone(data) as { -readonly [K in keyof PmSeedData]: PmSeedData[K] };
    sinLunes.promociones = sinLunes.promociones.filter((p) => p.codigo !== "LUNES2X1PM");
    expect(() => buildPmSeedPlan(sinLunes, agent)).toThrow(/2x1 del lunes/);
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
    expect(prompt).toContain("lunes 2x1 en tacos al pastor y martes nachos de pastor con 2 aguas de cortesía; solo para recoger, en todas las sucursales");
    expect(prompt).not.toMatch(/la confirma la sucursal al recoger|no lo prometa ni lo aplique/);
    expect(prompt).toMatch(/Combo del martes[^.\n]*lo aplica cotizar_pedido/);
    expect(prompt).toContain("Los Taquitos de PM");
    expect(prompt).toContain("de 40 a 50 minutos para recoger y a domicilio; más en hora pico");
  });

  it("la regla de '3 de bistec' queda documentada en los datos para que el guion y la prueba la usen", () => {
    expect(data.agente_whatsapp.reglas_duras.join(" ")).toMatch(/3 de bistec/);
  });

  it("la voz sigue DESHABILITADA en el SQL del seed (sin gasto de proveedores) y la config del agente no pisa la del dueño", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.branch_voice_config[\s\S]*?false, v->'voice'->>'voiceId'/);
    expect(sql).toMatch(/insert into restaurantes\.whatsapp_agent_config[\s\S]*?on conflict \(organization_id\) where property_id is null do update set/);
    // Sobre la fila existente solo rellena la espera si esta vacia y reemplaza textos que ESTE seed sembro antes: nunca pisa lo que el dueño edito.
    expect(sql).toMatch(/reply_debounce_seconds = coalesce\(restaurantes\.whatsapp_agent_config\.reply_debounce_seconds, excluded\.reply_debounce_seconds\)/);
    expect(sql).toMatch(/delivery_time_text = case when restaurantes\.whatsapp_agent_config\.delivery_time_text in \(select jsonb_array_elements_text\(v->'whatsappAgent'->'legacyDeliveryTimeTexts'\)\)/);
    expect(sql).toMatch(/promos_text = case when restaurantes\.whatsapp_agent_config\.promos_text in \(select jsonb_array_elements_text\(v->'whatsappAgent'->'legacyPromosTexts'\)\)/);
    expect(sql).not.toMatch(/agent_name = excluded|tone_style = excluded|salsas_text = excluded|greeting_text = excluded/);
    // La fila propia de T7 copia la de la organizacion y no se pisa si ya existe.
    expect(sql).toMatch(/on conflict \(organization_id, property_id\) where property_id is not null do nothing/);
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

  it("la verificacion de esquema exige la migracion 037 SOLO en modo demo, y la 033 siempre", () => {
    expect(renderSchemaPreflightSql()).toContain("033_agente_config_historial_y_callbacks_estado.sql");
    expect(renderSchemaPreflightSql()).not.toContain("demo_organization");
    expect(renderSchemaPreflightSql({ demo: true })).toContain("037_demo_organization.sql");
  });

  it("la CLI reconoce --demo", () => {
    expect(parseSeedArgs([]).demo).toBe(false);
    expect(parseSeedArgs(["--demo", "--apply"])).toMatchObject({ demo: true, apply: true });
  });
});

describe("la promocion 2x1 del lunes se carga AUTOMATICA (el agente no manda codigos)", () => {
  it("el plan la marca auto_apply y el SQL la persiste (con las columnas del combo de cortesia) y la repara al re-ejecutar", () => {
    const plan = buildPmSeedPlan(data, agent);
    expect(plan.promotions.every((p) => p.autoApply === true)).toBe(true);
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.promotions \([^)]*auto_apply, property_ids, courtesy_product_ids, courtesy_quantity\)/);
    expect(sql).toMatch(/courtesy_product_ids = excluded\.courtesy_product_ids, courtesy_quantity = excluded\.courtesy_quantity/);
    expect(sql).toMatch(/auto_apply = excluded\.auto_apply/);
    expect(sql).toMatch(/property_ids = excluded\.property_ids/);
    expect(renderSchemaPreflightSql()).toContain("031_recoger_promociones_automaticas_puentes.sql");
    // Sin la 038 y la 031 el INSERT de promociones fallaria a la mitad: el seed se niega a correr.
    expect(renderSchemaPreflightSql()).toContain("restaurantes.promotions.courtesy_quantity");
    expect(renderSchemaPreflightSql()).toContain("039_agente_config_umbral_y_rafagas.sql");
    expect(renderSchemaPreflightSql()).toContain("restaurantes.promotions.property_ids");
    expect(renderSchemaPreflightSql()).toContain("038_promociones_por_sucursal.sql");
  });

  it("al cotizar SIN codigo, el motor aplica el 2x1 el lunes al recoger en Pensiones (T3) Y en Prolongacion Montejo (T1); a domicilio o en otro dia no", async () => {
    const plan = buildPmSeedPlan(data, agent);
    const world = await buildInMemoryPmWorld(plan);
    const lunes = new Date("2026-10-12T20:00:00Z"); // lunes 14:00 en Merida
    const martes = new Date("2026-10-13T20:00:00Z");
    const pedido = (canal: "recoger" | "domicilio", branchSlug = "pensiones") => ({
      organizationId: world.organizationId,
      branchSlug,
      customerName: "Cliente Prueba",
      customerPhone: "0001000001",
      // Con cobertura cargada (colonias del piloto) el domicilio exige una colonia de la zona de la sucursal.
      ...(canal === "domicilio" ? { customerAddress: "Calle 34 #382-C, Emiliano Zapata Norte", colonia: plan.colonias.find((c) => c.branchIds.includes(branchSlug === "pensiones" ? "T3" : branchSlug === "prol-montejo" ? "T1" : "T7"))!.name } : {}),
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
    // CR07/CR08: el dueño da el 2x1 para TODAS las sucursales (cuestionario l.99); la restriccion a T2, T3 y T4 era del menu impreso de 2025.
    for (const slug of ["prol-montejo", "garcia-lavin"]) {
      const enSucursal = await prepareCreateOrder(world.repo, pedido("recoger", slug), { asOf: lunes });
      expect(enSucursal.discount, slug).toBeGreaterThan(0);
      expect(enSucursal.appliedPromotion?.code, slug).toBe("LUNES2X1PM");
    }
  });
});
