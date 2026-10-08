// H-P3-03 -- seleccion de canal: WhatsApp (plantilla o texto), correo o no enviado, con opt-out y supresion.
import { describe, expect, it } from "vitest";
import { decidirCanal, normalizarCorreo, normalizarTelefonoWhatsapp, type EntradaDecisionCanal } from "../../src/index.ts";

const PLANTILLA = { name: "hotel_hold_aprobado", language: "es_MX", params: ["Ana", "Hotel Brisa"] };
const base: EntradaDecisionCanal = {
  telefono: "+525511112222",
  correo: "ana@example.com",
  whatsappListo: true,
  dentroVentanaServicio: false,
  plantilla: PLANTILLA,
  telefonoSuprimido: false,
  correoSuprimido: false,
  transaccional: true,
};

describe("decidirCanal", () => {
  it("fuera de la ventana de 24 h y con plantilla aprobada: WhatsApp con plantilla", () => {
    expect(decidirCanal(base)).toEqual({ canal: "whatsapp", modo: "plantilla", plantilla: PLANTILLA });
  });

  it("el huesped escribio hace menos de 23 h: WhatsApp con texto libre, sin plantilla", () => {
    expect(decidirCanal({ ...base, dentroVentanaServicio: true, plantilla: null })).toEqual({ canal: "whatsapp", modo: "texto" });
  });

  it("sin plantilla aprobada (o con una variable que no se pudo llenar): sale por correo", () => {
    expect(decidirCanal({ ...base, plantilla: null })).toEqual({ canal: "email" });
  });

  it("sin plantilla y sin correo: no enviado por sin_plantilla (el telefono existe, WhatsApp es viable)", () => {
    expect(decidirCanal({ ...base, plantilla: null, correo: null })).toEqual({ canal: null, motivo: "sin_plantilla" });
  });

  it("el telefono pidio BAJA: nunca WhatsApp, aunque haya plantilla; sale por correo", () => {
    expect(decidirCanal({ ...base, telefonoSuprimido: true })).toEqual({ canal: "email" });
  });

  it("opt-out y sin correo: no enviado por baja_whatsapp", () => {
    expect(decidirCanal({ ...base, telefonoSuprimido: true, correo: null })).toEqual({ canal: null, motivo: "baja_whatsapp" });
  });

  it("canal de WhatsApp sin configurar o sin credencial de Meta: correo, o no enviado por whatsapp_no_disponible", () => {
    expect(decidirCanal({ ...base, whatsappListo: false })).toEqual({ canal: "email" });
    expect(decidirCanal({ ...base, whatsappListo: false, correo: null })).toEqual({ canal: null, motivo: "whatsapp_no_disponible" });
  });

  it("sin telefono: correo; sin telefono ni correo: sin_contacto", () => {
    expect(decidirCanal({ ...base, telefono: null })).toEqual({ canal: "email" });
    expect(decidirCanal({ ...base, telefono: null, correo: null })).toEqual({ canal: null, motivo: "sin_contacto" });
  });

  it("correo en la lista de supresion: un proactivo no sale; uno transaccional de SU reserva si", () => {
    expect(decidirCanal({ ...base, telefono: null, correoSuprimido: true, transaccional: false })).toEqual({ canal: null, motivo: "correo_suprimido" });
    expect(decidirCanal({ ...base, telefono: null, correoSuprimido: true, transaccional: true })).toEqual({ canal: "email" });
  });

  it("telefono suprimido y correo suprimido (proactivo): el motivo es el del telefono, que es lo que el staff puede entender", () => {
    expect(decidirCanal({ ...base, telefonoSuprimido: true, correoSuprimido: true, transaccional: false })).toEqual({ canal: null, motivo: "baja_whatsapp" });
  });
});

describe("normalizarTelefonoWhatsapp", () => {
  it("10 digitos es Mexico; con + o con 52 se respeta; basura no es telefono", () => {
    expect(normalizarTelefonoWhatsapp("55 1111 2222")).toBe("+525511112222");
    expect(normalizarTelefonoWhatsapp("(998) 123-4567")).toBe("+529981234567");
    expect(normalizarTelefonoWhatsapp("+1 415 555 2671")).toBe("+14155552671");
    expect(normalizarTelefonoWhatsapp("5215511112222")).toBe("+5215511112222");
    expect(normalizarTelefonoWhatsapp("123")).toBeNull();
    expect(normalizarTelefonoWhatsapp("")).toBeNull();
    expect(normalizarTelefonoWhatsapp(null)).toBeNull();
    expect(normalizarTelefonoWhatsapp("1".repeat(20))).toBeNull();
  });
});

describe("normalizarCorreo", () => {
  it("acepta un correo plausible en minusculas y descarta lo que no lo es", () => {
    expect(normalizarCorreo("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizarCorreo("ana@")).toBeNull();
    expect(normalizarCorreo("a b@c.com")).toBeNull();
    expect(normalizarCorreo(null)).toBeNull();
  });
});
