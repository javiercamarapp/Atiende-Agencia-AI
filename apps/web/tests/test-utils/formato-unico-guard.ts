// Guard de formato unico (PL-19), con TRINQUETE. Cuenta las llamadas `toLocaleString|toLocaleDateString|toLocaleTimeString`
// del codigo de presentacion (apps/web/src, packages/ui/src, packages/domain-*/src) y exige que el numero NUNCA suba por
// encima del baseline versionado en `formato-unico-baseline.json` (puede bajar). Las pantallas deben formatear con el
// formateador canonico de `@atiende/ui` (`formatMoney`, `resolverFormato`) o con `lib/formato-fecha.ts`; los archivos
// canonicos mismos quedan fuera del conteo. Ademas, ninguna llamada puede fijar un locale distinto de es-MX ("en-US" etc.).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { archivos, sinComentarios } from "./ds-v2-guard-reglas.ts";

/** Llamadas de formato localizado (no cuenta toLocaleLowerCase/UpperCase: son de mayusculas, no de formato). */
export const PATRON_TO_LOCALE = /\.toLocale(?:Date|Time)?String\s*\(/g;
/** Llamada a toLocale*String cuyo primer argumento es un locale literal que NO es es-MX. `en-CA` se tolera: es el modismo
 *  para obtener la fecha ISO `YYYY-MM-DD` (no es un formato para mostrar al usuario). */
export const PATRON_LOCALE_AJENO = /\.toLocale(?:Date|Time)?String\s*\(\s*["'`](?!es-MX["'`]|en-CA["'`])[A-Za-z-]+["'`]/g;

/** Archivos que SON el formateador canonico: sus llamadas internas no cuentan. */
export const ARCHIVOS_CANONICOS: readonly string[] = [
  "packages/ui/src/lib/formatMoney.ts",
  "packages/ui/src/lib/formato-preset.ts",
  "apps/web/src/lib/formato-fecha.ts",
];

export interface FuenteRepo {
  /** Ruta relativa a la raiz del repo, con "/". */
  readonly ruta: string;
  readonly codigo: string;
}

export function contar(codigo: string, patron: RegExp): number {
  return [...sinComentarios(codigo).matchAll(patron)].length;
}

/** Directorios `src` escaneados: apps/web, packages/ui y todo packages/domain-*. */
export function raicesEscaneadas(raizRepo: string): string[] {
  const dominios = readdirSync(join(raizRepo, "packages"))
    .filter((n) => n.startsWith("domain-"))
    .map((n) => join(raizRepo, "packages", n, "src"));
  return [join(raizRepo, "apps/web/src"), join(raizRepo, "packages/ui/src"), ...dominios];
}

export function cargarFuentesRepo(raizRepo: string): FuenteRepo[] {
  return raicesEscaneadas(raizRepo).flatMap((raiz) => {
    try {
      return archivos(raiz).map((f) => ({ ruta: relative(raizRepo, f).split("\\").join("/"), codigo: readFileSync(f, "utf8") }));
    } catch {
      return [];
    }
  });
}

export function totalToLocale(fuentes: readonly FuenteRepo[]): number {
  return fuentes.filter((f) => !ARCHIVOS_CANONICOS.includes(f.ruta)).reduce((a, f) => a + contar(f.codigo, PATRON_TO_LOCALE), 0);
}

export function archivosConLocaleAjeno(fuentes: readonly FuenteRepo[]): string[] {
  return fuentes.filter((f) => contar(f.codigo, PATRON_LOCALE_AJENO) > 0).map((f) => f.ruta);
}
