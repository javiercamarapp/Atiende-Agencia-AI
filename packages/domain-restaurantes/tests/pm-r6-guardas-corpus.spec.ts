// QA-PM-R6-reglas-01/02/03/05: corpus ETIQUETADO (positivos y negativos) de las guardas con regex del turno de WhatsApp. Funciones puras: sin reloj, sin red.
// El ARCO («elimina mi número...», «dame acceso a mis datos») NO se cubre aqui: lo resuelve el PR #545 (detector recall-first).
import { describe, expect, it } from "vitest";
import { afirmaHaberAvisado, afirmaPedidoRegistrado, classifyHighRiskIntent, pideUnaPersona, type HighRiskContext } from "../src/whatsapp/guards.ts";

const preparando: HighRiskContext = { pedidoReciente: { estado: "preparando", canal: "whatsapp", sucursal: "García Lavín", confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: 5 } as never };
const entregado: HighRiskContext = { pedidoReciente: { estado: "entregado", canal: "whatsapp", sucursal: "García Lavín", confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: 90 } as never };

describe("afirmaHaberAvisado (R6-reglas-01)", () => {
  const SI = ["Ya notifiqué al equipo.", "Les notificamos al gerente de su queja.", "Ya le comuniqué al gerente su queja.", "Ya escalé su caso al equipo.", "Ya hablé con el gerente y le contesta.", "Dejé el recado con la encargada.", "Ya avisé al gerente, en minutos le contactan."];
  const NO = [
    "Si gusta, para que le comunique al gerente su queja.", "Quiere que le notifique al equipo?", "Para que escale su caso necesito su nombre.", "No le he comunicado al gerente.", "No le comuniqué nada al gerente.",
    "Hable con el gerente si gusta.", "Le aviso a la sucursal para que tenga listo su pedido.", "El pedido quedó registrado.", "Notificamos su pedido a cocina.", "Su cuenta se notifica por WhatsApp.",
  ];
  it.each(SI)("afirma aviso: %s", (t) => expect(afirmaHaberAvisado(t)).toBe(true));
  it.each(NO)("no afirma aviso: %s", (t) => expect(afirmaHaberAvisado(t)).toBe(false));
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("entrada no valida no lanza: %j", (v) => {
    expect(() => afirmaHaberAvisado(v as never)).not.toThrow();
  });
});

describe("classifyHighRiskIntent (R6-reglas-02/03)", () => {
  const POS: [string, string, HighRiskContext?][] = [
    ["me intoxiqué con sus tacos de ayer", "alergia_salud"], ["me dio diarrea después de comer ahí", "alergia_salud"], ["creo que la comida estaba en mal estado y vomité", "alergia_salud"],
    ["soy alérgico a los cacahuates, ¿el mole tiene?", "alergia_salud"],
    ["me cargaron dos veces en la tarjeta", "cobro_duplicado"], ["me hicieron un doble cargo", "cobro_duplicado"], ["me cobraron doble", "cobro_duplicado"],
    ["le faltó la salsa", "queja"], ["a mi pedido le faltaron las salsas", "queja"],
    ["llevo 2 horas esperando mi pedido", "urgencia"], ["llevo 45 minutos esperando mi pedido", "urgencia"],
    ["ya no quiero el pedido, cancélalo", "cancelacion_modificacion"], ["cancélame el pedido", "cancelacion_modificacion"],
    ["cámbiame el pedido a harina", "cancelacion_modificacion", preparando], ["quiero modificar mi pedido", "cancelacion_modificacion", preparando],
    ["quiero un asesor", "cliente_lo_pide"], ["necesito un asesor", "cliente_lo_pide"],
  ];
  const NEG: [string, HighRiskContext?][] = [
    ["no me gusta el picante"], ["¿cuánto cuesta la horchata?"], ["sin picante porfa, soy delicado del estómago"], ["quiero tacos sin cebolla"], ["el sabor me cayó muy bien"],
    ["¿cuánto cobran de envío?"], ["¿cobran la salsa?"], ["pago con tarjeta"], ["¿me cobran cargo por pagar con tarjeta?"],
    ["me faltó pedir una horchata"], ["me faltó agregar salsa"], ["le falta sal a la salsa de la foto?"],
    ["llevo 10 minutos esperando que me contesten el menú"], ["¿cuánto tarda?"], ["llevo 20 minutos esperando mi pedido"], ["necesito para urgente 3 tacos"],
    ["cámbiame el pedido a harina"], ["cámbiame el pedido a harina", entregado], ["¿puedo cambiar el pedido?", preparando], ["¿se puede cancelar el pedido?"], ["¿cancelan el 2x1 los lunes?"],
    ["el asesor de ayer fue amable"], ["no quiero hablar con un humano, tú atiéndeme"],
  ];
  it.each(POS)("%s -> %s", (t, intent, ctx) => expect(classifyHighRiskIntent(t, ctx ?? {})?.intent).toBe(intent));
  it.each(NEG)("%s -> sin motivo de alto riesgo", (t, ctx) => expect(classifyHighRiskIntent(t, ctx ?? {})).toBeNull());
  it("la intoxicacion no se contesta con la respuesta de ingredientes", () => {
    expect(classifyHighRiskIntent("me intoxiqué con sus tacos", {})?.reply).toMatch(/salud/i);
  });
  it.each(["quiero un asesor", "necesito un asesor", "pásame con un asesor"])("pideUnaPersona(%s)", (t) => expect(pideUnaPersona(t)).toBe(true));
  it.each(["el asesor de ayer fue amable", "quiero 3 tacos", "no quiero hablar con nadie"])("pideUnaPersona negativo (%s)", (t) => expect(pideUnaPersona(t)).toBe(false));
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("entrada no valida no lanza: %j", (v) => {
    expect(() => classifyHighRiskIntent(v as never, {})).not.toThrow();
  });
});

describe("afirmaPedidoRegistrado (R6-reglas-05)", () => {
  it.each(["Perfecto, ya tengo todo anotado.", "Quedó apartado.", "Su pedido quedó registrado.", "Ya lo mandé a cocina."])("afirma: %s", (t) => expect(afirmaPedidoRegistrado(t)).toBe(true));
  it.each(["¿Confirma su pedido?", "Su nombre quedó anotado.", "Su dirección quedó registrada.", "Si confirma, queda registrado.", "Ya tengo su nombre, ¿qué desea?", "Todavía no está confirmado su pedido."])("no afirma: %s", (t) =>
    expect(afirmaPedidoRegistrado(t)).toBe(false));
});
