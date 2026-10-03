// Chequeos de accesibilidad propios (sin @axe-core/playwright, que no esta instalado): orden de encabezados, nombres accesibles y
// contraste de texto. Corren sobre el documento real que sirve `vite preview`, en claro/oscuro y en movil segun el proyecto.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Un solo <h1> y ningun salto de nivel hacia abajo (h1 -> h3 sin h2) entre los encabezados visibles, en orden de documento. */
export async function afirmarEncabezadosEnOrden(page: Page, contexto: string): Promise<void> {
  const niveles = await page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")]
      .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "fixed")
      .map((e) => (e.tagName.startsWith("H") && e.tagName.length === 2 ? Number(e.tagName[1]) : Number(e.getAttribute("aria-level") ?? "2"))),
  );
  expect.soft(niveles.filter((n) => n === 1), `${contexto}: debe haber un unico <h1>`).toHaveLength(1);
  const saltos: string[] = [];
  niveles.forEach((n, i) => {
    const previo = i === 0 ? 0 : niveles[i - 1]!;
    if (n > previo + 1) saltos.push(`h${previo} -> h${n}`);
  });
  expect.soft(saltos, `${contexto}: saltos de nivel de encabezado`).toEqual([]);
}

/** Todo control visible (boton, enlace, campo, pestana) tiene nombre accesible no vacio. */
export async function afirmarNombresAccesibles(page: Page, contexto: string): Promise<void> {
  const sinNombre = await page.evaluate(() => {
    const visible = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nombre = (e: Element): string => {
      const aria = e.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      const por = e.getAttribute("aria-labelledby");
      if (por) return por.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const el = e as HTMLInputElement;
      if (el.labels && el.labels.length > 0) return [...el.labels].map((l) => l.textContent ?? "").join(" ").trim();
      const titulo = e.getAttribute("title")?.trim();
      const texto = (e.textContent ?? "").trim();
      return texto || titulo || e.querySelector("img[alt]")?.getAttribute("alt")?.trim() || "";
    };
    return [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=checkbox], [role=switch]")]
      .filter(visible)
      .filter((e) => nombre(e) === "")
      .map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}[${e.getAttribute("type") ?? e.getAttribute("role") ?? ""}]`);
  });
  expect.soft(sinNombre, `${contexto}: controles sin nombre accesible`).toEqual([]);
}

/**
 * Contraste WCAG 2.x del texto visible: compone el fondo opaco real de cada elemento con texto propio y compara contra el color
 * calculado. Umbral 4.5:1 (3:1 si el texto es grande: >=24px, o >=18.66px en negrita). Elementos deshabilitados quedan fuera (WCAG 1.4.3
 * los exime) y los fondos con imagen/degradado se omiten en vez de adivinarlos.
 */
export interface HallazgoContraste {
  readonly texto: string;
  readonly ratio: number;
  readonly minimo: number;
  readonly etiqueta: string;
}

export async function medirContraste(page: Page): Promise<HallazgoContraste[]> {
  // Los colores del DS animan (transition-colors): se mide con todas las transiciones/animaciones terminadas, no a medio camino.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const analizar = (c: string): RGBA | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (m) {
        const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
      }
      return null;
    };
    // El navegador devuelve color() / oklch() en algunos tokens: se normaliza dibujandolo en un canvas.
    const lienzo = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const aRgba = (c: string): RGBA | null => {
      const directo = analizar(c);
      if (directo) return directo;
      lienzo.clearRect(0, 0, 1, 1);
      lienzo.fillStyle = "#000";
      lienzo.fillStyle = c;
      lienzo.fillRect(0, 0, 1, 1);
      const d = lienzo.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const mezclar = (sobre: RGBA, fondo: RGBA): RGBA => {
      const a = sobre[3] + fondo[3] * (1 - sobre[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (sobre[i]! * sobre[3] + fondo[i]! * fondo[3] * (1 - sobre[3])) / a).concat(a) as RGBA;
    };
    const luminancia = ([r, g, b]: RGBA): number => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fondoReal = (el: Element): RGBA | null => {
      const capas: RGBA[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== "none") return null;
        const c = aRgba(s.backgroundColor);
        if (c && c[3] > 0) { capas.push(c); if (c[3] >= 1) break; }
      }
      let base: RGBA = [255, 255, 255, 1];
      if (document.documentElement.classList.contains("dark")) base = [0, 0, 0, 1];
      for (const c of capas.reverse()) base = mezclar(c, base);
      return base;
    };
    const salida: HallazgoContraste[] = [];
    const vistos = new Set<string>();
    const recorrer = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = recorrer.nextNode(); n; n = recorrer.nextNode()) {
      const texto = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (!texto || !el || el.closest("script,style,[aria-hidden=true],[disabled],[aria-disabled=true]")) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.opacity === "0") continue;
      const fondo = fondoReal(el);
      const fg = aRgba(s.color);
      if (!fondo || !fg) continue;
      const frente = mezclar(fg, fondo);
      const l1 = luminancia(frente);
      const l2 = luminancia(fondo);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = parseFloat(s.fontSize);
      const grande = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
      const minimo = grande ? 3 : 4.5;
      if (ratio < minimo) {
        const clave = `${el.tagName}:${texto.slice(0, 40)}`;
        if (!vistos.has(clave)) {
          vistos.add(clave);
          salida.push({ texto: texto.slice(0, 40), ratio: Math.round(ratio * 100) / 100, minimo, etiqueta: `<${el.tagName.toLowerCase()}>` });
        }
      }
    }
    return salida;
  });
}

export function describirContraste(h: readonly HallazgoContraste[]): string[] {
  return h.map((x) => `${x.ratio}:1 < ${x.minimo} en ${x.etiqueta} "${x.texto}"`);
}

export async function afirmarContraste(page: Page, contexto: string): Promise<void> {
  const hallazgos = await medirContraste(page);
  expect.soft(describirContraste(hallazgos), `${contexto}: texto con contraste insuficiente`).toEqual([]);
}

export async function afirmarAccesibilidad(page: Page, contexto: string): Promise<void> {
  await afirmarEncabezadosEnOrden(page, contexto);
  await afirmarNombresAccesibles(page, contexto);
  await afirmarContraste(page, contexto);
}
