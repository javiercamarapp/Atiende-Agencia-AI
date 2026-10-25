// Piezas compartidas por los specs de e2e-ds3: medidor, excepciones, salida de evidencia y bandera de diseno.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

/** Texto del medidor (una expresion JS): se evalua con `page.evaluate(MEDIDOR)`. */
export const MEDIDOR = readFileSync(new URL("./medidas.js", import.meta.url), "utf8");

export interface Defecto {
  readonly tipo: string;
  readonly el: string;
  readonly msg: string;
  readonly dato?: unknown;
}
export interface Medicion {
  vp: [number, number];
  tactil: boolean;
  defectos: Defecto[];
  resumen: { alturasBoton: number[]; minFuente: number | null; contrasteMin: number | null; conteos: Record<string, number> };
  informativo: Record<string, unknown>;
}
export interface Excepcion {
  readonly ruta: string;
  readonly tipo: string;
  readonly selector?: string;
  readonly motivo: string;
  readonly vence: string;
}

export const EXCEPCIONES: readonly Excepcion[] = JSON.parse(readFileSync(new URL("./excepciones.json", import.meta.url), "utf8")) as Excepcion[];

export const INFORMATIVO = process.env["DS3_INFORMATIVO"] === "1";
export const HUMO = process.env["DS3_BARRIDO"] !== "completo";
export const ETAPA = process.env["DS3_ETAPA"] === "antes" ? "antes" : "despues";
const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";

/** Enciende la bandera del diseno nuevo antes de cargar cualquier pagina (lo lee /theme-boot.js desde localStorage). */
export async function prepararBandera(page: Page): Promise<void> {
  if (process.env["E2E_DISENO"] !== "ds3") return;
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-diseno", "ds3");
    } catch {
      // Sin almacenamiento: la prueba usara ?diseno=ds3 si hace falta.
    }
  });
}

export function esperadaPorExcepcion(ruta: string, d: Defecto): boolean {
  return EXCEPCIONES.some((e) => (e.ruta === "*" || ruta.includes(e.ruta)) && e.tipo === d.tipo && (!e.selector || d.el.includes(e.selector)));
}

export const slug = (ruta: string): string => (ruta.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "inicio").slice(0, 80);

/** Espera a que ya no haya ningun estado de carga visible (logo con aria-busy o texto «Cargando…»). */
export async function esperarSinCarga(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll('[role="status"][aria-busy="true"]').length === 0 && !/(^|\n)\s*Cargando/.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
}

export interface ResultadoMedida {
  readonly linea: string[];
  readonly medicion: Medicion;
}

/** Mide la pagina actual, escribe JSON (y PNG si DS3_CAPTURAS=1) en la carpeta de evidencia y devuelve los defectos no exentos. */
export async function medir(page: Page, info: TestInfo, consola: string, ruta: string, variante = ""): Promise<ResultadoMedida> {
  const medicion = (await page.evaluate(MEDIDOR)) as Medicion;
  const carpeta = join(SALIDA, consola, slug(ruta));
  const base = `${info.project.name}-${ETAPA}${variante ? "-" + variante : ""}`;
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, `${base}.json`), JSON.stringify({ ruta, consola, proyecto: info.project.name, variante, ...medicion }, null, 1));
  if (process.env["DS3_CAPTURAS"] === "1") await page.screenshot({ path: join(carpeta, `${base}.png`), fullPage: false });
  const linea = medicion.defectos
    .filter((d) => !esperadaPorExcepcion(ruta, d))
    .map((d) => `${ruta}${variante ? " (" + variante + ")" : ""} [${d.tipo}] ${d.el} — ${d.msg} ${JSON.stringify(d.dato ?? "")}`);
  return { linea, medicion };
}

/** Lee el estado del foco actual: anillo (outline/box-shadow), si esta dentro del viewport y si algo fijo lo tapa (2.4.7 / 2.4.11). */
export async function leerFoco(page: Page): Promise<{ el: string; sinAnillo: boolean; tapadoPor: string | null; fuera: boolean; tabindexPositivo: boolean } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const nombre = (n: Element) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + " «" + (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24) + "»";
    const sinAnillo = (s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0) && s.boxShadow === "none";
    const t = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
    const tapado = t && t !== el && !el.contains(t) && !t.contains(el) ? nombre(t) : null;
    return {
      el: nombre(el),
      sinAnillo,
      tapadoPor: tapado,
      fuera: r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth,
      tabindexPositivo: el.tabIndex > 0,
    };
  });
}
