// F4b -- reglas puras del ciclo operativo del pedido: tiempo prometido, textos al cliente, encuesta (decision de envio, interpretacion de la respuesta,
// sin incentivo de resena), recordatorios sin aceptar y ratios. Deterministas: ningun test lee el reloj ni la red.
import { describe, expect, it } from "vitest";
import {
  FRASE_RECHAZO,
  MOTIVOS_RECHAZO,
  calcularRatiosOperacion,
  decidirEncuesta,
  describirMinutos,
  esTiempoPrometidoValido,
  esUltimoRecordatorio,
  interpretarRespuestaEncuesta,
  numeroRecordatorio,
  parametrosPedidoAceptado,
  parametrosPedidoRechazado,
  textoEncuesta,
  textoEncuestaSeguro,
  textoPedidoAceptado,
  textoPedidoRechazado,
  textosTrasCalificar,
  ventanaDeTextoAbierta,
} from "../src/ciclo-pedido/reglas.ts";
import type { EntradaDecisionEncuesta } from "../src/ciclo-pedido/reglas.ts";

const PEDIDO = { customerName: "Ana", branch: "Francisco de Montejo", total: 250 };

describe("tiempo prometido y textos al cliente", () => {
  it("valida el rango 5 a 240 y solo enteros", () => {
    expect([5, 45, 240].every(esTiempoPrometidoValido)).toBe(true);
    expect([4, 241, 30.5, "30", null, undefined, Number.NaN].some(esTiempoPrometidoValido)).toBe(false);
  });

  it("describe los minutos en lenguaje de cliente", () => {
    expect(describirMinutos(45)).toBe("45 minutos");
    expect(describirMinutos(60)).toBe("1 hora");
    expect(describirMinutos(75)).toBe("1 hora 15 minutos");
    expect(describirMinutos(120)).toBe("2 horas");
  });

  it("el aviso de aceptado lleva el tiempo prometido y distingue domicilio de recoger", () => {
    const dom = textoPedidoAceptado(PEDIDO, 45, "domicilio");
    expect(dom).toContain("Tiempo estimado: 45 minutos");
    expect(dom).toContain("le llegará");
    expect(textoPedidoAceptado(PEDIDO, 20, "recoger")).toContain("estará listo para recoger");
    expect(parametrosPedidoAceptado(PEDIDO, 45)).toEqual(["Ana", "Francisco de Montejo", "$250.00 MXN", "45 minutos"]);
  });

  it("cada motivo de rechazo tiene frase para el cliente y no filtra la nota interna", () => {
    for (const m of MOTIVOS_RECHAZO) {
      const t = textoPedidoRechazado(PEDIDO, m);
      expect(t).toContain(FRASE_RECHAZO[m]);
      expect(t).toContain("no podemos atender su pedido");
      expect(parametrosPedidoRechazado(PEDIDO, m)[2]).toBe(FRASE_RECHAZO[m]);
    }
  });

  it("las variables de plantilla nunca salen vacias (Meta las rechaza)", () => {
    expect(parametrosPedidoAceptado({ customerName: "", branch: null, total: 10 }, 30).slice(0, 2)).toEqual(["cliente", "la sucursal"]);
  });
});

describe("encuesta: interpretacion de la respuesta", () => {
  it.each([
    ["4", 4],
    ["5.", 5],
    ["cinco", 5],
    ["Un 3", 3],
    ["2 estrellas", 2],
    ["1/5", 1],
    [" 4 ", 4],
  ])("%s es la calificacion %i", (texto, valor) => {
    expect(interpretarRespuestaEncuesta(texto)).toEqual({ tipo: "calificacion", valor });
  });
  it.each(["BAJA", "baja", "STOP", "no mas encuestas", "No quiero encuestas", "ya no quiero más encuestas"])("%s es la baja", (texto) => {
    expect(interpretarRespuestaEncuesta(texto)).toEqual({ tipo: "baja" });
  });
  it.each(["6", "0", "10", "quiero 2 tacos", "gracias", "me gustó mucho", "45 minutos tardó"])("%s no se adivina: es otro", (texto) => {
    expect(interpretarRespuestaEncuesta(texto)).toEqual({ tipo: "otro" });
  });
});

describe("encuesta: textos", () => {
  it("la pregunta pide 1 a 5, ofrece BAJA y no incentiva la resena", () => {
    const t = textoEncuesta("Francisco de Montejo");
    expect(t).toMatch(/1 \(muy mal\) al 5 \(excelente\)/);
    expect(t).toContain("BAJA");
    expect(textoEncuestaSeguro(t)).toBe(true);
  });
  it("ninguna calificacion recibe enlace de resena; <= 3 es seguimiento privado y NUNCA menciona Google", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const t = textosTrasCalificar(n, "Sucursal");
      expect(t.cliente.toLowerCase()).not.toContain("google");
      expect(t.cliente).not.toContain("http");
      expect(textoEncuestaSeguro(t.cliente)).toBe(true);
    }
  });
  it("detecta un texto con incentivo (la guarda que usa el servicio antes de enviar)", () => {
    expect(textoEncuestaSeguro("Deje 5 estrellas y le damos un postre")).toBe(false);
  });
});

describe("encuesta: decision de envio", () => {
  const ENTREGA = new Date("2026-10-20T18:00:00.000Z"); // 12:00 en Merida
  const base: EntradaDecisionEncuesta = {
    ahora: new Date("2026-10-20T20:30:00.000Z"), // 14:30 locales, 2.5 h despues
    deliveredAt: ENTREGA,
    zonaHoraria: "America/Merida",
    telefonoValido: true,
    optOut: false,
    ultimaEncuestaCliente: null,
    ultimoEntrante: new Date("2026-10-20T17:00:00.000Z"),
    plantillaAprobada: false,
    consentimiento: false,
    hayCanal: true,
  };

  it("dentro de la ventana de 24 h envia texto libre", () => {
    expect(decidirEncuesta(base)).toEqual({ accion: "enviar", canal: "texto" });
  });
  it("antes de 2 h espera", () => {
    expect(decidirEncuesta({ ...base, ahora: new Date("2026-10-20T19:30:00.000Z") })).toEqual({ accion: "esperar" });
  });
  it("en horas de silencio (23:00 a 9:00 locales) espera", () => {
    const tarde = new Date("2026-10-21T01:00:00.000Z"); // 20:00 entrega... 2 h = 22:00 -> uso entrega 21:30 locales
    const r = decidirEncuesta({ ...base, deliveredAt: new Date("2026-10-21T03:30:00.000Z"), ahora: new Date("2026-10-21T06:00:00.000Z"), ultimoEntrante: tarde });
    expect(r).toEqual({ accion: "esperar" }); // 00:00 locales: silencio
  });
  it("fuera de la ventana SIN plantilla aprobada no escribe: queda omitida y registrada", () => {
    expect(decidirEncuesta({ ...base, ultimoEntrante: new Date("2026-10-10T00:00:00.000Z") })).toEqual({ accion: "omitir", motivo: "sin_ventana_ni_plantilla" });
    expect(decidirEncuesta({ ...base, ultimoEntrante: null })).toEqual({ accion: "omitir", motivo: "sin_ventana_ni_plantilla" });
  });
  it("fuera de la ventana usa plantilla SOLO si esta aprobada Y hay consentimiento", () => {
    const fuera = { ...base, ultimoEntrante: null };
    expect(decidirEncuesta({ ...fuera, plantillaAprobada: true, consentimiento: true })).toEqual({ accion: "enviar", canal: "plantilla" });
    expect(decidirEncuesta({ ...fuera, plantillaAprobada: true, consentimiento: false })).toEqual({ accion: "omitir", motivo: "sin_ventana_ni_plantilla" });
    expect(decidirEncuesta({ ...fuera, plantillaAprobada: false, consentimiento: true })).toEqual({ accion: "omitir", motivo: "sin_ventana_ni_plantilla" });
  });
  it("la baja, el telefono invalido y una encuesta reciente (< 14 dias) se omiten", () => {
    expect(decidirEncuesta({ ...base, optOut: true })).toEqual({ accion: "omitir", motivo: "opt_out" });
    expect(decidirEncuesta({ ...base, telefonoValido: false })).toEqual({ accion: "omitir", motivo: "sin_telefono" });
    expect(decidirEncuesta({ ...base, ultimaEncuestaCliente: new Date("2026-10-10T00:00:00.000Z") })).toEqual({ accion: "omitir", motivo: "cliente_reciente" });
    expect(decidirEncuesta({ ...base, ultimaEncuestaCliente: new Date("2026-09-01T00:00:00.000Z") })).toEqual({ accion: "enviar", canal: "texto" });
  });
  it("sin numero de WhatsApp activo se omite", () => {
    expect(decidirEncuesta({ ...base, hayCanal: false })).toEqual({ accion: "omitir", motivo: "sin_canal" });
  });
  it("la ventana de texto se cierra a las 23 h del ultimo mensaje del cliente", () => {
    const ahora = new Date("2026-10-20T12:00:00.000Z");
    expect(ventanaDeTextoAbierta(new Date("2026-10-19T14:00:01.000Z"), ahora)).toBe(true);
    expect(ventanaDeTextoAbierta(new Date("2026-10-19T12:00:00.000Z"), ahora)).toBe(false);
    expect(ventanaDeTextoAbierta(null, ahora)).toBe(false);
  });
});

describe("recordatorios de pedidos sin aceptar", () => {
  const cfg = { habilitado: true, primeroMin: 10, repetirMin: 10, maximo: 3 };
  it("el primero a los N minutos, luego cada M, con tope", () => {
    expect(numeroRecordatorio(9.9, cfg)).toBeNull();
    expect(numeroRecordatorio(10, cfg)).toBe(1);
    expect(numeroRecordatorio(19.9, cfg)).toBe(1);
    expect(numeroRecordatorio(20, cfg)).toBe(2);
    expect(numeroRecordatorio(30, cfg)).toBe(3);
    expect(numeroRecordatorio(500, cfg)).toBe(3);
  });
  it("apagado o edad invalida no recuerda; el ultimo escala", () => {
    expect(numeroRecordatorio(60, { ...cfg, habilitado: false })).toBeNull();
    expect(numeroRecordatorio(Number.NaN, cfg)).toBeNull();
    expect(esUltimoRecordatorio(2, 3)).toBe(false);
    expect(esUltimoRecordatorio(3, 3)).toBe(true);
  });
  it("respeta un N personalizado", () => {
    expect(numeroRecordatorio(4, { ...cfg, primeroMin: 5 })).toBeNull();
    expect(numeroRecordatorio(5, { ...cfg, primeroMin: 5, repetirMin: 5 })).toBe(1);
    expect(numeroRecordatorio(10, { ...cfg, primeroMin: 5, repetirMin: 5 })).toBe(2);
  });
});

describe("ratios de operacion", () => {
  const t = { pedidos: 20, aceptados: 15, rechazados: 5, entregadosConPromesa: 10, aTiempo: 7, realMinProm: 52.5, prometidoMinProm: 45, aceptacionSegProm: 92.4, salidaMinProm: 18.26, rechazosPorMotivo: { sin_insumos: 3, saturado: 2 } };
  const e = { enviadas: 10, respondidas: 4, omitidas: 2, conComentario: 1, sumaCalificacion: 16, bajas: 1, distribucion: {}, omitidasPorMotivo: {}, optouts: 1 };
  it("calcula aceptacion, cumplimiento de promesa, desvio y encuesta", () => {
    const r = calcularRatiosOperacion(t, e);
    expect(r.tasaAceptacionPct).toBe(75);
    expect(r.tasaRechazoPct).toBe(25);
    expect(r.cumplimientoPromesaPct).toBe(70);
    expect(r.desvioMinProm).toBe(7.5);
    expect(r.aceptacionSegProm).toBe(92);
    expect(r.salidaMinProm).toBe(18.3);
    expect(r.encuesta).toEqual({ tasaRespuestaPct: 40, promedio: 4, pctBajas: 25, tasaOptOutPct: 8.3, enviadas: 10, respondidas: 4 });
  });
  it("sin datos devuelve null (nunca 0 ni NaN)", () => {
    const vacioT = { pedidos: 0, aceptados: 0, rechazados: 0, entregadosConPromesa: 0, aTiempo: 0, realMinProm: null, prometidoMinProm: null, aceptacionSegProm: null, salidaMinProm: null, rechazosPorMotivo: {} };
    const vacioE = { enviadas: 0, respondidas: 0, omitidas: 0, conComentario: 0, sumaCalificacion: 0, bajas: 0, distribucion: {}, omitidasPorMotivo: {}, optouts: 0 };
    const r = calcularRatiosOperacion(vacioT, vacioE);
    expect(r.tasaAceptacionPct).toBeNull();
    expect(r.cumplimientoPromesaPct).toBeNull();
    expect(r.desvioMinProm).toBeNull();
    expect(r.encuesta.promedio).toBeNull();
    expect(r.encuesta.tasaRespuestaPct).toBeNull();
  });
});
