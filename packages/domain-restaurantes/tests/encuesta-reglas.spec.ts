// Reglas de la encuesta post-entrega (seccion 6): horario, frecuencia, calificacion y la prohibicion de incentivar o
// condicionar la resena (bateria de textos buenos y malos).
import { describe, expect, it } from "vitest";
import {
  ENCUESTA_CALLBACK_MOTIVO_BAJA,
  accionSegunCalificacion,
  contieneIncentivoDeResena,
  decidirEnvioEncuesta,
  enHorasDeSilencio,
  textoInvitacionResenaGoogle,
  textoRecuperacionPrivada,
} from "../src/encuesta-reglas.ts";

const MERIDA = "America/Merida"; // UTC-6 todo el año
const utc = (iso: string) => new Date(iso);

describe("horario de envio", () => {
  it("entrega a las 14:00 locales -> envio a las 16:00 locales (2 h), dentro de la ventana", () => {
    const d = decidirEnvioEncuesta({ deliveredAt: utc("2026-10-06T20:00:00Z"), zonaHoraria: MERIDA, pedidoYaEncuestado: false, ultimaEncuestaCliente: null });
    expect(d).toEqual({ enviar: true, enviarDespuesDe: utc("2026-10-06T22:00:00Z"), fueraDeVentana: false });
  });

  it("entrega a las 22:00 locales (+2 h = 00:00): se pospone a las 9:00 locales y se marca fuera de la ventana de 3 h", () => {
    const d = decidirEnvioEncuesta({ deliveredAt: utc("2026-10-07T04:00:00Z"), zonaHoraria: MERIDA, pedidoYaEncuestado: false, ultimaEncuestaCliente: null });
    expect(d).toEqual({ enviar: true, enviarDespuesDe: utc("2026-10-07T15:00:00Z"), fueraDeVentana: true });
  });

  it("nunca se envia entre 23:00 y 9:00 locales: borde 22:59 si, 23:00 no, 8:59 no, 9:00 si", () => {
    expect(enHorasDeSilencio(utc("2026-10-07T04:59:00Z"), MERIDA)).toBe(false); // 22:59
    expect(enHorasDeSilencio(utc("2026-10-07T05:00:00Z"), MERIDA)).toBe(true); // 23:00
    expect(enHorasDeSilencio(utc("2026-10-07T14:59:00Z"), MERIDA)).toBe(true); // 8:59
    expect(enHorasDeSilencio(utc("2026-10-07T15:00:00Z"), MERIDA)).toBe(false); // 9:00
  });

  it("usa la zona de la organizacion, no la del servidor (UTC): las 16:00 UTC son 10:00 en Merida y 08:00 en Tijuana", () => {
    expect(enHorasDeSilencio(utc("2026-10-07T14:30:00Z"), MERIDA)).toBe(true);
    expect(enHorasDeSilencio(utc("2026-10-07T14:30:00Z"), "America/Tijuana")).toBe(true); // 7:30
    expect(enHorasDeSilencio(utc("2026-10-07T16:00:00Z"), "America/Tijuana")).toBe(false); // 9:00
  });
});

describe("una por pedido y una cada 14 dias por cliente", () => {
  const base = { deliveredAt: utc("2026-10-06T20:00:00Z"), zonaHoraria: MERIDA, pedidoYaEncuestado: false } as const;
  it("un pedido ya encuestado no se vuelve a encuestar", () => {
    expect(decidirEnvioEncuesta({ ...base, pedidoYaEncuestado: true, ultimaEncuestaCliente: null })).toEqual({ enviar: false, motivo: "pedido_ya_encuestado" });
  });
  it("cliente encuestado hace 13 dias: no; hace 14 dias: si", () => {
    expect(decidirEnvioEncuesta({ ...base, ultimaEncuestaCliente: utc("2026-09-23T22:30:00Z") })).toEqual({ enviar: false, motivo: "cliente_encuestado_recientemente" });
    expect(decidirEnvioEncuesta({ ...base, ultimaEncuestaCliente: utc("2026-09-22T22:00:00Z") })).toMatchObject({ enviar: true });
  });
});

describe("calificacion de 1 a 5", () => {
  it(">= 4 invita a resenar en Google", () => {
    for (const n of [4, 5]) expect(accionSegunCalificacion(n)).toEqual({ tipo: "invitar_resena_google", enviarAGoogle: true });
  });
  it("<= 3 abre recuperacion privada con callback encuesta_baja y aviso al gerente; NO va a Google", () => {
    for (const n of [1, 2, 3]) expect(accionSegunCalificacion(n)).toEqual({ tipo: "recuperacion_privada", enviarAGoogle: false, callbackMotivo: ENCUESTA_CALLBACK_MOTIVO_BAJA, avisarGerente: true });
  });
  it("fuera de 1-5 o no entero lanza", () => {
    for (const n of [0, 6, 3.5, Number.NaN, -1]) expect(() => accionSegunCalificacion(n)).toThrow(RangeError);
  });
});

describe("prohibido condicionar o incentivar la resena", () => {
  const MALOS = [
    "Si nos deja 5 estrellas le damos un postre gratis",
    "Deje 5 estrellas en Google y recibe un descuento",
    "Le regalamos una bebida a cambio de su reseña",
    "Participe en nuestro sorteo dejando una reseña",
    "Solo si nos califica con cinco estrellas",
    "Canjee este cupón después de reseñarnos",
    "Una reseña positiva nos ayuda; le damos 10% de descuento",
    "Gánese un premio por su opinión",
    "Cortesía de la casa por calificarnos",
  ];
  const BUENOS = [
    "Gracias por su calificación. Si lo desea, puede compartir su opinión sobre Pensiones en Google: https://g.page/r/abc/review",
    "Su opinión nos ayuda a mejorar. ¿Cómo calificaría su pedido del 1 al 5?",
    "Lamentamos que su pedido no haya sido como esperaba. Una persona le llamará para atenderle.",
    "Su pedido está en camino. Que lo disfrute.",
  ];
  it.each(MALOS)("detecta incentivo: %s", (texto) => expect(contieneIncentivoDeResena(texto)).toBe(true));
  it.each(BUENOS)("acepta texto limpio: %s", (texto) => expect(contieneIncentivoDeResena(texto)).toBe(false));

  it("los textos propios de la regla (invitacion y recuperacion) nunca contienen incentivo ni condicion", () => {
    const invitacion = textoInvitacionResenaGoogle({ nombreSucursal: "Pensiones", urlResenaGoogle: "https://g.page/r/abc/review" });
    expect(invitacion).toContain("https://g.page/r/abc/review");
    expect(contieneIncentivoDeResena(invitacion!)).toBe(false);
    expect(contieneIncentivoDeResena(textoRecuperacionPrivada("Pensiones"))).toBe(false);
  });

  it("la recuperacion privada no menciona Google ni resenas; sin link de Google (o no https) no se invita", () => {
    expect(textoRecuperacionPrivada("Pensiones")).not.toMatch(/google|reseñ|opinión pública/i);
    expect(textoInvitacionResenaGoogle({ nombreSucursal: "Pensiones", urlResenaGoogle: null })).toBeNull();
    expect(textoInvitacionResenaGoogle({ nombreSucursal: "Pensiones", urlResenaGoogle: "http://insegura" })).toBeNull();
  });
});
