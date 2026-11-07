// ds3 / lote 5.3 (movil < 768): valores de referencia en la hoja REAL `src/ds3/shell.css`. Solo AÑADE.
import { describe, expect, it } from "vitest";
import { valorCss } from "./ds3-shell-css-utils.ts";

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
});
