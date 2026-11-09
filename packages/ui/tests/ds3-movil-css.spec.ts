// ds3 / lote 5.3 (movil < 768): valores de referencia en la hoja REAL `src/ds3/shell.css`. Solo AÑADE.
import { describe, expect, it } from "vitest";
import { BLOQUES, valorCss } from "./ds3-shell-css-utils.ts";

const MOVIL = "max-width: 767.98px";

describe("ds3 — movil", () => {
  it("cabecera de vidrio de 56 px en una fila; el nombre de la pagina queda solo para lectores de pantalla", () => {
    expect(valorCss(".ds3-movil-cabecera.ds3-movil-cabecera", "background-color", MOVIL)).toBe("color-mix(in srgb, hsl(var(--card)) 92%, transparent)");
    expect(valorCss(".ds3-movil-cabecera.ds3-movil-cabecera", "backdrop-filter", MOVIL)).toBe("saturate(1.4) blur(14px)");
    expect(valorCss(".ds3-movil-cabecera-fila.ds3-movil-cabecera-fila", "min-height", MOVIL)).toBe("56px");
    expect(valorCss(".ds3-movil-titulo.ds3-movil-titulo", "clip", MOVIL)).toBe("rect(0, 0, 0, 0)");
    expect(valorCss(".ds3-movil-menu.ds3-movil-menu", "width", MOVIL)).toBe("44px");
  });

  it("barra inferior: pildora flotante de 64 px a 12 px de los bordes, destinos >= 44 con icono 22 y etiqueta 12", () => {
    expect(valorCss(".ds3-barra-inferior.ds3-barra-inferior", "height", MOVIL)).toBe("64px");
    expect(valorCss(".ds3-barra-inferior.ds3-barra-inferior", "border-radius", MOVIL)).toBe("999px");
    expect(valorCss(".ds3-barra-inferior.ds3-barra-inferior", "left", MOVIL)).toBe("max(12px, env(safe-area-inset-left))");
    expect(valorCss(".ds3-barra-inferior.ds3-barra-inferior", "bottom", MOVIL)).toBe("max(10px, env(safe-area-inset-bottom))");
    expect(valorCss(".ds3-barra-destino.ds3-barra-destino", "min-height", MOVIL)).toBe("44px");
    expect(valorCss(".ds3-barra-destino svg", "width", MOVIL)).toBe("22px");
    expect(valorCss(".ds3-barra-destino > span:not([aria-hidden])", "font-size", MOVIL)).toBe("12px");
  });

  it("con el teclado abierto la barra se oculta", () => {
    expect(valorCss('[data-teclado="abierto"] .ds3-barra-inferior.ds3-barra-inferior', "display", MOVIL)).toBe("none");
  });

  it("el contenido deja lugar a la cabecera y a la barra (+24); la hoja «Más» mide 90dvh con radio 16 arriba y filas de 44", () => {
    expect(valorCss(".ds3-shell-contenido.ds3-shell-contenido", "padding", MOVIL)).toBe(
      "calc(56px + var(--safe-area-top, 0px) + 16px) 16px calc(64px + max(10px, env(safe-area-inset-bottom)) + 24px)",
    );
    expect(valorCss(".ds3-hoja-mas.ds3-hoja-mas", "max-height", MOVIL)).toBe("90dvh");
    expect(valorCss(".ds3-hoja-mas.ds3-hoja-mas", "border-radius", MOVIL)).toBe("16px 16px 0 0");
    expect(valorCss(".ds3-hoja-mas a", "min-height", MOVIL)).toBe("44px");
  });

  it("campos de 16 px en pantallas tactiles (sin zoom de iOS)", () => {
    expect(valorCss(".ds3-shell textarea", "font-size", "pointer: coarse")).toBe("16px");
  });

  // Decision de Omar 7-nov-2026 (igual que Rovaq): campana con contador en la cabecera y «Preguntar» como 5.o destino de la barra.
  it("campana de la cabecera: 44 x 44, borde, radio 12; contador de 18 en --action con 99+ en la marca", () => {
    expect(valorCss(".ds3-movil-campana.ds3-solo[hidden]", "display", MOVIL)).toBe("inline-flex");
    expect(valorCss(".ds3-movil-campana.ds3-solo[hidden]", "width", MOVIL)).toBe("44px");
    expect(valorCss(".ds3-movil-campana.ds3-solo[hidden]", "height", MOVIL)).toBe("44px");
    expect(valorCss(".ds3-movil-campana.ds3-solo[hidden]", "border-radius", MOVIL)).toBe("12px");
    expect(valorCss(".ds3-movil-campana-contador.ds3-movil-campana-contador", "min-width", MOVIL)).toBe("18px");
    expect(valorCss(".ds3-movil-campana-contador.ds3-movil-campana-contador", "background-color", MOVIL)).toBe("hsl(var(--action))");
    expect(valorCss(".ds3-movil-acciones.ds3-movil-acciones", "gap", MOVIL)).toBe("8px");
  });

  it("«Preguntar» se muestra con la bandera; en su ruta «Más» deja de marcarse", () => {
    expect(valorCss(".ds3-barra-preguntar.ds3-solo[hidden]", "display", MOVIL)).toBe("block");
    expect(valorCss(".ds3-barra-inferior:has(.ds3-barra-preguntar) .ds3-barra-destino > span:not([aria-hidden])", "font-size", MOVIL)).toBe("11px");
    expect(valorCss(".ds3-barra-inferior.ds3-barra-inferior:has(.ds3-barra-preguntar) > ul", "gap", MOVIL)).toBe("0");
    expect(valorCss('.ds3-barra-inferior:has(.ds3-barra-preguntar [aria-current="page"]) .ds3-barra-mas.ds3-barra-mas[data-activo]', "background-color", MOVIL)).toBe("transparent");
  });

  // Auditoria R2 #3/#4: «Guía» de 44 en la cabecera movil y sin banners sobre el chat tambien en movil (antes la regla vivia en >= 768).
  it("«Guía» de 44 con el marco de «Más»", () => {
    expect(valorCss(".ds3-movil-guia.ds3-solo[hidden]", "width", MOVIL)).toBe("44px");
    expect(valorCss(".ds3-movil-guia.ds3-solo[hidden]", "height", MOVIL)).toBe("44px");
    expect(valorCss(".ds3-movil-guia.ds3-solo[hidden]", "border-radius", MOVIL)).toBe("12px");
  });

  it("los banners se ocultan en el chat en cualquier ancho (regla fuera de los @media)", () => {
    for (const banner of ["banner-agregados-global", "banner-plan"]) {
      const b = BLOQUES.find((x) => x.selector.includes(`.ds3-shell-marco[data-pantalla="chat"] [data-testid="${banner}"]`));
      expect(b?.media).toBe("");
      expect(b?.decl.display).toBe("none");
    }
  });
});
