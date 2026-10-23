// H-P3-03 -- validacion de la configuracion por evento y del catalogo de plantillas HSM de hoteles; textos y formatos.
import { describe, expect, it } from "vitest";
import {
  EVENTOS_MENSAJE_HUESPED,
  EVENTOS_PLANTILLA_HOTELES,
  armarParametrosPlantilla,
  claveCatalogoPlantilla,
  componerMensaje,
  eventoDeClaveCatalogo,
  eventoPlantillaHoteles,
  formatearFechaCalendario,
  formatearInstanteLocal,
  formatearMontoCentavos,
  nombreCorto,
  urlAvisoPrivacidad,
  validarConfigEvento,
  validarPlantillaWhatsapp,
  valoresDelCandidato,
} from "../../src/index.ts";
import { candidato } from "./fixtures.ts";

describe("validarConfigEvento", () => {
  it("acepta activar un evento y las horas de pre-llegada entre 1 y 336", () => {
    expect(validarConfigEvento("pre_llegada", { activo: true, horasAntes: 48 })).toEqual({ ok: true, valor: { activo: true, horasAntes: 48, resenaUrl: null } });
    expect(validarConfigEvento("pre_llegada", { activo: true, horasAntes: 336 }).ok).toBe(true);
    expect(validarConfigEvento("pre_llegada", { activo: true, horasAntes: 1 }).ok).toBe(true);
  });

  it("rechaza horas fuera de rango, decimales, texto, o horas en otro evento", () => {
    for (const horasAntes of [0, 337, -5, 2.5, "48"]) expect(validarConfigEvento("pre_llegada", { activo: true, horasAntes }).ok, String(horasAntes)).toBe(false);
    expect(validarConfigEvento("hold.aprobado", { activo: true, horasAntes: 24 }).ok).toBe(false);
  });

  it("el enlace de resena solo es https, solo de post_estancia y de hasta 500 caracteres", () => {
    expect(validarConfigEvento("post_estancia", { activo: true, resenaUrl: "https://g.page/r/ejemplo/review" })).toEqual({ ok: true, valor: { activo: true, horasAntes: null, resenaUrl: "https://g.page/r/ejemplo/review" } });
    expect(validarConfigEvento("post_estancia", { activo: true, resenaUrl: "http://inseguro.example.com" }).ok).toBe(false);
    expect(validarConfigEvento("post_estancia", { activo: true, resenaUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validarConfigEvento("post_estancia", { activo: true, resenaUrl: `https://x.com/${"a".repeat(500)}` }).ok).toBe(false);
    expect(validarConfigEvento("pre_llegada", { activo: true, resenaUrl: "https://ok.example.com" }).ok).toBe(false);
    expect(validarConfigEvento("post_estancia", { activo: true, resenaUrl: "" })).toEqual({ ok: true, valor: { activo: true, horasAntes: null, resenaUrl: null } });
  });

  it("exige un booleano y un objeto", () => {
    expect(validarConfigEvento("hold.aprobado", { activo: "si" }).ok).toBe(false);
    expect(validarConfigEvento("hold.aprobado", null).ok).toBe(false);
    expect(validarConfigEvento("hold.aprobado", []).ok).toBe(false);
  });
});

describe("catalogo de plantillas HSM de hoteles", () => {
  it("cubre los 8 eventos y la clave del catalogo ida y vuelta", () => {
    expect(EVENTOS_PLANTILLA_HOTELES.map((e) => e.evento)).toEqual([...EVENTOS_MENSAJE_HUESPED]);
    for (const e of EVENTOS_MENSAJE_HUESPED) expect(eventoDeClaveCatalogo(claveCatalogoPlantilla(e))).toBe(e);
    expect(eventoDeClaveCatalogo("appointment.reminder_24h")).toBeUndefined();
    expect(eventoDeClaveCatalogo("hoteles.inventado")).toBeUndefined();
  });

  it("valida el alta: nombre de Meta, idioma, variables permitidas del evento y estado", () => {
    const evento = eventoPlantillaHoteles("pre_llegada")!;
    expect(validarPlantillaWhatsapp({ nombre: "hotel_pre_llegada", idioma: "es_MX", variables: ["nombre", "hotel", "llegada"], estado: "aprobada" }, evento)).toMatchObject({ ok: true });
    expect(validarPlantillaWhatsapp({ nombre: "Hotel Pre", variables: [], estado: "aprobada" }, evento).ok).toBe(false);
    expect(validarPlantillaWhatsapp({ nombre: "ok", variables: ["total"], estado: "aprobada" }, evento).ok).toBe(false); // total no existe en pre_llegada
    expect(validarPlantillaWhatsapp({ nombre: "ok", variables: [], estado: "inventado" }, evento).ok).toBe(false);
    expect(validarPlantillaWhatsapp({ nombre: "ok", idioma: "espanol", variables: [], estado: "borrador" }, evento).ok).toBe(false);
    expect(validarPlantillaWhatsapp({ nombre: "ok", variables: Array(11).fill("nombre"), estado: "borrador" }, evento).ok).toBe(false);
    expect(validarPlantillaWhatsapp("x", evento).ok).toBe(false);
  });

  it("armarParametrosPlantilla respeta el orden, limpia saltos de linea y devuelve null si falta un valor", () => {
    expect(armarParametrosPlantilla(["b", "a"], { a: "uno", b: "dos\nlineas" })).toEqual(["dos lineas", "uno"]);
    expect(armarParametrosPlantilla(["a", "falta"], { a: "uno" })).toBeNull();
    expect(armarParametrosPlantilla(["a"], { a: "   " })).toBeNull();
    expect(armarParametrosPlantilla(Array(11).fill("a"), { a: "x" })).toBeNull();
  });
});

describe("textos y formatos", () => {
  it("la fecha calendario no se corre un dia por la zona del servidor", () => {
    expect(formatearFechaCalendario("2031-07-04")).toMatch(/4 de julio de 2031/);
    expect(formatearFechaCalendario("2031-01-01")).toMatch(/1 de enero de 2031/);
  });

  it("el vencimiento se escribe en la hora LOCAL de la propiedad", () => {
    expect(formatearInstanteLocal("2031-07-03T19:00:00Z", "America/Mexico_City")).toMatch(/13:00/);
    expect(formatearInstanteLocal("2031-07-03T19:00:00Z", "Asia/Tokyo")).toMatch(/04:00/);
    expect(formatearInstanteLocal("2031-07-03T19:00:00Z", "Zona/Invalida")).toMatch(/13:00/);
  });

  it("monto en pesos mexicanos desde centavos enteros", () => {
    expect(formatearMontoCentavos(119000)).toBe("$1,190.00");
  });

  it("nombreCorto toma el primer nombre y tiene valor por omision", () => {
    expect(nombreCorto("Ana Torres")).toBe("Ana");
    expect(nombreCorto("  ")).toBe("huésped");
    expect(nombreCorto(null)).toBe("huésped");
    expect(nombreCorto("A".repeat(100))).toHaveLength(40);
  });

  it("el enlace del aviso publico es /hoteles/:orgSlug/aviso sobre APP_BASE_URL, sin doble diagonal", () => {
    expect(urlAvisoPrivacidad("https://app.atiende.ai/", "hotel-brisa")).toBe("https://app.atiende.ai/hoteles/hotel-brisa/aviso");
  });

  it("valoresDelCandidato solo trae lo que sabe calcular", () => {
    const v = valoresDelCandidato(candidato({ totalCentavos: null, venceEn: null, resenaUrl: null }), { appBaseUrl: "https://app.atiende.ai" });
    expect(v.total).toBeUndefined();
    expect(v.vence).toBeUndefined();
    expect(v.enlace_resena).toBeUndefined();
    expect(v.enlace_aviso).toBe("https://app.atiende.ai/hoteles/hotel-brisa/aviso");
  });

  it("cada evento compone asunto, texto y html con el hotel y sin 'undefined'", () => {
    const v = valoresDelCandidato(candidato({ resenaUrl: "https://g.page/r/x" }), { appBaseUrl: "https://app.atiende.ai" });
    for (const evento of EVENTOS_MENSAJE_HUESPED) {
      const m = componerMensaje(evento, v);
      expect(m.asunto, evento).toContain("Hotel Brisa");
      expect(m.texto, evento).toContain("Hotel Brisa");
      expect(m.html, evento).toContain("Hotel Brisa");
      expect(`${m.asunto}${m.texto}${m.html}`, evento).not.toMatch(/undefined|\[object/);
    }
  });
});
