// Port de las pruebas Deno de dedupe de avisos (fallos-medicion-1/2, fallos-pr18-aviso, fallos-post-c3 G6a/P2/R2/R3/R4/R7/R8/R9/R15,
// voz-respuestas/voz-turno de alta prioridad) y de niveles de alerta (alertas-niveles, alertas-operativas). En el suelto
// avisoYaCubierto leía la base y hacía el UPDATE; aquí `planDeAviso` es puro: «cubierto» = no insertar, «anexar» = el UPDATE
// que el llamador aplica. Las filas de «otro cliente» las filtra el llamador al leer (mismo número), igual que el .eq() del suelto.
import { describe, expect, it } from "vitest";
import * as a from "../src/whatsapp/cerebro-v2/avisos.ts";

type Fila = { id?: string; reason?: string | null; message?: string | null; branch_id?: string | null; created_at?: string | null; resolved?: boolean | null; customer_phone?: string };

/** Lo que hacía avisoYaCubierto con una base que acepta (o no) el UPDATE: true = no hay que insertar. Aplica el anexo a la fila. */
function yaCubierto(filas: Fila[], razon: string | null, ahoraMs: number, opciones: a.OpcionesAviso = {}, updateFalla = false): boolean {
  const plan = a.planDeAviso(filas, razon, ahoraMs, opciones);
  if (plan.accion === "registrar") return false;
  if (plan.accion === "cubierto") return true;
  if (updateFalla) return false;
  const fila = filas.find((f) => f.id === plan.fila.id);
  if (fila) fila.message = plan.message;
  return true;
}

const ahora = Date.parse("2026-10-16T19:30:00-06:00");
const hace = (min: number) => new Date(ahora - min * 60000).toISOString();
const TEL = "5219995550100";
const base = { customer_phone: TEL, resolved: false };
const delCliente = (filas: Fila[]) => filas.filter((f) => f.customer_phone === TEL);

describe("dedupe de avisos (ventana de 30 min)", () => {
  it("mismo motivo reciente y sin resolver = duplicado", () => {
    expect(a.hayAvisoAbierto([{ ...base, reason: "modificacion_pedido", created_at: hace(3) }], "modificacion_pedido", ahora)).toBe(true);
  });
  it("un alto riesgo abierto cubre un registrar_contacto del mismo cliente", () => {
    expect(a.hayAvisoAbierto([{ ...base, reason: "alto_riesgo:alergia", created_at: hace(2) }], "consulta por alergia a cacahuates", ahora)).toBe(true);
  });
  it("resuelto, viejo, de otro cliente o de otro motivo sin alto riesgo NO es duplicado", () => {
    const casos: Array<[string, Fila[]]> = [
      ["resuelto", [{ ...base, reason: "queja", created_at: hace(3), resolved: true }]],
      ["viejo", [{ ...base, reason: "queja", created_at: hace(600) }]],
      ["otro cliente", [{ ...base, reason: "queja", created_at: hace(3), customer_phone: "5219990000000" }]],
      ["otro motivo", [{ ...base, reason: "facturacion", created_at: hace(3) }]],
    ];
    for (const [n, filas] of casos) expect(a.hayAvisoAbierto(delCliente(filas), "queja", ahora), n).toBe(false);
  });
  it("sin filas leídas (la consulta falló) deja registrar", () => {
    expect(a.hayAvisoAbierto(null, "queja", ahora)).toBe(false);
    expect(a.planDeAviso(null, "queja", ahora).accion).toBe("registrar");
  });
  it("un alto riesgo DISTINTO sí se registra aunque haya otro abierto", () => {
    const filas = [{ ...base, reason: "alto_riesgo:alergia", created_at: hace(2) }];
    expect(a.hayAvisoAbierto(filas, "alto_riesgo:cobro_duplicado", ahora)).toBe(false);
    expect(a.hayAvisoAbierto(filas, "alto_riesgo:alergia", ahora)).toBe(true);
  });
  it("reason nulo o vacío nunca deduplica", () => {
    expect(a.hayAvisoAbierto([{ ...base, id: "a1", branch_id: "b1", reason: null, created_at: hace(2) }], null, ahora, { branchId: "b1" })).toBe(false);
    expect(a.hayAvisoAbierto([{ ...base, id: "a1", branch_id: "b1", reason: "  ", created_at: hace(2) }], "  ", ahora, { branchId: "b1" })).toBe(false);
  });
  it("un alto riesgo abierto NO cubre un tema distinto, solo la misma categoría", () => {
    const filas = [{ ...base, id: "a1", branch_id: "b1", reason: "alto_riesgo:alergia", created_at: hace(2) }];
    expect(a.hayAvisoAbierto(filas, "quiero factura", ahora, { branchId: "b1" })).toBe(false);
    expect(a.hayAvisoAbierto(filas, "se tardó mucho el pedido", ahora, { branchId: "b1" })).toBe(false);
    expect(a.hayAvisoAbierto(filas, "Alergia al cacahuate", ahora, { branchId: "b1" })).toBe(true);
  });
  it("otra sucursal no deduplica (null contra null sí)", () => {
    const filas = [{ ...base, id: "a1", branch_id: "b1", reason: "queja", created_at: hace(2) }];
    expect(a.hayAvisoAbierto(filas, "queja", ahora, { branchId: "b2" })).toBe(false);
    expect(a.hayAvisoAbierto(filas, "queja", ahora, { branchId: null })).toBe(false);
    expect(a.hayAvisoAbierto([{ ...base, id: "a2", branch_id: null, reason: "queja", created_at: hace(2) }], "queja", ahora, { branchId: null })).toBe(true);
  });
  it("ventana de 30 min: 29 cubre, 31 no", () => {
    expect(a.hayAvisoAbierto([{ ...base, id: "a1", branch_id: "b1", reason: "queja", created_at: hace(29) }], "queja", ahora, { branchId: "b1" })).toBe(true);
    expect(a.hayAvisoAbierto([{ ...base, id: "a1", branch_id: "b1", reason: "queja", created_at: hace(31) }], "queja", ahora, { branchId: "b1" })).toBe(false);
    expect(a.VENTANA_AVISO_DUPLICADO_MIN).toBe(30);
  });
  it("si el mensaje nuevo aporta texto distinto se anexa; el mismo texto no se repite", () => {
    const fila: Fila = { ...base, id: "a1", branch_id: "b1", reason: "queja", message: "llegó frío", created_at: hace(5) };
    expect(yaCubierto([fila], "queja", ahora, { branchId: "b1", message: "además faltó la salsa verde" })).toBe(true);
    expect(fila.message).toMatch(/llegó frío/);
    expect(fila.message).toMatch(/salsa verde/);
    yaCubierto([fila], "queja", ahora, { branchId: "b1", message: "LLEGÓ frío" });
    expect((String(fila.message).match(/llegó frío/gi) ?? []).length).toBe(1);
  });
  it("si no se puede anexar (falla el UPDATE), se registra el aviso", () => {
    const fila: Fila = { ...base, id: "a1", branch_id: "b1", reason: "queja", message: "llegó frío", created_at: hace(5) };
    expect(yaCubierto([fila], "queja", ahora, { branchId: "b1", message: "otra cosa" }, true)).toBe(false);
  });
});

describe("post-venta y tope de 2000", () => {
  const abierto = (reason: string, extra: Partial<Fila> = {}): Fila => ({ id: "a1", customer_phone: TEL, resolved: false, branch_id: "b1", message: "llegó sin salsas", reason, created_at: hace(4), ...extra });
  it.each(["seguimiento de pedido incompleto", "modificacion_pedido", "queja: reposición de faltantes"])("dos motivos de post-venta son un aviso y el motivo nuevo se anexa: %s", (nueva) => {
    const fila = abierto("pedido incompleto");
    expect(yaCubierto([fila], nueva, ahora, { branchId: "b1", message: "quiero las salsas hoy" })).toBe(true);
    expect(fila.message).toMatch(/quiero las salsas hoy/);
    expect(String(fila.message)).toContain(nueva);
  });
  it("lo que NO es post-venta, otra sucursal, resuelto o viejo sigue registrándose", () => {
    const casos: Array<[string, Fila, string, string | null]> = [
      ["otro tema", abierto("pedido incompleto"), "necesito factura", "b1"],
      ["otra sucursal", abierto("pedido incompleto"), "seguimiento de pedido incompleto", "b2"],
      ["resuelto", abierto("pedido incompleto", { resolved: true }), "seguimiento de pedido incompleto", "b1"],
      ["viejo", abierto("pedido incompleto", { created_at: hace(45) }), "seguimiento de pedido incompleto", "b1"],
      ["alto riesgo", abierto("pedido incompleto"), "alto_riesgo:cobro_duplicado", "b1"],
      ["evento", abierto("pedido incompleto"), "cotización de taquiza para evento", "b1"],
    ];
    for (const [n, fila, razon, br] of casos) expect(a.hayAvisoAbierto([fila], razon, ahora, { branchId: br }), n).toBe(false);
  });
  it("cobro, alergia, intoxicación y reembolso generan aviso propio aunque haya un post-venta abierto", () => {
    for (const nueva of ["me cobraron de más", "cargo no reconocido en mi tarjeta", "mi hijo es alérgico y se enfermó", "intoxicación por los tacos", "quiero reembolso", "faltante y solicitud de reembolso"]) {
      const fila = abierto("pedido incompleto");
      expect(yaCubierto([fila], nueva, ahora, { branchId: "b1", message: "x" }), nueva).toBe(false);
      expect(fila.message).toBe("llegó sin salsas");
    }
    expect(yaCubierto([abierto("solicitud de reembolso")], "seguimiento de pedido incompleto", ahora, { branchId: "b1", message: "x" })).toBe(false);
  });
  it("al anexar, el tope de 2000 recorta lo VIEJO y conserva el motivo nuevo; si lo nuevo no cabe, aviso nuevo", () => {
    const fila = abierto("pedido incompleto", { message: "a".repeat(1990) });
    expect(yaCubierto([fila], "seguimiento de pedido incompleto", ahora, { branchId: "b1", message: "quiero las salsas HOY" })).toBe(true);
    const msg = String(fila.message);
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toMatch(/seguimiento de pedido incompleto/);
    expect(msg).toMatch(/quiero las salsas HOY/);
    const f2 = abierto("pedido incompleto", { message: "viejo" });
    expect(yaCubierto([f2], "seguimiento de pedido incompleto", ahora, { branchId: "b1", message: "z".repeat(2100) })).toBe(false);
    expect(f2.message).toBe("viejo");
  });
  it("PR18 P1-C: el motivo del reclamo se funde con «pedido incompleto»; un cobro duplicado abierto no lo absorbe", () => {
    const ahora2 = Date.parse("2026-11-02T18:00:00Z");
    const fila = (reason: string): Fila => ({ id: "a1", reason, message: "pedido incompleto", branch_id: "b1", resolved: false, created_at: new Date(ahora2 - 5 * 60000).toISOString() });
    const plan = a.planDeAviso([fila("pedido incompleto")], a.RAZON_RECLAMO_PEDIDO, ahora2, { branchId: "b1", message: "me llegó incompleto, faltó la coca" });
    expect(plan.accion).toBe("anexar");
    if (plan.accion === "anexar") {
      expect(plan.message).toMatch(/faltó la coca/);
      expect(plan.message).toMatch(/pedido incompleto/);
    }
    expect(a.planDeAviso([fila("alto_riesgo:cobro_duplicado")], a.RAZON_RECLAMO_PEDIDO, ahora2, { branchId: "b1", message: "me llegó incompleto, faltó la coca" }).accion).toBe("registrar");
  });
  it("R15-11: al anexar a un aviso creado urgente se quedan la línea URGENTE y una cola de lo viejo", () => {
    const viejo = `URGENTE: el cliente pide atención inmediata.\nme cobraron dos veces. ${"detalle del cargo; ".repeat(60)}FIN-DE-LO-VIEJO`;
    const fila: Fila = { id: "u1", branch_id: "b1", resolved: false, reason: "alto_riesgo:cobro_duplicado", message: viejo, created_at: "2026-11-03T18:00:00Z" };
    const nuevo = `INICIO-DE-LO-NUEVO ${"sigo esperando la devolucion del cobro doble; ".repeat(42)}FIN-DE-LO-NUEVO`;
    expect(nuevo.length).toBeGreaterThan(1900);
    expect(yaCubierto([fila], "alto_riesgo:cobro_duplicado", Date.parse("2026-11-03T18:05:00Z"), { branchId: "b1", message: nuevo })).toBe(true);
    const msg = String(fila.message);
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg.startsWith("URGENTE: el cliente pide atención inmediata.\n")).toBe(true);
    expect(msg).toMatch(/FIN-DE-LO-VIEJO/);
    expect(msg).toMatch(/INICIO-DE-LO-NUEVO/);
    expect(msg.endsWith("FIN-DE-LO-NUEVO")).toBe(true);
  });
});

describe("cobro duplicado abierto: lista blanca (G6a, P2, R2, R3, R4, R7)", () => {
  const ahora3 = Date.parse("2026-11-02T18:00:00Z");
  const intento = (razon: string, message: string, branchId: string | null = "b1") => {
    const fila: Fila = { id: "a1", reason: "alto_riesgo:cobro_duplicado", message: "me cobraron dos veces", branch_id: branchId, resolved: false, created_at: new Date(ahora3 - 2 * 60000).toISOString() };
    return yaCubierto([fila], razon, ahora3, { branchId, message });
  };
  const REC = a.RAZON_RECLAMO_PEDIDO;
  it("G6a: el reclamo del mismo cobro se anexa; facturación, faltante o alergia no", () => {
    expect(intento(REC, "me cobraron dos veces en la tarjeta")).toBe(true);
    expect(intento("facturación", "necesito la factura del cobro duplicado")).toBe(false);
    expect(intento(REC, "me llegó incompleto, faltó la coca")).toBe(false);
    expect(intento("alto_riesgo:alergia", "soy alérgico al cacahuate")).toBe(false);
  });
  it("P2: no absorbe facturación, RFC, repartidor ni cargo de envío", () => {
    expect(intento(REC, "me cobraron dos veces en la tarjeta")).toBe(true);
    expect(intento(REC, "el cargo duplicado sigue sin aparecer reversado")).toBe(true);
    expect(intento("facturación", "necesito la factura del cobro duplicado")).toBe(false);
    expect(intento("facturación", "mi RFC es XAXX010101000, me cobraron doble")).toBe(false);
    expect(intento(REC, "el repartidor tardó y además me cobraron doble")).toBe(false);
    expect(intento(REC, "faltó la coca y me cobraron cargo de envío")).toBe(false);
    expect(intento(REC, "quiero reembolso porque llegó frío")).toBe(false);
  });
  it.each(["solicitud de factura", "RFC para factura", "repartidor llegó tarde", "faltante: faltó la coca", "cancelación del pedido", "modificación de pedido"])("R2-1: motivo «%s» tiene su propio aviso", (razon) => {
    expect(intento(razon, "me cobraron doble")).toBe(false);
  });
  it("R2-1: el reclamo genérico y un motivo que es el mismo cobro se anexan", () => {
    expect(intento(REC, "me cobraron dos veces en la tarjeta")).toBe(true);
    expect(intento("cobro doble", "me cobraron doble")).toBe(true);
  });
  it("R3-5: cancelar/modificar solo separa si está en el MOTIVO; «no llegó completo» abre aviso", () => {
    for (const msg of ["me cobraron dos veces, yo no cancelé el pedido", "me cobraron dos veces, cancelen uno", "me cobraron dos veces, ¿pueden modificar el cargo?"]) expect(intento("reclamo de cobro", msg), msg).toBe(true);
    for (const msg of ["me cobraron dos veces y no llegó el pedido completo", "me cobraron dos veces y no me llegó completo", "me cobraron dos veces y llegó incompleto", "me cobraron dos veces y faltó la coca"]) expect(intento("reclamo de cobro", msg), msg).toBe(false);
    for (const razon of ["modificación de pedido", "cancelación del pedido", "facturación"]) expect(intento(razon, "me cobraron dos veces"), razon).toBe(false);
    expect(intento("reclamo de cobro", "me cobraron dos veces, el repartidor no llegó")).toBe(false);
    expect(intento("reclamo de cobro", "me cobraron dos veces y el cargo de envio tambien")).toBe(false);
    expect(intento(REC, "me cobraron dos veces")).toBe(true);
  });
  it.each([
    ["reclamo de cobro", "me cobraron dos veces, yo no cancelé el pedido"],
    ["reclamo de cobro", "me cobraron dos veces, cancelen uno"],
    ["cobro duplicado", "me cobraron dos veces, cancelen uno"],
    ["reclamo de cobro", "me cobraron dos veces, por favor revisen"],
    ["reclamo de cobro", "me cobraron dos veces, la tarjeta, lo revisan por favor"],
    ["reclamo de cobro", "me cobraron 2 cargos"],
    ["reclamo de cobro", "oigan, me hicieron doble cargo, urgente"],
    ["reclamo de cobro", "me cobraron dos veces, ¿pueden modificar el cargo?"],
    ["cobro doble", "me cobraron doble"],
    [REC, "me cobraron dos veces"],
    [REC, "me cobraron dos veces en la tarjeta"],
    [REC, "el cargo duplicado sigue sin aparecer reversado"],
  ])("R4-B1: se anexa: razón «%s» / «%s»", (razon, msg) => {
    expect(intento(razon, msg)).toBe(true);
  });
  it.each([
    ["reclamo de pedido", "me cobraron dos veces, me dieron de menos"],
    ["reclamo de pedido", "me cobraron dos veces, me mandaron otra cosa"],
    ["reclamo de pedido", "me cobraron dos veces, tardó una hora"],
    ["reclamo de cobro", "me cobraron dos veces, tardó una hora"],
    ["reclamo de cobro", "me cobraron dos veces, mi mensajero no llegó"],
    ["reclamo de cobro", "me cobraron dos veces, el chofer fue grosero"],
    ["reclamo de cobro", "me cobraron dos veces y el motorista no traía cambio"],
    ["reclamo de cobro", "me cobraron dos veces, el delivery"],
    ["reclamo de cobro", "me cobraron dos veces, quiero cambiar el pedido"],
    ["reclamo de cobro", "me cobraron dos veces, quiero quitar un taco"],
    ["reclamo de cobro", "me cobraron dos veces, agreguen una coca"],
    ["reclamo de cobro", "me cobraron dos veces, anulen el pedido"],
    ["reclamo de cobro", "me cobraron dos veces y la entrega a domicilio no llegó"],
    ["modificacion", "me cobraron dos veces y quiero modificar"],
    ["modificacion de pedido", "me cobraron dos veces y quiero modificar"],
    ["cobro de envio", "me cobraron dos veces el envio"],
    ["cobro duplicado", "me cobraron dos veces, mi mensajero no llegó"],
    ["reclamo de cobro", "me cobraron dos veces y no llegó el pedido completo"],
    ["facturacion", "necesito factura del cobro duplicado"],
    ["reclamo de cobro", "me cobraron dos veces y el cargo de envio tambien"],
    ["reclamo de cobro", "me cobraron dos veces, el repartidor no llegó"],
    [REC, "me cobraron dos veces y faltó la coca"],
  ])("R4-B2: aviso NUEVO: razón «%s» / «%s»", (razon, msg) => {
    expect(intento(razon, msg)).toBe(false);
  });
  it("R7-5b: la marca URGENTE no impide anexar el mismo cobro", () => {
    expect(intento(REC, "URGENTE: el cliente pide atención inmediata.\nme cobraron dos veces", null)).toBe(true);
  });
});

describe("prioridad y nivel de aviso", () => {
  it("alta prioridad: alto riesgo, cancelación, modificación, confirmar_peso; posible_baja_pedido no", () => {
    expect(a.esAvisoDeAltaPrioridad("confirmar_peso")).toBe(true);
    expect(a.esAvisoDeAltaPrioridad("alto_riesgo:cancelacion")).toBe(true);
    expect(a.esAvisoDeAltaPrioridad(a.RAZON_POSIBLE_CANCELACION_VOZ)).toBe(false);
    expect(a.esAvisoDeAltaPrioridad("modificacion_pedido")).toBe(true);
    expect(a.esAvisoDeAltaPrioridad("pedido incompleto")).toBe(false);
    expect(a.esAvisoDeAltaPrioridad(null)).toBe(false);
  });
  it("nivelDeAviso: urgente (alergia, salud, urgencia o marca), alta (resto de alta prioridad), normal", () => {
    expect(a.nivelDeAviso("alto_riesgo:alergia")).toBe("urgente");
    expect(a.nivelDeAviso("intoxicación por los tacos")).toBe("urgente");
    expect(a.nivelDeAviso("alto_riesgo:urgencia")).toBe("urgente");
    expect(a.nivelDeAviso("pedido incompleto", { mensaje: `${a.MARCA_AVISO_URGENTE}\nno llega` })).toBe("urgente");
    expect(a.nivelDeAviso("pedido incompleto", { urgente: true })).toBe("urgente");
    expect(a.nivelDeAviso("alto_riesgo:cobro_duplicado")).toBe("alta");
    expect(a.nivelDeAviso("modificacion_pedido")).toBe("alta");
    expect(a.nivelDeAviso("confirmar_peso")).toBe("alta");
    expect(a.nivelDeAviso("pedido incompleto")).toBe("normal");
    expect(a.nivelDeAviso(a.RAZON_POSIBLE_BAJA)).toBe("normal");
  });
  it("«papá» es un familiar, no las papas", () => {
    expect(a.normAviso("lo de mi papá cancélenmelo")).toBe("lo de mi tata cancelenmelo");
    expect(a.normAviso("mis papas no llegaron")).toBe("mis papas no llegaron");
  });
});

describe("llaves de la ráfaga", () => {
  it("una sola: la llave del evento; varias: llave#slug sin repetir; sin llave: null", () => {
    expect(a.llavesDeAvisos("wamid-1", ["alto_riesgo:alergia"])).toEqual(["wamid-1"]);
    expect(a.llavesDeAvisos("wamid-1", ["alto_riesgo:cobro_duplicado", "Reclamo de pedido: faltante", "alto_riesgo:cobro_duplicado"])).toEqual([
      "wamid-1#alto_riesgo-cobro_duplicado",
      "wamid-1#reclamo-de-pedido-faltante",
      "wamid-1#alto_riesgo-cobro_duplicado-2",
    ]);
    expect(a.llavesDeAvisos(null, ["a", "b"])).toEqual([null, null]);
  });
  it("motivosYaRegistrados: reconoce la llave sola (mismo motivo) y la llave#slug", () => {
    const filas = [{ source_event_id: "w1", reason: "alto_riesgo:alergia" }, { source_event_id: "w1#queja", reason: "queja" }];
    expect([...a.motivosYaRegistrados(filas, "w1", ["alto_riesgo:alergia", "queja", "alto_riesgo:salud"])]).toEqual(["alto_riesgo:alergia", "queja"]);
    expect(a.motivosYaRegistrados(null, "w1", ["queja"]).size).toBe(0);
    expect(a.llavesAConsultar("w1", ["queja"])).toEqual(["w1", "w1#queja"]);
  });
});

describe("respuesta de varios avisos (R8-3, R9-6, R25-5)", () => {
  const ejemplos: Record<a.IntentAviso, string> = {
    transferencia_realizada: "ya les transferí",
    cancelacion: "cancela mi pedido",
    cobro_duplicado: "me cobraron dos veces",
    alergia: "soy alérgico al cacahuate",
    salud: "me cayó mal la comida",
    privacidad_arco: "quiero borrar mis datos",
    reclamo_pedido: "me faltó la coca",
    urgencia: "es urgente",
  };
  it("FRASES_OBLIGATORIAS_DE_AVISO trae lo que exige la política", () => {
    const exigidas: Record<string, RegExp[]> = {
      alergia: [/no puedo garantizarle ingredientes ni que un platillo esté libre de algún alérgeno/, /antes de tomar su pedido/],
      salud: [/no puedo diagnosticar ni garantizar nada sobre ingredientes/, /busque atención médica/],
      cancelacion: [/se cancela sin cargo/, /la sucursal le confirma qué se puede hacer/],
    };
    for (const [intent, res] of Object.entries(exigidas)) {
      for (const re of res) expect((a.FRASES_OBLIGATORIAS_DE_AVISO[intent as a.IntentAviso] ?? []).some((f) => re.test(f)), `${intent} ${re}`).toBe(true);
    }
  });
  it("la respuesta de varios avisos conserva TODAS las frases obligatorias de cada riesgo", () => {
    const intents = Object.keys(ejemplos).filter((k) => k !== "urgencia") as a.IntentAviso[];
    for (const intent of intents) {
      for (const otro of intents) {
        if (otro === intent) continue;
        const varios = a.respuestaDeVariosAvisos([{ match: { intent: otro }, textos: [ejemplos[otro]] }, { match: { intent }, textos: [ejemplos[intent]] }]);
        for (const frase of a.FRASES_OBLIGATORIAS_DE_AVISO[intent] ?? []) expect(varios, `${otro}+${intent}`).toContain(frase);
      }
    }
  });
  it("R9-6: frasesDeVariosAvisos sale de la misma tabla y la respuesta termina con ellas", () => {
    for (const intent of ["alergia", "salud", "cancelacion"] as const) {
      const enVarios = a.frasesDeVariosAvisos(intent);
      const obligatorias = a.FRASES_OBLIGATORIAS_DE_AVISO[intent] ?? [];
      expect(enVarios.length).toBe(obligatorias.length);
      obligatorias.forEach((f, i) => expect(enVarios[i]).toContain(f));
      const varios = a.respuestaDeVariosAvisos([{ match: { intent: "cobro_duplicado" }, textos: ["me cobraron dos veces"] }, { match: { intent }, textos: [ejemplos[intent]] }]);
      expect(varios.endsWith(enVarios.join(" "))).toBe(true);
    }
  });
  it("nombra cada aviso: cobro doble y faltante; urgente cambia el arranque", () => {
    const r = a.respuestaDeVariosAvisos([{ match: { intent: "cobro_duplicado" }, textos: ["me cobraron dos veces"] }, { match: { intent: "reclamo_pedido" }, textos: ["no me llegó la coca"] }]);
    expect(r).toBe("Lamento lo que pasó. Ya avisé a la sucursal del cobro doble y de lo que faltó; una persona revisará cada caso y lo contactará.");
    const u = a.respuestaDeVariosAvisos([{ match: { intent: "cobro_duplicado" }, textos: ["x"], urgente: true }, { match: { intent: "reclamo_pedido" }, textos: ["mi pedido no ha llegado"] }]);
    expect(u.startsWith("Entendido, es urgente. Ya avisé a la sucursal del cobro doble y de la demora")).toBe(true);
  });
  it("R8-4: respuestaUrgente dice «Entendido» una sola vez", () => {
    const r = a.respuestaUrgente("Entendido, ya avisé a la sucursal de su cancelación.");
    expect(r).toBe("Entendido, es urgente. Ya avisé a la sucursal de su cancelación.");
    expect((r.match(/Entendido/g) ?? []).length).toBe(1);
  });
});

describe("niveles de alerta y escalada (alertas-niveles, alertas-operativas)", () => {
  const AHORA = new Date("2026-11-05T12:00:00Z");
  const haceMin = (m: number) => new Date(AHORA.getTime() - m * 60_000);
  function falso(pedidos: a.PedidoPorAprobar[], chats: a.ChatSinRespuesta[] = [], activacion: Date | null | undefined = undefined, ahoraBase = AHORA) {
    const outbox = new Map<string, a.AlertaEncolable>();
    const consultas: Array<{ que: string; antesDe: Date; despuesDe: Date; minutos?: number }> = [];
    const adaptador: a.AlertasAdaptador = {
      pedidosPorAprobar: (antesDe, despuesDe) => { consultas.push({ que: "pedidos", antesDe, despuesDe }); return Promise.resolve(pedidos); },
      chatsSinRespuestaHumana: (antesDe, despuesDe, minutos) => { consultas.push({ que: "chats", antesDe, despuesDe, minutos }); return Promise.resolve(chats); },
      encolar(al) { if (!outbox.has(al.dedupe_key)) outbox.set(al.dedupe_key, al); return Promise.resolve(); },
      yaEncoladas: (llaves) => Promise.resolve(new Set(llaves.filter((k) => outbox.has(k)))),
      activacion: () => Promise.resolve(activacion === undefined ? new Date(ahoraBase.getTime() - 48 * 3_600_000) : activacion),
    };
    return { adaptador, outbox, consultas };
  }
  const cfg = a.configDesde({ por_aprobar_min: 10, chat_min: 10 });

  it("10 min = aviso, 20 = recordatorio, 30 = escalada; sin hora = solo nivel 1", () => {
    const n = (min: number | null) => a.nivelDebido(min === null ? null : haceMin(min), AHORA, 10);
    expect([n(10), n(19), n(20), n(29), n(30), n(500), n(null)]).toEqual([1, 1, 2, 2, 3, 3, 1]);
  });
  it("nivel 1 conserva la llave de siempre; 2 y 3 llevan sufijo", () => {
    expect(a.llaveConNivel("alerta:por_aprobar:o1", 1)).toBe("alerta:por_aprobar:o1");
    expect(a.llaveConNivel("alerta:por_aprobar:o1", 2)).toBe("alerta:por_aprobar:o1:n2");
    expect(a.llaveConNivel("alerta:por_aprobar:o1", 3)).toBe("alerta:por_aprobar:o1:n3");
  });
  it("un pedido que sigue esperando: aviso, recordatorio, escalada, sin duplicar", async () => {
    const { adaptador, outbox } = falso([]);
    const corre = (min: number) => {
      adaptador.pedidosPorAprobar = () => Promise.resolve([{ id: "o1", restaurant_id: "r1", branch_id: "T7", desde: haceMin(min) }]);
      return a.correrAlertas(adaptador, AHORA, cfg);
    };
    await corre(11);
    await corre(12);
    expect([...outbox.keys()]).toEqual(["alerta:por_aprobar:o1"]);
    await corre(21);
    expect(outbox.has("alerta:por_aprobar:o1:n2")).toBe(true);
    await corre(31);
    await corre(45);
    expect(outbox.size).toBe(3);
    expect(outbox.get("alerta:por_aprobar:o1:n3")?.payload.nivel).toBe(3);
  });
  it("tras una caída solo sale el nivel vigente", async () => {
    const { adaptador, outbox } = falso([{ id: "o9", restaurant_id: "r1", branch_id: null, desde: haceMin(40) }]);
    await a.correrAlertas(adaptador, AHORA, cfg);
    expect([...outbox.keys()]).toEqual(["alerta:por_aprobar:o9:n3"]);
  });
  it("el chat lleva sucursal y nivel; la clave del correo distingue el nivel", async () => {
    const { adaptador, outbox } = falso([], [{ clave: "conv:c1:123", restaurant_id: "r1", branch_id: "GAL", desde: haceMin(22) }]);
    await a.correrAlertas(adaptador, AHORA, cfg);
    const al = outbox.get("alerta:chat:conv:c1:123:n2");
    expect(al?.payload).toMatchObject({ branch_id: "GAL", nivel: 2, clave: "conv:c1:123:n2" });
  });
  it("R30-4: posible_baja_pedido sale una vez (nivel 1) y no recuerda ni escala", async () => {
    const { adaptador, outbox } = falso([]);
    for (const min of [11, 21, 35]) {
      adaptador.chatsSinRespuestaHumana = () => Promise.resolve([{ clave: "cb:p1", restaurant_id: "r1", branch_id: "T7", desde: haceMin(min), soloPrimerAviso: true }]);
      await a.correrAlertas(adaptador, AHORA, cfg);
    }
    expect([...outbox.keys()]).toEqual(["alerta:chat:cb:p1"]);
    const tarde = falso([], [{ clave: "cb:p2", restaurant_id: "r1", branch_id: "T7", desde: haceMin(45), soloPrimerAviso: true }]);
    await a.correrAlertas(tarde.adaptador, AHORA, cfg);
    expect([...tarde.outbox.keys()]).toEqual(["alerta:chat:cb:p2"]);
    expect(a.MOTIVOS_UN_SOLO_AVISO.has("posible_baja_pedido")).toBe(true);
  });
  it("configuración: minutos por omisión 10; solo enteros de 1 a 1440; el cuerpo manda sobre el entorno", () => {
    expect(a.configDesde(null).porAprobarMin).toBe(10);
    expect(a.configDesde(undefined).chatMin).toBe(10);
    expect(a.normalizarMinutos("15")).toBe(15);
    expect(a.normalizarMinutos(15)).toBe(15);
    for (const malo of [0, -3, 1.5, 1441, "abc", null, NaN]) expect(a.normalizarMinutos(malo)).toBe(10);
    const c = a.configDesde({ por_aprobar_min: 5 }, { porAprobar: "20", chat: "30" });
    expect([c.porAprobarMin, c.chatMin]).toEqual([5, 30]);
  });
  it("tope por omisión 10, acotado 1..100; desde ISO o null", () => {
    expect(a.configDesde(null).maxCorreos).toBe(10);
    expect(a.configDesde({ max_correos: 3 }).maxCorreos).toBe(3);
    expect(a.configDesde(null, { maxCorreos: "20" }).maxCorreos).toBe(20);
    for (const malo of [0, 101, "x", 2.5]) expect(a.configDesde({ max_correos: malo }).maxCorreos).toBe(10);
    expect(a.configDesde({ desde: "2026-11-01T00:00:00Z" }).desde?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(a.configDesde({ desde: "no-es-fecha" }).desde).toBeNull();
  });
  const AH = new Date("2026-11-04T19:00:00-06:00");
  it("pedido por aprobar vencido: UNA alerta con la llave del pedido; corte y ventana de 24 h", async () => {
    const { adaptador, outbox, consultas } = falso([{ id: "ord-1", restaurant_id: "rest-1" }], [], undefined, AH);
    const r = await a.correrAlertas(adaptador, AH, { porAprobarMin: 10, chatMin: 10 });
    expect([r.por_aprobar, r.chats_sin_respuesta]).toEqual([1, 0]);
    const q = consultas.find((c) => c.que === "pedidos");
    expect(q?.antesDe.getTime()).toBe(AH.getTime() - 10 * 60_000);
    expect(q?.despuesDe.getTime()).toBe(AH.getTime() - 24 * 3_600_000);
    expect(outbox.get("alerta:por_aprobar:ord-1")).toMatchObject({ restaurant_id: "rest-1", payload: { evento: "por_aprobar_vencido", order_id: "ord-1", minutos: 10 } });
  });
  it("el umbral se respeta en ambos tipos", async () => {
    const { adaptador, consultas } = falso([], [], undefined, AH);
    await a.correrAlertas(adaptador, AH, { porAprobarMin: 3, chatMin: 25 });
    expect(consultas.find((c) => c.que === "pedidos")?.antesDe.getTime()).toBe(AH.getTime() - 3 * 60_000);
    const chats = consultas.find((c) => c.que === "chats");
    expect(chats?.antesDe.getTime()).toBe(AH.getTime() - 25 * 60_000);
    expect(chats?.minutos).toBe(25);
  });
  it("chats sin respuesta: una alerta por chat, sin teléfono ni texto; idempotente; vacío no encola", async () => {
    const { adaptador, outbox } = falso([{ id: "ord-1", restaurant_id: "rest-1" }], [{ clave: "cb:7", restaurant_id: "rest-1" }, { clave: "conv:abc:1793000000000", restaurant_id: "rest-1" }], undefined, AH);
    const r = await a.correrAlertas(adaptador, AH, { porAprobarMin: 10, chatMin: 10 });
    expect(r.chats_sin_respuesta).toBe(2);
    expect(outbox.get("alerta:chat:cb:7")?.payload).toMatchObject({ alerta: "chat_sin_respuesta", cantidad: 1, minutos: 10 });
    expect(JSON.stringify([...outbox.values()])).not.toMatch(/phone|telefono|message|body|\+52/i);
    await a.correrAlertas(adaptador, new Date(AH.getTime() + 5 * 60_000), { porAprobarMin: 10, chatMin: 10 });
    expect(outbox.size).toBe(3);
    const vacio = falso([], [], undefined, AH);
    const rv = await a.correrAlertas(vacio.adaptador, AH, { porAprobarMin: 10, chatMin: 10 });
    expect([rv.por_aprobar, rv.chats_sin_respuesta, vacio.outbox.size]).toEqual([0, 0, 0]);
  });
  it("P1: el piso de fecha recorta la ventana; cfg.desde manda; sin activación falla cerrado", async () => {
    const activacion = new Date(AH.getTime() - 2 * 3_600_000);
    const uno = falso([], [], activacion, AH);
    const r = await a.correrAlertas(uno.adaptador, AH, { porAprobarMin: 10, chatMin: 10 });
    expect(uno.consultas.every((c) => c.despuesDe.getTime() === activacion.getTime())).toBe(true);
    expect(r.piso).toBe(activacion.toISOString());
    const desde = new Date(AH.getTime() - 30 * 60_000);
    const dos = falso([], [], activacion, AH);
    await a.correrAlertas(dos.adaptador, AH, { porAprobarMin: 10, chatMin: 10, desde });
    expect(dos.consultas.every((c) => c.despuesDe.getTime() === desde.getTime())).toBe(true);
    const tres = falso([], [], null, AH);
    const r3 = await a.correrAlertas(tres.adaptador, AH, { porAprobarMin: 10, chatMin: 10 });
    expect(tres.consultas.every((c) => c.despuesDe.getTime() === AH.getTime())).toBe(true);
    expect(r3.piso).toBe(AH.toISOString());
  });
  it("P1: tope de correos; el exceso va en UN resumen por restaurante y se drena después", async () => {
    const pedidos = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, restaurant_id: i < 20 ? "rest-1" : "rest-2" }));
    const { adaptador, outbox } = falso(pedidos, [], undefined, AH);
    const r = await a.correrAlertas(adaptador, AH, { porAprobarMin: 10, chatMin: 10, maxCorreos: 10 });
    expect([r.enviadas, r.resumidas]).toEqual([10, 15]);
    const resumenes = [...outbox.values()].filter((x) => x.payload.alerta === "resumen");
    expect(resumenes).toHaveLength(2);
    expect(resumenes.reduce((n, x) => n + Number(x.payload.cantidad), 0)).toBe(15);
    expect(outbox.size).toBe(12);
    const d = falso(Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, restaurant_id: "rest-1" })), [], undefined, AH);
    const c2 = { porAprobarMin: 10, chatMin: 10, maxCorreos: 10 };
    const runs = [await a.correrAlertas(d.adaptador, AH, c2), await a.correrAlertas(d.adaptador, new Date(AH.getTime() + 5 * 60_000), c2), await a.correrAlertas(d.adaptador, new Date(AH.getTime() + 10 * 60_000), c2)];
    expect(runs.map((x) => x.enviadas)).toEqual([10, 10, 5]);
    expect([...d.outbox.keys()].filter((k) => k.startsWith("alerta:por_aprobar:"))).toHaveLength(25);
  });
  it("alerta inmediata nivel 1 con la llave del cron y urgente aparte, idempotentes", async () => {
    const { adaptador, outbox } = falso([]);
    expect(await a.encolarAlertaInmediata(adaptador, { id: "c0", restaurant_id: "r1", branch_id: "b1" })).toBe(true);
    expect(await a.encolarAlertaInmediata(adaptador, { id: "c0", restaurant_id: "r1" })).toBe(false);
    expect(await a.encolarAlertaUrgenteDeAviso(adaptador, { id: "c0", restaurant_id: "r1" }, "bloqueo-alergia")).toBe(true);
    expect(await a.encolarAlertaUrgenteDeAviso(adaptador, { id: "c0", restaurant_id: "r1" }, "bloqueo-alergia")).toBe(false);
    expect([...outbox.keys()]).toEqual(["alerta:chat:cb:c0", "alerta:chat:cb:c0:urgente:bloqueo-alergia"]);
  });

  const equipo: a.MiembroAlerta[] = [
    { role: "owner", notify: true, email: "dueno@pm.test" },
    { role: "admin", branch_id: "T7", notify: true, email: "gerente.t7@pm.test" },
    { role: "staff", branch_id: "T7", notify: true, email: "caja.t7@pm.test" },
    { role: "staff", branch_id: "GAL", notify: true, email: "caja.gal@pm.test" },
    { role: "admin", branch_id: null, notify: true, email: "general@pm.test" },
    { role: "repartidor", branch_id: "T7", notify: true, email: "reparto@pm.test" },
    { role: "staff", branch_id: "T7", notify: false, email: "apagado@pm.test" },
  ];
  it("ruteo: niveles 1 y 2 solo a la sucursal (+ gerente general)", () => {
    for (const nivel of [1, 2]) {
      const r = a.destinatariosAlerta(equipo, "T7", nivel);
      expect(r.correos.sort()).toEqual(["caja.t7@pm.test", "general@pm.test", "gerente.t7@pm.test"]);
      expect(r.fallbackDueno).toBe(false);
    }
  });
  it("ruteo: el tercer aviso suma al dueño; nunca repartidores ni avisos apagados", () => {
    const r = a.destinatariosAlerta(equipo, "T7", 3);
    expect(r.correos).toContain("dueno@pm.test");
    expect(r.correos).toContain("caja.t7@pm.test");
    for (const no of ["reparto@pm.test", "apagado@pm.test", "caja.gal@pm.test"]) expect(r.correos).not.toContain(no);
  });
  it("ruteo: sucursal sin personal cae al dueño", () => {
    const [dueno, , , gal] = equipo;
    const solo = a.destinatariosAlerta([dueno as a.MiembroAlerta, gal as a.MiembroAlerta], "T7", 1);
    expect(solo).toEqual({ correos: ["dueno@pm.test"], fallbackDueno: true });
    expect(a.destinatariosAlerta(equipo, null, 1).correos).toEqual(["general@pm.test"]);
    expect(a.destinatariosAlerta([], "T7", 3).correos).toHaveLength(0);
  });
  it("ruteo: prefijo del asunto y nivel normalizado", () => {
    expect(a.prefijoNivel(1)).toBe("");
    expect(a.prefijoNivel(2)).toContain("RECORDATORIO");
    expect(a.prefijoNivel(3)).toContain("ESCALADA");
    expect([a.nivelDeAlerta(undefined), a.nivelDeAlerta(7), a.nivelDeAlerta(2)]).toEqual([1, 1, 2]);
  });
});
