// ds3 / lote 4 (superposiciones): valores de referencia del Drawer/Modal en la hoja REAL `src/ds3/shell.css`. Solo AÑADE.
import { describe, expect, it } from "vitest";
import { keyframes, valorCss } from "./ds3-shell-css-utils";

describe("ds3 — anatomia de las superposiciones", () => {
  it("cabecera 12x16 con titulo 15/600, subtitulo 12 y cerrar de 28 radio 8 (icono 14)", () => {
    expect(valorCss(".ds3-ov-cabecera.ds3-ov-cabecera", "padding")).toBe("12px 16px");
    expect(valorCss(".ds3-ov-titulo.ds3-ov-titulo", "font-size")).toBe("15px");
    expect(valorCss(".ds3-ov-titulo.ds3-ov-titulo", "font-weight")).toBe("600");
    expect(valorCss(".ds3-ov-subtitulo.ds3-ov-subtitulo", "font-size")).toBe("12px");
    expect(valorCss(".ds3-ov-cerrar.ds3-ov-cerrar", "width")).toBe("28px");
    expect(valorCss(".ds3-ov-cerrar.ds3-ov-cerrar", "border-radius")).toBe("8px");
    expect(valorCss(".ds3-ov-cerrar svg", "width")).toBe("14px");
  });

  it("cuerpo con padding 16 y gap 12; panel con radio 12 y la sombra de flotante", () => {
    expect(valorCss(".ds3-ov-cuerpo.ds3-ov-cuerpo", "padding")).toBe("16px");
    expect(valorCss(".ds3-ov-cuerpo.ds3-ov-cuerpo", "gap")).toBe("12px");
    expect(valorCss(".ds3-drawer.ds3-drawer", "border-radius")).toBe("12px");
    expect(valorCss(".ds3-drawer.ds3-drawer", "box-shadow")).toBe("var(--shadow-pop)");
  });

  it("escritorio: el Drawer entra con translateX(16px) + fundido en 180 ms y sale en 120", () => {
    expect(valorCss('.ds3-drawer.ds3-drawer[data-state="open"]', "animation", "min-width: 820px")).toContain("ds3-drawer-entra var(--dur-base, 180ms)");
    expect(valorCss('.ds3-drawer.ds3-drawer[data-state="closed"]', "animation", "min-width: 820px")).toContain("ds3-drawer-sale 120ms");
    expect(keyframes("ds3-drawer-entra")).toContain("translateX(16px)");
  });

  it("< 820 px: hoja inferior con radio 16 arriba, entrada translateY(32px), cerrar de 32 y SIN logo", () => {
    const movil = "max-width: 819.98px";
    expect(valorCss(".ds3-drawer.ds3-drawer", "border-radius", movil)).toBe("16px 16px 0 0");
    expect(valorCss('.ds3-drawer.ds3-drawer[data-state="open"]', "animation", movil)).toContain("ds3-hoja-entra");
    expect(keyframes("ds3-hoja-entra")).toContain("translateY(32px)");
    expect(valorCss(".ds3-drawer .ds3-ov-cerrar.ds3-ov-cerrar", "width", movil)).toBe("32px");
    expect(valorCss(".ds3-drawer-marca.ds3-drawer-marca", "display", movil)).toBe("none");
  });

  it("el Modal entra con scale(.97) en 160 ms", () => {
    expect(valorCss('.ds3-modal.ds3-modal[data-state="open"]', "animation")).toContain("ds3-modal-entra 160ms");
    expect(keyframes("ds3-modal-entra")).toContain("scale(0.97)");
  });
});
