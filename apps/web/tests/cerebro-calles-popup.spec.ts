// El HTML del popup de Leaflet es crudo (no pasa por React): todo dato del prospecto se escapa y los enlaces tel: respetan la guarda de contacto.
import { describe, expect, it } from "vitest";
import { escapar, htmlPopup } from "../src/superadmin/cerebro/Calles.tsx";
import type { ProspectoMapa } from "../src/superadmin/cerebro/datos.ts";

function p(extra: Partial<ProspectoMapa> = {}): ProspectoMapa {
  return {
    id: "x", empresa: "Taquería Doña Lupe", vertical: "restaurantes", subtipo: null, ciudad: "Mérida", municipio: null, entidad: "Yucatán",
    lat: 20.97, lng: -89.62, telefono: "9991234567", correo: "lupe@ejemplo.mx", contacto: "Lupe Pérez", estado: "nuevo", fuente: "directorio", tamano: null,
    urgencia: 50, cierre: 40, ajuste: 60, completitud: 70, ultimoToque: null, creadoEn: "2026-09-01T00:00:00Z", actualizadoEn: "2026-09-01T00:00:00Z",
    notas: null, sitioWeb: null, sitioVerificado: false, baseLicitud: "interes_declarado", contactoLegado: false, siguientePaso: null, siguientePasoEn: null,
    suprimidoTelefono: false, suprimidoCorreo: false, supresionVerificada: true, ...extra,
  };
}

describe("htmlPopup", () => {
  it("escapa los datos del prospecto: nada de HTML ni atributos inyectados", () => {
    const malo = `<img src=x onerror=alert(1)>"'&`;
    const html = htmlPopup(p({ empresa: malo, contacto: malo, notas: malo, ciudad: malo, telefono: malo, correo: malo }), new Map());
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/onerror=alert\(1\)>/u);
    expect(html).toContain("&lt;img");
    expect(escapar(`<>"'&`)).not.toMatch(/[<>"']/u);
  });
  it("telefono contactable: enlace tel:", () => {
    expect(htmlPopup(p(), new Map())).toContain('href="tel:9991234567"');
  });
  it("telefono suprimido, sin base de licitud o supresion sin verificar: texto plano, sin tel:", () => {
    for (const extra of [{ suprimidoTelefono: true }, { baseLicitud: null }, { supresionVerificada: false }] as Partial<ProspectoMapa>[]) {
      const html = htmlPopup(p(extra), new Map());
      expect(html).not.toContain("tel:");
      expect(html).toContain("9991234567");
    }
  });
});
