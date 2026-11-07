// ds3 / lote 5.1 (encabezado y cabecera de pagina): valores de referencia en la hoja REAL `src/ds3/shell.css`. Solo AÑADE.
import { describe, expect, it } from "vitest";
import { valorCss } from "./ds3-shell-css-utils.ts";

const ESCRITORIO = "min-width: 768px";

describe("ds3 — encabezado de 44 px", () => {
  it("zona de 44 px con padding 0 20, gap 10, filete inferior y fondo de tarjeta", () => {
    expect(valorCss(".ds3-cabecera-zona.ds3-cabecera-zona", "height", ESCRITORIO)).toBe("44px");
    expect(valorCss(".ds3-cabecera-zona.ds3-cabecera-zona", "padding", ESCRITORIO)).toBe("0 20px");
    expect(valorCss(".ds3-cabecera-zona.ds3-cabecera-zona", "gap", ESCRITORIO)).toBe("10px");
    expect(valorCss(".ds3-cabecera-zona.ds3-cabecera-zona", "border-bottom", ESCRITORIO)).toBe("1px solid hsl(var(--border))");
    expect(valorCss(".ds3-cabecera.ds3-cabecera", "display", ESCRITORIO)).toBe("contents");
  });

  it("titulo 13/500 con icono de 15 gris; «Guía» es una pildora de 28 junto al titulo y las acciones van a la derecha", () => {
    expect(valorCss(".ds3-cabecera-titulo.ds3-cabecera-titulo", "font-size", ESCRITORIO)).toBe("13px");
    expect(valorCss(".ds3-cabecera-titulo.ds3-cabecera-titulo", "font-weight", ESCRITORIO)).toBe("500");
    expect(valorCss(".ds3-cabecera-titulo svg", "width", ESCRITORIO)).toBe("15px");
    expect(valorCss(".ds3-guia.ds3-solo[hidden]", "height", ESCRITORIO)).toBe("28px");
    expect(valorCss(".ds3-guia.ds3-solo[hidden]", "border-radius", ESCRITORIO)).toBe("999px");
    expect(valorCss(".ds3-guia.ds3-solo[hidden]", "order", ESCRITORIO)).toBe("1");
    expect(valorCss(".ds3-cabecera-acciones.ds3-cabecera-acciones", "margin-left", ESCRITORIO)).toBe("auto");
  });
});

describe("ds3 — PageHeader y barra de alcance", () => {
  it("H1 20/600 con tracking -0.02em, eyebrow 12/600 mayusculas y descripcion de 13", () => {
    expect(valorCss(".ds3-encabezado-titulo.ds3-encabezado-titulo", "font-size")).toBe("20px");
    expect(valorCss(".ds3-encabezado-titulo.ds3-encabezado-titulo", "font-weight")).toBe("600");
    expect(valorCss(".ds3-encabezado-titulo.ds3-encabezado-titulo", "letter-spacing")).toBe("-0.02em");
    expect(valorCss(".ds3-encabezado-eyebrow.ds3-encabezado-eyebrow", "font-size")).toBe("12px");
    expect(valorCss(".ds3-encabezado-eyebrow.ds3-encabezado-eyebrow", "text-transform")).toBe("uppercase");
    expect(valorCss(".ds3-encabezado-descripcion.ds3-encabezado-descripcion", "font-size")).toBe("13px");
  });

  it("acciones a la derecha y, en <= 640, en una fila completa a la izquierda", () => {
    expect(valorCss(".ds3-encabezado-acciones.ds3-encabezado-acciones", "margin-left")).toBe("auto");
    expect(valorCss(".ds3-encabezado-acciones.ds3-encabezado-acciones", "flex-basis", "max-width: 640px")).toBe("100%");
  });

  it("popover de la guia de 340 px (acotado al viewport) y barra de alcance de 32 sin wrap", () => {
    expect(valorCss(".ds3-popover-guia.ds3-popover-guia", "width")).toBe("min(340px, calc(100vw - 24px))");
    expect(valorCss(".ds3-alcance.ds3-alcance", "min-height")).toBe("32px");
    expect(valorCss(".ds3-alcance-filtros.ds3-alcance-filtros", "height")).toBe("32px");
  });
});
