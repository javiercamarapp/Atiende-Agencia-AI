// Primer toque del Cerebro desde los mensajes base de la taxonomia: reglas de seguridad (supresion, base de licitud, marcadores
// sin resolver) y los href (lada MX sin duplicar, formatos con espacios y +).
import { describe, expect, it } from "vitest";
import type { ProspectoMapa, TaxonomiaApi } from "../src/superadmin/cerebro/datos.ts";
import { estadoMensaje, hrefCorreo, hrefCorreoSiPermitido, hrefTelefonoSiPermitido, hrefWhatsapp, motivoBloqueo, rellenarMarcadores } from "../src/superadmin/cerebro/mensajes.ts";

function p(extra: Partial<ProspectoMapa> = {}): ProspectoMapa {
  return {
    id: "x", empresa: "Taquería Doña Lupe", vertical: "restaurantes", subtipo: "taqueria", ciudad: "Mérida", municipio: null, entidad: "Yucatán",
    lat: 20.97, lng: -89.62, telefono: "9991234567", correo: "lupe@ejemplo.mx", contacto: "Lupe Pérez", estado: "nuevo", fuente: "directorio", tamano: null,
    urgencia: 50, cierre: 40, ajuste: 60, completitud: 70, ultimoToque: null, creadoEn: "2026-09-01T00:00:00Z", actualizadoEn: "2026-09-01T00:00:00Z",
    notas: null, sitioWeb: null, sitioVerificado: false, baseLicitud: "interes_declarado", contactoLegado: false, siguientePaso: null, siguientePasoEn: null,
    suprimidoTelefono: false, suprimidoCorreo: false, supresionVerificada: true, ...extra,
  };
}

const tax = (texto: string, canal = "whatsapp"): TaxonomiaApi => ({
  vertical: "restaurantes", version: 1, subtipos: [{ clave: "taqueria", nombre: "Taquería" }],
  rangosTamano: { unidad: "empleados", rangos: [] }, mensajesBase: [{ canal, variante: "A", texto }],
});

describe("rellenarMarcadores", () => {
  it("llena con datos REALES: primer nombre del contacto, empresa, destino y subtipo", () => {
    const r = rellenarMarcadores("Hola {nombre}, {restaurante} en {destino} ({tipo}).", p(), "taquería");
    expect(r.texto).toBe("Hola Lupe, Taquería Doña Lupe en Mérida (taquería).");
    expect(r.faltan).toEqual([]);
  });
  it("sin contacto saluda al equipo de la empresa; no inventa un nombre", () => {
    expect(rellenarMarcadores("Hola {nombre}", p({ contacto: null }), null).texto).toBe("Hola equipo de Taquería Doña Lupe");
  });
  it("un marcador que no se puede llenar se reporta y no se rellena con un dato inventado", () => {
    const r = rellenarMarcadores("Licitaciones de {giro} en {destino} {desconocido}", p({ ciudad: null }), null);
    expect(r.faltan).toEqual(["giro", "destino", "desconocido"]);
    expect(r.texto).toContain("{giro}");
  });
});

describe("motivoBloqueo (supresion y licitud)", () => {
  it("sin bloqueo cuando hay base de licitud, supresion verificada y etapa activa", () => {
    expect(motivoBloqueo(p(), "whatsapp")).toBeNull();
  });
  it("el telefono suprimido bloquea WhatsApp pero no el correo, y al reves", () => {
    expect(motivoBloqueo(p({ suprimidoTelefono: true }), "whatsapp")).toMatch(/supresión/u);
    expect(motivoBloqueo(p({ suprimidoTelefono: true }), "correo")).toBeNull();
    expect(motivoBloqueo(p({ suprimidoCorreo: true }), "correo")).toMatch(/supresión/u);
  });
  it("contacto legado o sin base de licitud: no contactar", () => {
    expect(motivoBloqueo(p({ contactoLegado: true }), "whatsapp")).toMatch(/base de licitud/u);
    expect(motivoBloqueo(p({ baseLicitud: null }), "correo")).toMatch(/base de licitud/u);
  });
  it("si no se pudo verificar la lista de supresion, NO se abre (falla cerrado)", () => {
    expect(motivoBloqueo(p({ supresionVerificada: false }), "whatsapp")).toMatch(/verificar/u);
  });
  it("un desenlace final no se contacta", () => {
    for (const e of ["ganado", "perdido", "descartado"]) expect(motivoBloqueo(p({ estado: e }), "whatsapp")).not.toBeNull();
  });
});

describe("estadoMensaje", () => {
  it("listo: el texto es el mensaje base ya relleno y el href lo lleva codificado", () => {
    const e = estadoMensaje(p(), "whatsapp", tax("Hola {nombre}, vi {restaurante}. Responde BAJA."));
    expect(e.tipo).toBe("listo");
    if (e.tipo !== "listo") return;
    expect(e.texto).toBe("Hola Lupe, vi Taquería Doña Lupe. Responde BAJA.");
    expect(e.href).toBe(`https://wa.me/529991234567?text=${encodeURIComponent(e.texto)}`);
  });
  it("sin destino no hay boton; bloqueado explica por que; incompleto dice que falta", () => {
    expect(estadoMensaje(p({ telefono: null }), "whatsapp", tax("x")).tipo).toBe("sin_destino");
    expect(estadoMensaje(p({ suprimidoTelefono: true }), "whatsapp", tax("x")).tipo).toBe("bloqueado");
    const inc = estadoMensaje(p({ subtipo: null }), "whatsapp", tax("Hola {giro}"));
    expect(inc.tipo).toBe("incompleto");
    expect(estadoMensaje(p(), "whatsapp", undefined).tipo).toBe("incompleto");
  });
  it("el correo usa el mensaje base de correo y, si no existe, el de WhatsApp (el unico sembrado)", () => {
    const e = estadoMensaje(p(), "correo", tax("Hola {nombre}"));
    expect(e.tipo).toBe("listo");
    if (e.tipo === "listo") expect(e.href.startsWith("mailto:lupe@ejemplo.mx?body=")).toBe(true);
  });
});

describe("hrefWhatsapp / hrefCorreo", () => {
  it("la lada MX no se duplica y los formatos con espacios, + y guiones normalizan", () => {
    expect(hrefWhatsapp("529991234567", "x")).toContain("wa.me/529991234567");
    expect(hrefWhatsapp("9991234567", "x")).toContain("wa.me/529991234567");
    expect(hrefWhatsapp("+52 55 1234 5678", "x")).toContain("wa.me/525512345678");
    expect(hrefWhatsapp("(55) 1234-5678", "x")).toContain("wa.me/525512345678");
    expect(hrefWhatsapp("52 999 123 4567", "x")).toContain("wa.me/529991234567");
  });
  it("un telefono sin digitos suficientes no genera un link roto", () => {
    expect(hrefWhatsapp("12345", "x")).toBeNull();
    expect(hrefWhatsapp("sin telefono", "x")).toBeNull();
  });
  it("el correo codifica el cuerpo con saltos CRLF", () => {
    expect(hrefCorreo("a@b.mx", "uno\ndos")).toBe(`mailto:a@b.mx?body=${encodeURIComponent("uno\r\ndos")}`);
  });
});

describe("enlaces tel:/mailto: crudos pasan por la misma guarda", () => {
  it("contactable: se ofrecen tel: y mailto:", () => {
    expect(hrefTelefonoSiPermitido(p())).toBe("tel:9991234567");
    expect(hrefCorreoSiPermitido(p())).toBe("mailto:lupe@ejemplo.mx");
  });
  it("telefono suprimido: sin tel: pero el correo no suprimido conserva su mailto; y al reves", () => {
    expect(hrefTelefonoSiPermitido(p({ suprimidoTelefono: true }))).toBeNull();
    expect(hrefCorreoSiPermitido(p({ suprimidoTelefono: true }))).toBe("mailto:lupe@ejemplo.mx");
    expect(hrefCorreoSiPermitido(p({ suprimidoCorreo: true }))).toBeNull();
    expect(hrefTelefonoSiPermitido(p({ suprimidoCorreo: true }))).toBe("tel:9991234567");
  });
  it("sin base de licitud, contacto legado o supresion sin verificar: ningun enlace (falla cerrado)", () => {
    for (const extra of [{ baseLicitud: null }, { contactoLegado: true }, { supresionVerificada: false }, { estado: "perdido" }] as Partial<ProspectoMapa>[]) {
      expect(hrefTelefonoSiPermitido(p(extra))).toBeNull();
      expect(hrefCorreoSiPermitido(p(extra))).toBeNull();
    }
  });
  it("sin dato no hay enlace", () => {
    expect(hrefTelefonoSiPermitido(p({ telefono: null }))).toBeNull();
    expect(hrefCorreoSiPermitido(p({ correo: null }))).toBeNull();
  });
});
