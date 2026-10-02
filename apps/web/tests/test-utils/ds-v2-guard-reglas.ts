// Reglas del guard estatico del DS v2 (diseno-ux PR-12). UNICA fuente de verdad: las usan
// `web-ds-v2-guard.spec.ts` (escanea apps/web/src real, baseline 0) y
// `web-ds-v2-guard-sanidad.spec.ts` (demuestra con fixtures que cada regla SI falla).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Fuente {
  /** Ruta relativa a la raiz escaneada, con "/" como separador. */
  readonly ruta: string;
  /** Codigo SIN comentarios. */
  readonly codigo: string;
}

export interface ReglaGuard {
  readonly nombre: string;
  readonly patron: RegExp;
  /** Solo se aplica a archivos bajo un directorio `pages/`. */
  readonly soloPaginas?: boolean;
  /** Si existe, la regla solo se aplica a las rutas que lo cumplan (conserva el alcance de un guard por vertical). */
  readonly alcance?: RegExp;
}

export function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return /\.(tsx?)$/.test(nombre) ? [ruta] : [];
  });
}

/** Quita comentarios de linea y luego de bloque (primero los de linea: un comentario puede mencionar rutas con `/*`). Un `//` dentro de una URL en cadena puede recortar de mas: solo puede ocultar, nunca inventar, una coincidencia. */
export function sinComentarios(codigo: string): string {
  return codigo.replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function cargarFuentes(raiz: string): Fuente[] {
  return archivos(raiz).map((ruta) => ({
    ruta: relative(raiz, ruta).split("\\").join("/"),
    codigo: sinComentarios(readFileSync(ruta, "utf8")),
  }));
}

const PALETA = "green|amber|red|yellow|blue|emerald|orange|slate|gray|zinc|sky|rose|stone|neutral|purple|indigo|teal|cyan|lime|pink|fuchsia|violet|white|black";

export const REGLAS: ReadonlyArray<ReglaGuard> = [
  { nombre: "window.confirm (usar useConfirm)", patron: /\bwindow\.confirm\s*\(|(^|[^.\w])confirm\s*\(\s*[`"']/m },
  { nombre: "tamano de texto arbitrario text-[Npx] (usar la escala text-2xs/xs/sm/base)", patron: /text-\[[0-9.]+px\]/ },
  { nombre: "paleta cruda de Tailwind (usar tokens o StatusBadge/Callout)", patron: new RegExp(`\\b(bg|text|border|ring|from|to|via|divide|fill|stroke)-(${PALETA})(-[0-9]+)?(/[0-9]+)?\\b`) },
  { nombre: "color hexadecimal literal", patron: /#[0-9a-fA-F]{3,8}\b(?![\w-])/ },
  { nombre: "estilo inline style={{...}}", patron: /style=\{\{/ },
  { nombre: "<select> crudo (usar NativeSelect)", patron: /<select[\s>]/ },
  { nombre: "<textarea> crudo (usar Textarea)", patron: /<textarea[\s>]/ },
  { nombre: "checkbox crudo (usar Checkbox)", patron: /type="checkbox"/ },
  { nombre: "formatMoney local (usar formatMoney de @atiende/ui)", patron: /function\s+formatMoney\s*\(/, soloPaginas: true },
  { nombre: "fmtMoney local o dinero con toLocaleString a mano en paginas de hoteles (usar formatMoney de @atiende/ui)", patron: /function\s+fmtMoney\s*\(|toLocaleString\("es-MX",\s*\{\s*minimumFractionDigits/, soloPaginas: true, alcance: /^verticals\/hoteles\// },
  { nombre: "ModalFormularioLateral (usar FormDialog de @atiende/ui)", patron: /ModalFormularioLateral/ },
  { nombre: "<table> crudo (usar Table o DataTable de @atiende/ui)", patron: /<table[\s>]/ },
  { nombre: "<Badge> con colores propios (usar StatusBadge)", patron: /<Badge[\s>]/ },
  { nombre: "relleno interno p-6 de pagina (usar PageContainer)", patron: /className="[^"]*\bp-6\b/ },
  { nombre: "tokens heredados retirados en DS v2 (gold/terracotta/sand/olive/cream, shadow-glow, gradient-hero)", patron: /\b(bg|text|border|ring|from|to|via|fill|stroke)-(gold|terracotta|sand|olive|cream)(-[a-z0-9]+)?(\/[0-9]+)?\b|\bshadow-glow\b|\bbg-gradient-hero\b/ },
  { nombre: 'variantes de Button retiradas (variant="hero|gold|terracotta")', patron: /variant=["{]\s*["']?(hero|gold|terracotta)\b/ },
  // Trinquete UNI-C (restaurantes): lo ya migrado no puede volver. Alcance acotado a la zona para no tocar el baseline de las demas.
  { nombre: "Table a mano en restaurantes (usar DataTable)", patron: /<Table[\s>]/, alcance: /^verticals\/restaurantes\// },
  { nombre: "AlertDialog local en restaurantes (usar useConfirm o useConfirm().pedirTexto)", patron: /\bAlertDialog\b/, alcance: /^verticals\/restaurantes\// },
  { nombre: "Guardando a mano en restaurantes (usar Button loading)", patron: /Guardando(…|\.\.\.)/, alcance: /^verticals\/restaurantes\// },
];

const esPagina = (f: Fuente): boolean => /(^|\/)pages\//.test(f.ruta);

/** Rutas de las fuentes que infringen la regla (respetando `soloPaginas`). */
export function infractores(fuentes: ReadonlyArray<Fuente>, regla: ReglaGuard): string[] {
  const enAlcance = regla.alcance ? fuentes.filter((f) => regla.alcance!.test(f.ruta)) : fuentes;
  const candidatos = regla.soloPaginas ? enAlcance.filter(esPagina) : enAlcance;
  return candidatos.filter((f) => regla.patron.test(f.codigo)).map((f) => f.ruta);
}

/** Reglas de delegacion: ciertos modulos de formato deben delegar en @atiende/ui y no reimplementar el formato. */
export interface ReglaDelegacion {
  readonly nombre: string;
  readonly ruta: string;
  /** Devuelve los motivos de infraccion (vacio = cumple). */
  readonly evaluar: (codigo: string) => string[];
}

export const REGLAS_DELEGACION: ReadonlyArray<ReglaDelegacion> = [
  {
    nombre: "restaurantes/dashboard-client.ts delega el formato de dinero en @atiende/ui",
    ruta: "verticals/restaurantes/dashboard-client.ts",
    evaluar: (c) => [
      ...(c.includes('from "@atiende/ui"') ? [] : ["no importa de @atiende/ui"]),
      ...(/toLocaleString\("es-MX",\s*\{\s*minimumFractionDigits/.test(c) ? ["reimplementa el formato con toLocaleString"] : []),
    ],
  },
  {
    nombre: "despachos/lib/format.ts delega el formato numerico en @atiende/ui",
    ruta: "verticals/despachos/lib/format.ts",
    evaluar: (c) => [
      ...(c.includes('from "@atiende/ui"') ? [] : ["no importa de @atiende/ui"]),
      ...(c.includes("Intl.NumberFormat") ? ["reimplementa el formato con Intl.NumberFormat"] : []),
    ],
  },
];

export function violacionesDelegacion(fuentes: ReadonlyArray<Fuente>, regla: ReglaDelegacion): string[] {
  const f = fuentes.find((x) => x.ruta === regla.ruta);
  return f ? regla.evaluar(f.codigo) : [`no existe ${regla.ruta}`];
}
