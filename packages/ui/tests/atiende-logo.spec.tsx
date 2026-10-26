// ds3 / 2.3: AtiendeLogo. Variante `ds3` monocroma con punto de acento fijo; `legado` (default) no cambia.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ATIENDE_DIAMETRO_PUNTO,
  ATIENDE_MINIMO_SIMBOLO_PX,
  ATIENDE_MINIMO_WORDMARK_PX,
  AtiendeMark,
  AtiendeWordmark,
} from "../src/components/AtiendeLogo";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const fuente = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/components/AtiendeLogo.tsx"),
  "utf8",
);

describe("AtiendeLogo ds3 / 2.3", () => {
  it("el default (legado) conserva los tres tonos de hoy y no lleva marcas ds3", () => {
    const s = html(createElement(AtiendeMark));
    expect(s).toContain("#7DD3FC");
    expect(s).toContain("#38BDF8");
    expect(s).toContain("#1D4ED8");
    expect(s).not.toContain("data-atiende-logo");
    const w = html(createElement(AtiendeWordmark));
    expect(w).toContain("text-marca-atiende");
    expect(w).not.toContain("data-atiende-wordmark");
  });

  it("ds3: tinta por --logo-tinta, sin hex ni degradado y con un unico punto fill-primary", () => {
    const s = html(createElement(AtiendeMark, { variante: "ds3" }));
    expect(s).toContain("--logo-tinta");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/gradient/i);
    expect(s.match(/data-atiende-punto/g)).toHaveLength(1);
    expect(s).toMatch(/<circle[^>]*class="fill-primary"/);
    expect(s).toContain('aria-label="atiende"');
    expect(s).toContain('focusable="false"');
  });

  it("el punto no cambia con el tono: siempre fill-primary, mismo cx/cy/r", () => {
    const p = html(createElement(AtiendeMark, { variante: "ds3", tono: "positivo" }));
    const n = html(createElement(AtiendeMark, { variante: "ds3", tono: "negativo" }));
    const punto = (s: string) => /<circle[^>]*>/.exec(s)?.[0];
    expect(punto(p)).toBe(punto(n));
    expect(punto(n)).toContain('class="fill-primary"');
    expect(punto(n)).toContain('r="5"');
  });

  it("negativo pinta la tinta clara fija; positivo sigue --logo-tinta", () => {
    const n = html(createElement(AtiendeMark, { variante: "ds3", tono: "negativo" }));
    expect(n).toContain("text-white");
    expect(n).not.toContain("--logo-tinta");
    expect(n).toContain('data-tono="negativo"');
  });

  it("minimos: simbolo 16 px de alto, wordmark 100 px de ancho; respetarMinimos=false los quita", () => {
    expect(ATIENDE_MINIMO_SIMBOLO_PX).toBe(16);
    expect(ATIENDE_MINIMO_WORDMARK_PX).toBe(100);
    expect(html(createElement(AtiendeMark, { variante: "ds3" }))).toContain("min-h-4");
    expect(html(createElement(AtiendeMark, { variante: "ds3", respetarMinimos: false }))).not.toMatch(/min-h-/);
    expect(html(createElement(AtiendeWordmark, { variante: "ds3" }))).toContain("min-w-[100px]");
    expect(html(createElement(AtiendeWordmark, { variante: "ds3", respetarMinimos: false }))).not.toContain("min-w-");
  });

  it("espacio libre = 2 diametros del punto alrededor del simbolo (viewBox ampliado)", () => {
    const sin = html(createElement(AtiendeMark, { variante: "ds3" }));
    expect(sin).toContain('viewBox="0 0 40 32"');
    const con = html(createElement(AtiendeMark, { variante: "ds3", espacioLibre: true }));
    const margen = ATIENDE_DIAMETRO_PUNTO * 2;
    expect(con).toContain(`viewBox="${-margen} ${-margen} ${40 + 2 * margen} ${32 + 2 * margen}"`);
    expect(con).toContain("min-h-9");
  });

  it("wordmark ds3: texto 'atiende' con tinta, simbolo ds3, y el modo oscuro hereda --logo-tinta", () => {
    const w = html(createElement(AtiendeWordmark, { variante: "ds3", tamano: "sidebar" }));
    expect(w).toContain('data-atiende-wordmark="ds3"');
    expect(w).toContain(">atiende<");
    expect(w).toContain("data-atiende-logo=\"ds3\"");
    expect(w).not.toContain("text-marca-atiende");
    expect(w).toContain("h-[18px]");
  });

  it("animado reutiliza las clases de movimiento existentes", () => {
    expect(html(createElement(AtiendeMark, { variante: "ds3", animado: true }))).toContain("atiende-glifo-animado");
  });

  it("el codigo nuevo no mete style={{}} ni text-[Npx]", () => {
    expect(fuente).not.toMatch(/style=\{\{/);
    expect(fuente).not.toMatch(/text-\[\d+px\]/);
  });
});
