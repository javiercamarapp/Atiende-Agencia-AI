// ds3 / lote 5.2 (sidebar): valores de referencia del sidebar en la hoja REAL `src/ds3/shell.css`. Solo AÑADE.
import { describe, expect, it } from "vitest";
import { valorCss } from "./ds3-shell-css-utils.ts";

const ESCRITORIO = "min-width: 768px";

describe("ds3 — sidebar (hoja del shell)", () => {
  it("232 px expandido / 72 contraido, con transicion de ancho de 180 ms y el easing unico", () => {
    expect(valorCss(".ds3-sidebar.ds3-sidebar", "width", ESCRITORIO)).toBe("232px");
    expect(valorCss(".ds3-sidebar.ds3-sidebar[data-colapsado]", "width", ESCRITORIO)).toBe("72px");
    expect(valorCss(".ds3-sidebar.ds3-sidebar", "transition", ESCRITORIO)).toBe("width var(--dur-base, 180ms) cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("item de 32 px, 13/500, padding 6x10, radio 8 e icono de 16", () => {
    expect(valorCss(".ds3-nav-item.ds3-nav-item", "min-height", ESCRITORIO)).toBe("32px");
    expect(valorCss(".ds3-nav-item.ds3-nav-item", "font-size", ESCRITORIO)).toBe("13px");
    expect(valorCss(".ds3-nav-item.ds3-nav-item", "font-weight", ESCRITORIO)).toBe("500");
    expect(valorCss(".ds3-nav-item.ds3-nav-item", "padding", ESCRITORIO)).toBe("6px 10px");
    expect(valorCss(".ds3-nav-item.ds3-nav-item", "border-radius", ESCRITORIO)).toBe("8px");
    expect(valorCss(".ds3-nav-item .ds3-nav-icono", "width", ESCRITORIO)).toBe("16px");
  });

  it("activo = tinte de tinta al 7 % + filete interior de 2 px en el resaltado de marca (celeste; azul si aun no existe el token)", () => {
    const sel = '.ds3-nav-item.ds3-nav-item[aria-current="page"]';
    expect(valorCss(sel, "background-color", ESCRITORIO)).toBe("color-mix(in srgb, hsl(var(--foreground)) 7%, transparent)");
    expect(valorCss(sel, "box-shadow", ESCRITORIO)).toBe("inset 2px 0 0 hsl(var(--highlight, var(--primary)))");
  });

  it("titulos de grupo en IBM Plex Mono 11 mayusculas, con toggle de 32", () => {
    const sel = ".ds3-nav-grupo-toggle.ds3-nav-grupo-toggle";
    expect(valorCss(sel, "font-family", ESCRITORIO)).toMatch(/^"IBM Plex Mono DS3", "IBM Plex Mono"/);
    expect(valorCss(sel, "font-size", ESCRITORIO)).toBe("11px");
    expect(valorCss(sel, "text-transform", ESCRITORIO)).toBe("uppercase");
    expect(valorCss(sel, "min-height", ESCRITORIO)).toBe("32px");
  });

  it("pie fijo en gris sumido (organizacion -> filas -> tema/idioma -> cuenta) con tope de 55 %", () => {
    expect(valorCss(".ds3-sidebar-marca.ds3-sidebar-marca", "order", ESCRITORIO)).toBe("0");
    expect(valorCss(".ds3-sidebar-nav.ds3-sidebar-nav", "order", ESCRITORIO)).toBe("1");
    expect(valorCss(".ds3-sidebar-organizacion.ds3-sidebar-organizacion", "order", ESCRITORIO)).toBe("2");
    expect(valorCss(".ds3-sidebar-pie.ds3-sidebar-pie", "order", ESCRITORIO)).toBe("3");
    expect(valorCss(".ds3-sidebar-cuenta-zona.ds3-sidebar-cuenta-zona", "order", ESCRITORIO)).toBe("4");
    expect(valorCss(".ds3-sidebar-pie.ds3-sidebar-pie", "max-height", ESCRITORIO)).toBe("55%");
    expect(valorCss(".ds3-sidebar-pie.ds3-sidebar-pie", "background-color", ESCRITORIO)).toBe("hsl(var(--sunken))");
  });

  it("tema e idioma: pildoras de 32 con celdas de 26; tarjeta de cuenta con monograma de 28 y radio 8", () => {
    expect(valorCss(".ds3-tema.ds3-tema", "height", ESCRITORIO)).toBe("32px");
    expect(valorCss(".ds3-tema-opcion.ds3-tema-opcion", "height", ESCRITORIO)).toBe("26px");
    expect(valorCss(".ds3-cuenta.ds3-cuenta", "border-radius", ESCRITORIO)).toBe("12px");
    expect(valorCss(".ds3-monograma.ds3-monograma", "width", ESCRITORIO)).toBe("28px");
    expect(valorCss(".ds3-monograma.ds3-monograma", "border-radius", ESCRITORIO)).toBe("8px");
  });

  it("forced-colors: el activo se marca con un borde del sistema (el box-shadow no se pinta en alto contraste)", () => {
    expect(valorCss('.ds3-nav-item[aria-current="page"]', "border-left", "forced-colors: active")).toBe("2px solid Highlight");
  });
});
