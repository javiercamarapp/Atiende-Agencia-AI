// Trinquete de accesibilidad con axe (logica pura, sin navegador): compara las violaciones medidas en una pantalla contra
// e2e-ds3/axe-baseline.json ([{ruta, regla, nodos}]). Una violacion que no esta en la baseline, o con MAS nodos, falla; una entrada de
// la pantalla que bajo (o desaparecio) tambien falla y pide bajar la baseline, asi el piso solo desciende. Lo usa e2e-ds3/axe.spec.ts y
// lo prueba apps/web/tests/axe-trinquete.spec.ts.

/** Etiquetas WCAG que se auditan (A y AA de 2.0, 2.1 y 2.2). */
export const ETIQUETAS_WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export interface EntradaAxe {
  /** Pantalla y proyecto de Playwright: `"/citas/login @d1440-claro"` (el contraste cambia con el tema y el ancho). */
  readonly ruta: string;
  /** Id de la regla de axe (`color-contrast`, `label`, ...). */
  readonly regla: string;
  /** Nodos que violan la regla en esa pantalla. */
  readonly nodos: number;
}

export interface Comparacion {
  /** Violaciones nuevas o que crecieron: fallan. */
  readonly nuevas: string[];
  /** Entradas de la baseline de esta pantalla que bajaron: fallan pidiendo bajar la baseline. */
  readonly bajaron: string[];
}

export const claveAxe = (ruta: string, proyecto: string): string => `${ruta} @${proyecto}`;

/** Valida y devuelve la baseline; lanza con un mensaje claro si el formato no es [{ruta, regla, nodos}] o hay duplicados. */
export function leerBaseline(texto: string): EntradaAxe[] {
  const crudo = JSON.parse(texto) as unknown;
  if (!Array.isArray(crudo)) throw new Error("axe-baseline.json debe ser una lista [{ruta, regla, nodos}]");
  const vistas = new Set<string>();
  return crudo.map((e, i) => {
    const r = e as Record<string, unknown>;
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "nodos,regla,ruta") {
      throw new Error(`axe-baseline.json[${i}]: se esperan exactamente las llaves ruta, regla y nodos`);
    }
    if (typeof r.ruta !== "string" || r.ruta === "" || typeof r.regla !== "string" || r.regla === "") {
      throw new Error(`axe-baseline.json[${i}]: ruta y regla deben ser texto no vacio`);
    }
    if (typeof r.nodos !== "number" || !Number.isInteger(r.nodos) || r.nodos < 1) {
      throw new Error(`axe-baseline.json[${i}]: nodos debe ser un entero >= 1 (una regla sin nodos se borra de la baseline)`);
    }
    const id = `${r.ruta}\u0000${r.regla}`;
    if (vistas.has(id)) throw new Error(`axe-baseline.json[${i}]: entrada duplicada ${r.ruta} [${r.regla}]`);
    vistas.add(id);
    return { ruta: r.ruta, regla: r.regla, nodos: r.nodos };
  });
}

/** Compara lo medido en `ruta` (clave con proyecto) contra la baseline. Solo mira las entradas de esa misma ruta. */
export function compararConBaseline(ruta: string, medidas: readonly EntradaAxe[], baseline: readonly EntradaAxe[]): Comparacion {
  const propias = baseline.filter((b) => b.ruta === ruta);
  const nuevas: string[] = [];
  for (const m of medidas) {
    if (m.ruta !== ruta || m.nodos < 1) continue;
    const b = propias.find((x) => x.regla === m.regla);
    if (!b) nuevas.push(`${ruta} [${m.regla}] ${m.nodos} nodo(s): violacion nueva (no esta en axe-baseline.json)`);
    else if (m.nodos > b.nodos) nuevas.push(`${ruta} [${m.regla}] sube de ${b.nodos} a ${m.nodos} nodo(s)`);
  }
  const bajaron: string[] = [];
  for (const b of propias) {
    const actual = medidas.find((m) => m.ruta === ruta && m.regla === b.regla)?.nodos ?? 0;
    if (actual < b.nodos) {
      bajaron.push(
        actual === 0
          ? `${ruta} [${b.regla}] ya no tiene violaciones: borra la entrada de axe-baseline.json`
          : `${ruta} [${b.regla}] bajo de ${b.nodos} a ${actual} nodo(s): baja axe-baseline.json a ${actual}`,
      );
    }
  }
  return { nuevas, bajaron };
}

/** Ordena entradas por ruta y regla, por punto de codigo (formato estable de la baseline, igual en cualquier locale). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const ordenarEntradas = (entradas: readonly EntradaAxe[]): EntradaAxe[] =>
  [...entradas].sort((a, b) => cmp(a.ruta, b.ruta) || cmp(a.regla, b.regla));
