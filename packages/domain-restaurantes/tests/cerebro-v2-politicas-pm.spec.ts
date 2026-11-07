// Port de las pruebas Deno puras de pm-policies.test.ts, pm-promos-guardia.test.ts, pm-programados.test.ts, recoger.test.ts,
// pm-reglas-duras.test.ts, fallos-medicion-1.test.ts y fallos-post-c3-r85.test.ts (suelto e69279e). Sin reloj implícito: cada
// prueba pasa `ahora`. El horario «sembrado» se contrasta contra POLITICAS_PM (aquí el dato vive en código, no en la migración).
import { describe, expect, it } from "vitest";
import * as p from "../src/whatsapp/cerebro-v2/politicas-pm.ts";

const merida = (iso: string) => new Date(`${iso}-06:00`);
const user = (content: string) => ({ role: "user", content });
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const T1 = [1, 2, 3, 4].map((dow) => ({ dow, opens_min: 1080, closes_min: 1500 })).concat([5, 6, 0].map((dow) => ({ dow, opens_min: 720, closes_min: 1500 })));
const T2 = [1, 2, 3, 4, 5].map((dow) => ({ dow, opens_min: 1080, closes_min: 1440 })).concat([6, 0].map((dow) => ({ dow, opens_min: 720, closes_min: 1440 })));
const T3 = TODOS.map((dow) => ({ dow, opens_min: 1080, closes_min: 1440 }));
const T7 = TODOS.map((dow) => ({ dow, opens_min: 720, closes_min: 1500 }));
const T4 = TODOS.map((dow) => ({ dow, opens_min: 720, closes_min: 1260 }));
const T21 = T4;
const FILA_T7 = { eta_domicilio_min: 60, eta_domicilio_max: 75, eta_domicilio_pico_min: 70, eta_domicilio_pico_max: 75, eta_recoger_min: 30, eta_recoger_max: 30, dias_pico: [5, 6, 0] };
const TUTEO = /\b(t[uú]|tus?|ti|contigo|tienes|quieres|puedes|necesitas|prefieres|dime|d[ií]nos|m[aá]ndame|m[aá]ndanos|av[ií]same|cu[eé]ntame|escr[ií]beme|escr[ií]benos|comp[aá]rteme|compartes|repites|conf[ií]rmame|gustaría\s+te|ayudarte|te\s+(?:pueda|puedo|ayud|aviso|confirm|contact|llam|mand|escrib|doy|paso|cobr|llev|esper|atend|recuerd)\w*)\b/i;

describe("propina (stripUnpromptedTip)", () => {
  it("se quitan las oraciones que la sugieren sin que el cliente la mencione", () => {
    const out = p.stripUnpromptedTip("Tu total es $186.00. ¿Deseas agregar propina para el repartidor? ¿Pagas en efectivo o tarjeta?", [user("Quiero 3 refrescos")]);
    expect(out).not.toMatch(/propin/i);
    expect(out).toContain("$186.00");
    expect(out).toContain("efectivo o tarjeta");
  });
  it("si el cliente la menciona, el agente puede contestarle", () => {
    const reply = "La propina es voluntaria y se la das al repartidor.";
    expect(p.stripUnpromptedTip(reply, [user("¿Se deja propina?")])).toBe(reply);
  });
  it("solo cuenta el ÚLTIMO mensaje del cliente", () => {
    const out = p.stripUnpromptedTip("Listo. ¿Quieres dejar propina?", [user("oye y la propina?"), { role: "assistant", content: "Es voluntaria." }, user("ok, 2 de pastor")]);
    expect(out).not.toMatch(/propin/i);
  });
  it("si todo era la propina queda una pregunta segura", () => {
    const out = p.stripUnpromptedTip("¿Cuánto quieres dejar de propina?", [user("pastor x4")]);
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).not.toMatch(/propin/i);
    expect(out).toMatch(/[?¿]/);
  });
  it("sin la palabra, la respuesta no se toca", () => {
    expect(p.stripUnpromptedTip("Perfecto, ¿cómo pagas?", [])).toBe("Perfecto, ¿cómo pagas?");
  });
  it("la política de propina viaja en PM_POLICY_RULES", () => {
    expect(p.PM_POLICY_RULES).toMatch(/nunca la preguntes ni la sugieras/);
  });
});

describe("tiempos", () => {
  it("etaRango arma rango, cifra única o nada", () => {
    expect(p.etaRango(60, 75)).toBe("60 a 75 minutos");
    expect(p.etaRango(30, 30)).toBe("30 minutos");
    expect(p.etaRango(75, 60)).toBe("60 a 75 minutos");
    expect(p.etaRango(null, null)).toBeNull();
    expect(p.etaRango(undefined, 45)).toBe("45 minutos");
  });
  it("el día de pico se calcula con la hora de Mérida, no la UTC", () => {
    expect(p.diaSemanaMerida(new Date("2026-11-07T04:00:00Z"))).toBe(5);
    expect(p.diaSemanaMerida(new Date("2026-11-02T18:00:00Z"))).toBe(1);
    expect(p.diaSemanaMerida(new Date("2026-11-08T05:00:00Z"))).toBe(6);
  });
  it("domicilio 60-75 entre semana y 70-75 de viernes a domingo; recoger 30", () => {
    expect(p.tiempoDomicilio(FILA_T7, new Date("2026-11-02T18:00:00Z"))).toBe("60 a 75 minutos");
    expect(p.tiempoDomicilio(FILA_T7, new Date("2026-11-06T18:00:00Z"))).toBe("70 a 75 minutos");
    expect(p.tiempoDomicilio(FILA_T7, new Date("2026-11-08T18:00:00Z"))).toBe("70 a 75 minutos");
    expect(p.tiempoRecoger(FILA_T7)).toBe("30 minutos");
  });
  it("otra sucursal puede tener otros minutos sin tocar código ni prompt", () => {
    const otra = { ...FILA_T7, eta_domicilio_min: 45, eta_domicilio_max: 60, eta_domicilio_pico_min: null, eta_domicilio_pico_max: null };
    expect(p.tiempoDomicilio(otra, new Date("2026-11-06T18:00:00Z"))).toBe("45 a 60 minutos");
  });
  it("sin dato capturado no se inventa ninguno", () => {
    const ahora = new Date("2026-11-02T18:00:00Z");
    expect(p.tiempoDomicilio(null, ahora)).toBeNull();
    expect(p.tiempoDomicilio({}, ahora)).toBeNull();
    expect(p.tiempoRecoger({})).toBeNull();
  });
  it("la regla de tiempos apunta a la herramienta", () => {
    expect(p.PM_POLICY_RULES).toMatch(/tiempo_estimado/);
  });
  it("POLITICAS_PM: los datos del 31-oct producen los mismos textos (fila de T7)", () => {
    const fila = p.filaPoliticaPm("garcia-lavin");
    expect(p.tiempoDomicilio(fila, new Date("2026-11-02T18:00:00Z"))).toBe("60 a 75 minutos");
    expect(p.tiempoDomicilio(fila, new Date("2026-11-07T18:00:00Z"))).toBe("70 a 75 minutos");
    expect(p.tiempoRecoger(fila)).toBe("30 minutos");
  });
});

describe("promos", () => {
  const busqueda = (slug: string, promos: boolean) => ({ role: "tool", content: JSON.stringify({ encontrada: true, branch_slug: slug, politica: { promos_en_recoger: promos } }) });
  const llamada = (args: Record<string, unknown>) => ({ role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "cotizar_pedido", arguments: JSON.stringify(args) } }] });

  it("no se ofrecen por iniciativa del agente", () => {
    const out = p.enforcePromoPolicy("Son $186.00. Hoy hay 2x1 en tacos de pastor, ¿te lo agrego? ¿Pagas en efectivo o tarjeta?", [user("Quiero 3 refrescos")]);
    expect(out).not.toMatch(/2x1|promo/i);
    expect(out).toContain("$186.00");
    expect(out).toContain("efectivo o tarjeta");
  });
  it("si el cliente pregunta, la respuesta debe decir que es para recoger", () => {
    const sinAclarar = p.enforcePromoPolicy("Sí, tenemos promoción de nachos + aguas.", [user("¿hay promociones para mi pedido a domicilio?")]);
    expect(sinAclarar).toMatch(/no aplican a domicilio/i);
    expect(sinAclarar).toMatch(/recoger/i);
    const aclarada = "Las promos solo valen para recoger en la sucursal.";
    expect(p.enforcePromoPolicy(aclarada, [user("¿tienen promos?")])).toBe(aclarada);
  });
  it.each(["Hay 2 x 1 los lunes.", "Dos por uno en tacos.", "Nachos + aguas por $199."])("2x1 y nachos + aguas cuentan como promoción: %s", (reply) => {
    expect(p.enforcePromoPolicy(reply, [user("hola")])).not.toMatch(/2\s*x\s*1|dos por uno|nachos/i);
  });
  it("sin la palabra no se toca la respuesta", () => {
    expect(p.enforcePromoPolicy("Perfecto, tu pedido sale de Altabrisa.", [])).toBe("Perfecto, tu pedido sale de Altabrisa.");
  });
  it("dato por sucursal; solo true activa promos_en_recoger", () => {
    const ahora = new Date("2026-11-02T18:00:00Z");
    expect(p.branchPolicyFacts({ promos_en_recoger: true }, ahora).promos_en_recoger).toBe(true);
    expect(p.branchPolicyFacts({ promos_en_recoger: false }, ahora).promos_en_recoger).toBe(false);
    expect(p.branchPolicyFacts(null, ahora).promos_en_recoger).toBe(false);
    for (const slug of ["fco-montejo", "pensiones"]) expect(p.filaPoliticaPm(slug)?.promos_en_recoger).toBe(true);
    // Galerías: solo venta local (6-nov-2026, migración 105), fuera del agente.
    for (const slug of ["prol-montejo", "garcia-lavin", "altabrisa", "playa", "galerias"]) expect(p.filaPoliticaPm(slug)?.promos_en_recoger).toBe(false);
  });
  it("la política de promos del prompt es una sola línea y apunta al dato por sucursal", () => {
    const l = p.PM_POLICY_RULES.split("\n").filter((x) => /^- Promociones/.test(x));
    expect(l).toHaveLength(1);
    expect(l[0]).toMatch(/promos_en_recoger/);
    expect(l[0]).toMatch(/NUNCA a domicilio/);
    expect(p.PM_POLICY_RULES).not.toMatch(/SOLO para comer en el restaurante/);
  });
  it("contexto: sucursal, dato de promos y modalidad salen del hilo", () => {
    const ctx = p.contextoPromo([user("hola"), busqueda("fco-montejo", true), llamada({ branch_slug: "fco-montejo", entrega: "recoger" })]);
    expect(ctx).toEqual({ sucursal: "fco-montejo", promos: true, entrega: "recoger" });
    expect(p.contextoPromo([]).sucursal).toBeNull();
    expect(p.contextoPromo([]).promos).toBeNull();
    expect(p.contextoPromo([llamada({ branch_slug: "pensiones" })]).promos).toBe(true);
    expect(p.contextoPromo([llamada({ branch_slug: "garcia-lavin" })]).promos).toBe(false);
    expect(p.contextoPromo([busqueda("garcia-lavin", true)]).promos).toBe(true);
  });
  it("contexto: la modalidad de las herramientas gana; el texto del cliente solo sin herramientas", () => {
    expect(p.contextoPromo([user("lo quiero a domicilio"), llamada({ branch_slug: "x", entrega: "recoger" })]).entrega).toBe("recoger");
    expect(p.contextoPromo([user("paso por mi pedido")]).entrega).toBe("recoger");
    expect(p.contextoPromo([user("me lo mandan a mi casa a domicilio")]).entrega).toBe("domicilio");
    expect(p.contextoPromo([user("¿es a domicilio o para recoger?")]).entrega).toBeNull();
  });
  it("CR-WA-036: en García Lavín (sin promos) la promo no se afirma y se dice dónde sí hay", () => {
    const out = p.enforcePromoPolicy("Sí, hoy tenemos 2x1 en pastor. ¿Cuántos desea?", [busqueda("garcia-lavin", false), user("El pastor es dos por uno hoy verdad?")]);
    expect(out).not.toMatch(/2x1/);
    expect(out).toMatch(/no manejamos promociones/);
    expect(out).toMatch(/Francisco de Montejo y Pensiones\./);
    expect(out).not.toMatch(/galer/i);
    expect(out).toMatch(/¿Cuántos desea\?/);
    expect(TUTEO.test(out)).toBe(false);
    expect(TUTEO.test(p.PROMO_SIN_SUCURSAL_NOTICE)).toBe(false);
  });
  it("sucursal participante + recoger: la respuesta se respeta", () => {
    const hilo = [busqueda("fco-montejo", true), llamada({ branch_slug: "fco-montejo", entrega: "recoger" }), user("¿hay promociones para recoger?")];
    const reply = "Sí, en Francisco de Montejo hay promociones para pedidos a recoger; las aplica el personal en mostrador.";
    expect(p.enforcePromoPolicy(reply, hilo)).toBe(reply);
  });
  it("sucursal participante pero a domicilio: se aclara que es solo para recoger", () => {
    const out = p.enforcePromoPolicy("Sí, tenemos promoción de nachos + aguas.", [busqueda("pensiones", true), llamada({ branch_slug: "pensiones", entrega: "domicilio" }), user("¿tienen promoción?")]);
    expect(out).toMatch(/no aplican a domicilio/);
    expect(out).toMatch(/recoger/);
  });
  it("modalidad desconocida o sin sucursal: se aclara (no se asume)", () => {
    expect(p.enforcePromoPolicy("Sí, hay 2x1 los lunes.", [busqueda("fco-montejo", true), user("¿hay promos?")])).toMatch(/recoger/);
    expect(p.enforcePromoPolicy("Sí, en kilos tenemos promoción.", [user("Hay alguna promoción en kilos de carne?")])).toMatch(/recoger/);
  });
  it("P2-3: un producto cuyo NOMBRE trae «promo» no dispara la guardia", () => {
    const hilo = [{ role: "tool", content: JSON.stringify([{ id: "1", name: "Paquete Promo Familiar", price: 399 }]) }, user("Quiero el paquete familiar")];
    const reply = "Tenemos el Paquete Promo Familiar por $399.00. ¿A domicilio o a recoger?";
    expect(p.enforcePromoPolicy(reply, hilo)).toBe(reply);
    const mezcla = p.enforcePromoPolicy("Tenemos el Paquete Promo Familiar por $399.00. Además hay 2x1 hoy. ¿Algo más?", hilo);
    expect(mezcla).toMatch(/Paquete Promo Familiar/);
    expect(mezcla).not.toMatch(/2x1/);
    expect(mezcla).toMatch(/¿Algo más\?/);
  });
  it("sin que el cliente pregunte, la promo no se ofrece en ningún caso", () => {
    for (const hilo of [[busqueda("fco-montejo", true), llamada({ branch_slug: "fco-montejo", entrega: "recoger" }), user("quiero 6 tacos")], [user("hola")]]) {
      const out = p.enforcePromoPolicy("Tenemos promoción de 2x1. ¿Qué le sirvo?", hilo);
      expect(out).not.toMatch(/2x1|promo/i);
      expect(out).toMatch(/¿Qué le sirvo\?/);
    }
  });
  it("contextoPromo reconoce la sucursal que el cliente nombra sin herramientas", () => {
    const casos: Array<[string, string, boolean]> = [
      ["Hola, quiero recoger en Garcia Lavin, ahi aplica el 2x1 de pastor?", "garcia-lavin", false],
      ["quiero recoger en la de Pensiones, hay 2x1?", "pensiones", true],
      ["voy a recoger a Francisco de Montejo", "fco-montejo", true],
      ["en Prolongación Montejo hay promo?", "prol-montejo", false],
    ];
    for (const [texto, slug, promos] of casos) {
      const ctx = p.contextoPromo([user(texto)]);
      expect([ctx.sucursal, ctx.promos], texto).toEqual([slug, promos]);
    }
    expect(p.contextoPromo([user("hola, hay 2x1?")]).sucursal).toBeNull();
    // Galerías es solo venta local: su nombre no fija sucursal (ni promos) en el texto del cliente.
    expect(p.contextoPromo([user("aplica la promo en plaza galerias?")]).sucursal).toBeNull();
  });
  it("promo preguntada para una sucursal sin promos dice que ahí no aplica y dónde sí", () => {
    const out = p.enforcePromoPolicy("Para recoger, las promociones las aplica el personal en mostrador si están vigentes en esa sucursal. ¿Me comparte su nombre?", [user("Hola, quiero recoger en Garcia Lavin, ahi aplica el 2x1 de pastor?")]);
    expect(out).toMatch(/no manejamos promociones/);
    expect(out).toMatch(/Pensiones/);
  });
  it.each(["mi dirección es Paseo de Montejo 450", "calle 60 por Montejo", "vivo en Altabrisa", "estoy en Residencial Pensiones", "me lo mandan por Galerías", "voy por mi pedido a Galerías", "es en Chicxulub", "a domicilio, colonia Pensiones", "voy a estar en mi casa en Altabrisa", "Montejo"])("sucursalNombrada: «%s» no es sucursal", (t) => {
    expect(p.sucursalNombrada(t)).toBeNull();
  });
  it.each([
    ["Hola, quiero recoger en Garcia Lavin, ahi aplica el 2x1 de pastor?", "garcia-lavin"],
    ["paso por Pensiones en un rato", "pensiones"],
    ["la sucursal de Altabrisa abre hoy?", "altabrisa"],
    ["hay promo en la de Pensiones?", "pensiones"],
    ["recojo en Francisco de Montejo", "fco-montejo"],
    ["sucursal Montejo", "fco-montejo"],
    ["en Prolongación Montejo hay promo?", "prol-montejo"],
  ])("sucursalNombrada: «%s» -> %s", (t, slug) => {
    expect(p.sucursalNombrada(t)).toBe(slug);
  });
  it("«vivo en Altabrisa» no fija sucursal; «la sucursal de Pensiones» sí", () => {
    expect(p.contextoPromo([user("vivo en Altabrisa, quiero 3 tacos")]).sucursal).toBeNull();
    expect(p.contextoPromo([user("lo quiero a domicilio por favor"), user("la sucursal de Pensiones tiene promo?")]).sucursal).toBe("pensiones");
  });
  it("Chicxulub (T5) se nombra con el slug del monorrepo «playa»", () => {
    expect(p.sucursalesMencionadas("la de chicxulub sigue abierta?")).toEqual(["playa"]);
  });
});

describe("pedido grande y cancelación", () => {
  it("el umbral es estrictamente mayor a $4,000", () => {
    expect(p.esPedidoGrande(4000.01)).toBe(true);
    expect(p.esPedidoGrande(4000)).toBe(false);
    expect(p.esPedidoGrande(null)).toBe(false);
    expect(p.esPedidoGrande("5000")).toBe(false);
    expect(p.POLITICAS_PM.pedidoGrande).toEqual({ umbral: 4000, estado: "por_aprobar" });
  });
  it("el prompt explica la política y apunta a los campos del servidor", () => {
    expect(p.PM_POLICY_RULES).toMatch(/pedido_grande/);
    expect(p.PM_POLICY_RULES).toMatch(/requiere_aprobacion/);
  });
  it("la respuesta sigue la política (primeros ~10 min sin cargo, si ya salió lo ve la sucursal)", () => {
    const texto = p.cancelacionReply();
    expect(texto).toMatch(/avisé a la sucursal/);
    expect(texto).toMatch(/10 minutos/);
    expect(texto).toMatch(/sin cargo/);
    expect(texto).toMatch(/aún no empezamos a prepararlo/);
    expect(texto).not.toMatch(/sin ningún cargo/);
    expect(texto).toMatch(/salió a reparto, la sucursal le confirma/);
    expect(texto).not.toMatch(/aparte/i);
    expect(texto).not.toMatch(/reembols|devoluci/i);
  });
  it("la ventana es un dato (parámetro)", () => {
    expect(p.cancelacionReply(15)).toContain("15 minutos");
    expect(p.CANCELACION_VENTANA_MIN).toBe(10);
  });
  it("modificar: el prompt manda avisar a la sucursal, no crear otro pedido ni prometer envío aparte", () => {
    expect(p.PM_POLICY_RULES).toMatch(/modificacion_pedido/);
    expect(p.PM_POLICY_RULES).toMatch(/no cree otro pedido/i);
    expect(p.PM_POLICY_RULES).toMatch(/No prometa que se manda aparte/);
  });
});

describe("horarios", () => {
  it("formato de hora legible", () => {
    expect(p.formatoHora(720)).toBe("12:00 pm");
    expect(p.formatoHora(1500)).toBe("1:00 am");
    expect(p.formatoHora(1440)).toBe("12:00 am");
    expect(p.formatoHora(1080)).toBe("6:00 pm");
  });
  it("T7/T8 abren 12:00-01:00 todos los días, incluso pasada la medianoche", () => {
    expect(p.estadoHorario(T7, merida("2026-11-02T11:59:00")).abierta_ahora).toBe(false);
    expect(p.estadoHorario(T7, merida("2026-11-02T12:00:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T7, merida("2026-11-03T00:30:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T7, merida("2026-11-03T01:00:00")).abierta_ahora).toBe(false);
    expect(p.estadoHorario(T7, merida("2026-11-02T12:00:00")).horario_hoy).toBe("12:00 pm a 1:00 am");
  });
  it("T2 Fco. de Montejo, lun-vie 18-24 y sáb-dom 12-24", () => {
    expect(p.estadoHorario(T2, merida("2026-11-04T13:00:00")).abierta_ahora).toBe(false);
    expect(p.estadoHorario(T2, merida("2026-11-04T18:00:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T2, merida("2026-11-07T13:00:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T2, merida("2026-11-08T23:59:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T2, merida("2026-11-09T00:00:00")).abierta_ahora).toBe(false);
  });
  it("T3 Pensiones 18-24 y T4 Galerías 12-21", () => {
    expect(p.estadoHorario(T3, merida("2026-11-04T17:59:00")).abierta_ahora).toBe(false);
    expect(p.estadoHorario(T3, merida("2026-11-04T22:00:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T4, merida("2026-11-04T20:59:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T4, merida("2026-11-04T21:00:00")).abierta_ahora).toBe(false);
  });
  it("T1 Prolongación, lun-jue 18-01 y vie-dom 12-01", () => {
    expect(p.estadoHorario(T1, merida("2026-11-04T13:00:00")).abierta_ahora).toBe(false);
    expect(p.estadoHorario(T1, merida("2026-11-06T13:00:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T1, merida("2026-11-07T00:30:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T1, merida("2026-11-10T00:30:00")).abierta_ahora).toBe(true);
    expect(p.estadoHorario(T1, merida("2026-11-10T13:00:00")).abierta_ahora).toBe(false);
  });
  it("sin horario capturado no se bloquea nada; día sin fila = cerrada hoy", () => {
    expect(p.estadoHorario([], new Date("2026-11-04T18:00:00Z")).abierta_ahora).toBeNull();
    expect(p.estadoHorario(null, new Date("2026-11-04T18:00:00Z")).horario_hoy).toBeNull();
    const martes = p.estadoHorario([{ dow: 1, opens_min: 720, closes_min: 1260 }], merida("2026-11-03T13:00:00"));
    expect(martes).toEqual({ abierta_ahora: false, horario_hoy: "cerrada hoy" });
  });
  it("con la sucursal cerrada o sin domicilio no se toma el pedido", () => {
    const cerrada = p.motivoNoTomarPedido({ branch_schedule: T3 }, merida("2026-11-04T13:00:00"));
    expect(cerrada).toMatch(/cerrada/);
    expect(cerrada).toMatch(/6:00 pm a 12:00 am/);
    expect(p.motivoNoTomarPedido({ branch_schedule: T3 }, merida("2026-11-04T19:00:00"))).toBeNull();
    expect(p.motivoNoTomarPedido({ branch_schedule: [] }, merida("2026-11-04T13:00:00"))).toBeNull();
    expect(p.motivoNoTomarPedido({ acepta_domicilio: false, branch_schedule: T7 }, merida("2026-11-04T19:00:00"))).toMatch(/no hace entregas a domicilio/);
    expect(p.motivoNoTomarPedido({ acepta_domicilio: true, branch_schedule: T4 }, merida("2026-11-04T15:00:00"))).toBeNull();
  });
  it("los hechos para el modelo incluyen abierta_ahora, horario_hoy y acepta_domicilio", () => {
    const f = p.branchPolicyFacts({ branch_schedule: T3, acepta_domicilio: true }, merida("2026-11-04T19:00:00"));
    expect(f.abierta_ahora).toBe(true);
    expect(f.horario_hoy).toBe("6:00 pm a 12:00 am");
    expect(f.acepta_domicilio).toBe(true);
  });
  it("datos: el horario de POLITICAS_PM coincide con la política del dueño (antes: horario sembrado en la migración)", () => {
    const casos: Array<[string, string, boolean | null]> = [
      ["garcia-lavin", "2026-11-04T11:59:00", false], ["garcia-lavin", "2026-11-04T12:00:00", true],
      ["garcia-lavin", "2026-11-05T00:59:00", true], ["garcia-lavin", "2026-11-05T01:00:00", false],
      ["altabrisa", "2026-11-04T12:00:00", true], ["altabrisa", "2026-11-05T01:00:00", false],
      ["fco-montejo", "2026-11-04T17:59:00", false], ["fco-montejo", "2026-11-04T18:00:00", true],
      ["fco-montejo", "2026-11-07T12:00:00", true], ["fco-montejo", "2026-11-08T12:00:00", true],
      ["pensiones", "2026-11-08T12:00:00", false], ["pensiones", "2026-11-08T18:00:00", true],
      ["prol-montejo", "2026-11-04T12:00:00", false], ["prol-montejo", "2026-11-04T18:00:00", true],
      ["prol-montejo", "2026-11-06T12:00:00", true], ["prol-montejo", "2026-11-07T00:30:00", true],
      // Galerías: solo venta local, sin horario en las políticas del agente (no bloquea ni afirma nada).
      ["galerias", "2026-11-04T20:59:00", null],
    ];
    for (const [slug, iso, esperado] of casos) {
      expect(p.estadoHorario(p.filaPoliticaPm(slug)?.branch_schedule, merida(iso)).abierta_ahora, `${slug} ${iso}`).toBe(esperado);
    }
  });
  it("datos: T5 (playa/Chicxulub) cerrada sin horario; Galerías solo venta local (fuera del agente); Pensiones = catálogo de T7", () => {
    const playa = p.POLITICAS_PM.sucursales.playa;
    expect(playa.activa).toBe(false);
    expect(playa.horario).toHaveLength(0);
    expect(p.filaPoliticaPm("playa")?.acepta_domicilio).toBe(false);
    expect(p.sucursalesAperturaPm().map((s) => s.slug)).not.toContain("playa");
    expect(p.POLITICAS_PM.sucursales.galerias.activa).toBe(false);
    expect(p.filaPoliticaPm("galerias")?.acepta_domicilio).toBe(false);
    expect(p.sucursalesAperturaPm().map((s) => s.slug)).not.toContain("galerias");
    expect(Object.values(p.POLITICAS_PM.sucursales).filter((s) => s.activa).every((s) => s.aceptaDomicilio)).toBe(true);
    expect(p.POLITICAS_PM.sucursales.pensiones.catalogoDe).toBe("garcia-lavin");
    expect(p.filaPoliticaPm("chicxulub")).toBeNull();
  });
});

describe("recoger (validarRecoger)", () => {
  it("sin hora pedida se ofrece ahora + 30 min", () => {
    const r = p.validarRecoger(undefined, merida("2026-11-04T19:00:00"), T7);
    expect(r).toEqual({ ok: true, hora: "7:30 pm", at: merida("2026-11-04T19:30:00") });
  });
  it("la hora pedida debe estar al menos 25 min adelante", () => {
    const ahora = merida("2026-11-04T19:00:00");
    const pronto = p.validarRecoger("19:24", ahora, T7);
    expect(pronto.ok).toBe(false);
    expect(!pronto.ok && pronto.error).toMatch(/7:25 pm/);
    expect(!pronto.ok && pronto.error).toMatch(/25 minutos/);
    const justo = p.validarRecoger("19:25", ahora, T7);
    expect(justo.ok && justo.hora).toBe("7:25 pm");
    expect(p.validarRecoger("19:00", ahora, T7).ok).toBe(false);
  });
  it("una hora que ya pasó hoy se rechaza", () => {
    const r = p.validarRecoger("13:00", merida("2026-11-04T19:00:00"), T7);
    expect(!r.ok && r.error).toMatch(/ya pasó|muy lejos/);
  });
  it.each(["7 pm", "25:00", "19:75", "tarde", "19-30"])("formato inválido: %s", (mala) => {
    const r = p.validarRecoger(mala, merida("2026-11-04T19:00:00"), T7);
    expect(!r.ok && r.error).toMatch(/HH:MM/);
  });
  it("la sucursal debe estar abierta a la hora de recoger", () => {
    const cerrada = p.validarRecoger(undefined, merida("2026-11-04T17:00:00"), T3);
    expect(!cerrada.ok && cerrada.error).toMatch(/no está abierta[\s\S]*6:00 pm a 12:00 am/);
    const dentro = p.validarRecoger("18:30", merida("2026-11-04T17:00:00"), T3);
    expect(dentro.ok && dentro.hora).toBe("6:30 pm");
    expect(p.validarRecoger(undefined, merida("2026-11-04T04:00:00"), []).ok).toBe(true);
  });
  it("cruza la medianoche (T7 cierra a la 1:00 am)", () => {
    const ok = p.validarRecoger("00:30", merida("2026-11-04T23:50:00"), T7);
    expect(ok.ok && ok.hora).toBe("12:30 am");
    const tarde = p.validarRecoger("01:30", merida("2026-11-04T23:50:00"), T7);
    expect(!tarde.ok && tarde.error).toMatch(/no está abierta/);
  });
  it("la hora actual de Mérida como hecho", () => {
    expect(p.horaActualTexto(merida("2026-11-04T19:05:00"))).toBe("19:05 (miércoles)");
    expect(p.horaActualTexto(merida("2026-11-08T00:30:00"))).toBe("00:30 (domingo)");
  });
  it("recoger no se bloquea por 'sin domicilio' ni por 'cerrada ahora'", () => {
    const fila = { acepta_domicilio: false, branch_schedule: [{ dow: 99, opens_min: 0, closes_min: 1 }] };
    const ahora = merida("2026-11-04T14:00:00");
    expect(p.motivoNoTomarPedido(fila, ahora, "recoger")).toBeNull();
    expect(p.motivoNoTomarPedido(fila, ahora, "domicilio")).not.toBeNull();
  });
  it("R85-6: si la espera mínima llega al cierre, dice a qué hora cierra y que hoy ya no se puede", () => {
    const sinHora = p.validarRecoger(undefined, merida("2026-11-04T23:40:00"), T3);
    expect(!sinHora.ok && sinHora.error).toBe("Ya no es posible recoger hoy: la sucursal cierra a las 12:00 am.");
    const pronto = p.validarRecoger("23:50", merida("2026-11-04T23:40:00"), T3);
    expect(!pronto.ok && pronto.error).toMatch(/^Ya no es posible recoger hoy/);
    expect(!pronto.ok && pronto.error).not.toMatch(/Lo más temprano es 12:05 am/);
    const cerro = p.validarRecoger(undefined, merida("2026-11-04T22:00:00"), T21);
    expect(!cerro.ok && cerro.error).toBe("Ya no es posible recoger hoy: la sucursal cerró a las 9:00 pm.");
    const conTiempo = p.validarRecoger("23:00", merida("2026-11-04T22:50:00"), T3);
    expect(!conTiempo.ok && conTiempo.error).toMatch(/Lo más temprano es 11:15 pm/);
    expect(p.validarRecoger("00:30", merida("2026-11-04T23:50:00"), T7).ok).toBe(true);
  });
});

describe("programados y apertura", () => {
  const fila = (schedule: p.ScheduleRow[], extra: Partial<p.BranchPolicyRow> = {}): p.BranchPolicyRow =>
    ({ branch_schedule: schedule, eta_domicilio_min: 40, eta_domicilio_max: 55, dias_pico: [], ...extra });

  it("sucursal CERRADA ahora que abre hoy — mínimo desde la apertura + espera", () => {
    const ahora = merida("2026-11-04T09:00:00");
    const pronto = p.validarDomicilioProgramado("12:30", ahora, fila(T7));
    expect(!pronto.ok && pronto.error).toMatch(/12:40 pm/);
    expect(p.validarDomicilioProgramado("12:40", ahora, fila(T7))).toEqual({ ok: true, hora: "12:40 pm", at: merida("2026-11-04T12:40:00") });
    expect(p.validarDomicilioProgramado("11:00", ahora, fila(T7)).ok).toBe(false);
  });
  it("abierta ahora — mínimo ahora + espera; máximo 12 h; tope al cierre", () => {
    const ahora = merida("2026-11-04T19:00:00");
    expect(p.validarDomicilioProgramado("19:30", ahora, fila(T7)).ok).toBe(false);
    expect(p.validarDomicilioProgramado("19:40", ahora, fila(T7)).ok).toBe(true);
    expect(p.validarDomicilioProgramado("22:00", ahora, fila(T7)).ok).toBe(true);
    expect(p.validarDomicilioProgramado("00:30", ahora, fila(T7))).toEqual({ ok: true, hora: "12:30 am", at: merida("2026-11-05T00:30:00") });
    expect(p.validarDomicilioProgramado("01:30", ahora, fila(T7)).ok).toBe(false);
    expect(p.validarDomicilioProgramado("23:50", merida("2026-11-04T23:30:00"), fila(T3)).ok).toBe(false);
  });
  it("ya cerró por hoy => no se programa y se dice cuándo abre mañana", () => {
    const r = p.validarDomicilioProgramado("22:30", merida("2026-11-04T22:00:00"), fila(T21));
    expect(!r.ok && r.error).toMatch(/Ya no se puede programar[\s\S]*Mañana abrimos a las 12:00 pm/);
  });
  it("espera por omisión 45 min, pico usa el de pico, formato y sin horario", () => {
    expect(p.esperaMinimaDomicilio(fila(T7, { eta_domicilio_min: null }), merida("2026-11-04T12:00:00"))).toBe(45);
    expect(p.esperaMinimaDomicilio(fila(T7, { dias_pico: [5], eta_domicilio_pico_min: 70 }), merida("2026-11-06T12:00:00"))).toBe(70);
    expect(p.validarDomicilioProgramado("7pm", merida("2026-11-04T12:00:00"), fila(T7)).ok).toBe(false);
    const sin = p.validarDomicilioProgramado("19:00", merida("2026-11-04T12:00:00"), fila([]));
    expect(!sin.ok && sin.error).toMatch(/horario/);
    expect(p.validarDomicilioProgramado("19:00", merida("2026-11-04T12:00:00"), null).ok).toBe(false);
  });
  it("turno de ayer que cruza la medianoche", () => {
    const row = fila(T7, { eta_domicilio_min: 10 });
    const ok = p.validarDomicilioProgramado("00:45", merida("2026-11-05T00:30:00"), row);
    expect(!ok.ok || ok.hora === "12:45 am").toBe(true);
    expect(p.validarDomicilioProgramado("12:30", merida("2026-11-05T00:30:00"), row).ok).toBe(true);
  });
  it("R85-7: abierta sin tiempo para programar dice a qué hora cierra; fuera dice la más tarde", () => {
    const r = p.validarDomicilioProgramado("23:50", merida("2026-11-04T23:30:00"), fila(T3));
    expect(!r.ok && r.error).toMatch(/^Ya no alcanza para programar un pedido para más tarde hoy: la sucursal cierra a las 12:00 am\./);
    const fuera = p.validarDomicilioProgramado("01:30", merida("2026-11-04T19:00:00"), fila(T7));
    expect(!fuera.ok && fuera.error).toMatch(/Lo más temprano es 7:40 pm y para hoy lo más tarde es 12:55 am/);
    const cerro = p.validarDomicilioProgramado("22:30", merida("2026-11-04T22:00:00"), fila(T21));
    expect(!cerro.ok && cerro.error).toMatch(/Ya no se puede programar/);
  });
  it("estadoApertura y bloque de hoy con todas cerradas", () => {
    const ahora = merida("2026-11-04T09:00:00");
    expect(p.estadoApertura(T7, ahora).estado).toBe("abre_hoy");
    expect(p.estadoApertura(T7, merida("2026-11-04T13:00:00")).estado).toBe("abierta");
    expect(p.estadoApertura(T3, merida("2026-11-04T23:59:00")).estado).toBe("abierta");
    expect(p.estadoApertura(T7, merida("2026-11-05T00:30:00")).estado).toBe("abierta");
    expect(p.estadoApertura(T3, merida("2026-11-05T00:00:00")).estado).toBe("abre_hoy");
    expect(p.estadoApertura([], ahora).estado).toBe("sin_horario");
    const sucs = [{ name: "Altabrisa", slug: "altabrisa", branch_schedule: T7 }, { name: "Pensiones", slug: "pensiones", branch_schedule: T3 }];
    const b = p.bloqueAperturaHoy(sucs, ahora) ?? "";
    expect(b).toMatch(/Altabrisa: CERRADA ahora, abre HOY a las 12:00 pm/);
    expect(b).toMatch(/Pensiones: CERRADA ahora, abre HOY a las 6:00 pm/);
    expect(b).toMatch(/NINGUNA SUCURSAL ESTÁ ABIERTA/);
    expect(b).toMatch(/desde la primera frase/);
    expect(p.bloqueAperturaHoy(sucs, merida("2026-11-04T13:00:00"))).not.toMatch(/NINGUNA/);
    expect(TUTEO.test(b)).toBe(false);
  });
  it("el aviso de cierre va AL INICIO en el primer mensaje", () => {
    const ahora = merida("2026-11-04T09:00:00");
    const sucs = [{ name: "A", branch_schedule: T7 }, { name: "B", branch_schedule: T3 }];
    const mal = "¡Hola! Buenos días, qué gusto saludarle. Con mucho gusto le ayudo con su pedido de hoy; cuénteme qué se le antoja, si tacos de pastor, de cochinita o alguna orden especial de la casa. Por cierto, hoy estamos cerrados todavía.";
    const r = p.avisoCierreAlInicio(mal, sucs, true, ahora);
    expect(r.startsWith("Por ahora estamos cerrados; hoy abrimos a partir de las 12:00 pm")).toBe(true);
    expect(r.endsWith(mal)).toBe(true);
    const bien = "Buenos días, por ahora estamos cerrados; abrimos hoy a las 12:00 pm. ¿Le dejo su pedido programado?";
    expect(p.avisoCierreAlInicio(bien, sucs, true, ahora)).toBe(bien);
    expect(p.avisoCierreAlInicio(mal, sucs, false, ahora)).toBe(mal);
    expect(p.avisoCierreAlInicio(mal, sucs, true, merida("2026-11-04T13:00:00"))).toBe(mal);
    expect(p.avisoCierreAlInicio(mal, [{ name: "A", branch_schedule: [] }], true, ahora)).toBe(mal);
  });
  it("sucursalesAperturaPm alimenta el bloque con las 5 activas del agente (sin Chicxulub ni Galerías)", () => {
    const b = p.bloqueAperturaHoy(p.sucursalesAperturaPm(), merida("2026-11-04T13:00:00")) ?? "";
    expect(b.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
    expect(b).not.toMatch(/galer/i);
    expect(b).toMatch(/Altabrisa: ABIERTA ahora/);
    expect(b).toMatch(/Pensiones: CERRADA ahora, abre HOY a las 6:00 pm/);
  });
});

describe("reglas duras (H4)", () => {
  const GL = { lat: 21.0205, lng: -89.615 };
  const alNorte = (km: number) => ({ lat: GL.lat + km / 111.19492664455873, lng: GL.lng });
  it("haversine: distancia conocida y simetría", () => {
    const d = p.haversineKm(GL, alNorte(8));
    expect(Math.abs(d - 8)).toBeLessThan(0.01);
    expect(Math.abs(p.haversineKm(alNorte(8), GL) - d)).toBeLessThan(1e-9);
    expect(p.haversineKm(GL, GL)).toBe(0);
  });
  it("zona: 8.0 km entra, 8.1 km no", () => {
    expect(p.dentroDeZona(8)).toBe(true);
    expect(p.dentroDeZona(7.9)).toBe(true);
    expect(p.dentroDeZona(8.1)).toBe(false);
  });
  it("recoger nunca se bloquea; domicilio sí", () => {
    const malo = { total: 100, conAlcohol: true, distanciaKm: 20 };
    expect(p.evaluarReglasDuras({ entrega: "recoger", ...malo })).toBeNull();
    expect(p.evaluarReglasDuras({ entrega: "domicilio", ...malo })?.codigo).toBe("fuera_de_zona");
    expect(p.evaluarReglasDuras({ entrega: "domicilio", total: 100, conAlcohol: true, distanciaKm: 2 })?.codigo).toBe("alcohol_domicilio");
    expect(p.evaluarReglasDuras({ entrega: "domicilio", total: 199.99, conAlcohol: false, distanciaKm: 2 })?.codigo).toBe("minimo_domicilio");
    expect(p.evaluarReglasDuras({ entrega: "domicilio", total: 200, conAlcohol: false, distanciaKm: 8 })).toBeNull();
    expect(p.evaluarReglasDuras({ entrega: "domicilio", total: 250, conAlcohol: false })).toBeNull();
  });
});
