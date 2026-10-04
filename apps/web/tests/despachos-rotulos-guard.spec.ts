// Guard acotado a apps/web/src/verticals/despachos (UNI-C, D-40 y .2): (1) los rotulos visibles van 100% en espanol segun el glosario
// de docs/despachos/CONTEXT.md; (2) todo control de formulario (Input, NativeSelect, Textarea) tiene su label: va dentro de un
// <FormField>, o lleva aria-label, o su id lo referencia un <Label htmlFor>. Escanea codigo SIN comentarios y, para los rotulos, solo
// el texto visible (cadenas y texto JSX), nunca identificadores ni rutas. Excluye Resumen (UNI-RES), el portal publico (lote D2) y lib/ (clientes de API: sus cadenas son URLs, no texto visible).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cargarFuentes, type Fuente } from "./test-utils/ds-v2-guard-reglas";

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const EXCLUIDOS = /^verticals\/despachos\/(pages\/Dashboard\.tsx|portal\/)/;
const FUENTES = cargarFuentes(RAIZ).filter((f) => f.ruta.startsWith("verticals/despachos/") && !EXCLUIDOS.test(f.ruta) && !f.ruta.includes("/lib/"));

/** Rotulos en ingles que no deben aparecer en texto visible (glosario docs/despachos/CONTEXT.md) y su reemplazo oficial. */
export const PALABRAS_PROHIBIDAS: ReadonlyArray<{ readonly patron: RegExp; readonly usar: string }> = [
  { patron: /\bbookkeeping\b/i, usar: "Clasificación contable" },
  { patron: /\bmatching\b/i, usar: "Coincidencias" },
  { patron: /\boverrides?\b/i, usar: "Ajustes manuales" },
  { patron: /\bstaff\b/i, usar: "Equipo" },
  { patron: /\bdashboard gerencial\b/i, usar: "Resumen" },
  { patron: /\boutbox\b/i, usar: "Cola de envíos" },
  { patron: /\bworkpaper\b/i, usar: "Papel de trabajo" },
  { patron: /\bpayroll\b/i, usar: "Nómina" },
];

/** Cadenas "..." / '...' / `...` y texto JSX (entre > y <) de un archivo, sin imports ni identificadores/rutas/slugs. */
export function textosVisibles(codigo: string): string[] {
  const sinImports = codigo.replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "").replace(/^\s*export[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  const cadenas = [...sinImports.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const jsx = [...sinImports.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1] ?? "");
  // Un slug o ruta (`bookkeeping`, `/despachos/x/staff`, `data-x`) no es texto visible: sin espacios ni mayusculas iniciales ni acentos.
  return [...cadenas, ...jsx].map((t) => t.trim()).filter((t) => t !== "" && !/^[a-z0-9_./:#?=&${}-]+$/.test(t));
}

export function rotulosProhibidos(fuentes: ReadonlyArray<Fuente>): string[] {
  const hallazgos: string[] = [];
  for (const f of fuentes) {
    for (const t of textosVisibles(f.codigo)) {
      for (const p of PALABRAS_PROHIBIDAS) if (p.patron.test(t)) hallazgos.push(`${f.ruta}: «${t.slice(0, 60)}» (usar ${p.usar})`);
    }
  }
  return hallazgos;
}

/** Etiquetas de apertura JSX de Input, NativeSelect y Textarea de @atiende/ui con su posicion en el codigo. */
function controles(codigo: string): Array<{ readonly etiqueta: string; readonly indice: number }> {
  const salida: Array<{ etiqueta: string; indice: number }> = [];
  const re = /<(Input|NativeSelect|Textarea)\b/g;
  for (let m = re.exec(codigo); m; m = re.exec(codigo)) {
    // La etiqueta termina en el primer ">" fuera de llaves (los handlers "=>" viven dentro de llaves).
    let prof = 0;
    let i = m.index;
    for (; i < codigo.length; i++) {
      const c = codigo[i];
      if (c === "{") prof++;
      else if (c === "}") prof--;
      else if (c === ">" && prof === 0) break;
    }
    salida.push({ etiqueta: codigo.slice(m.index, i + 1), indice: m.index });
  }
  return salida;
}

export function controlesSinLabel(fuentes: ReadonlyArray<Fuente>): string[] {
  const hallazgos: string[] = [];
  for (const f of fuentes) {
    for (const c of controles(f.codigo)) {
      if (/aria-label=/.test(c.etiqueta) || /\{\.\.\.\w+\}/.test(c.etiqueta)) continue;
      const dentroDeFormField = f.codigo.lastIndexOf("<FormField", c.indice) > f.codigo.lastIndexOf("</FormField>", c.indice);
      if (dentroDeFormField) continue;
      const id = /\bid=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(c.etiqueta);
      const idTexto = id?.[1] ?? id?.[2];
      const conLabel = idTexto !== undefined && (f.codigo.includes(`htmlFor="${idTexto}"`) || f.codigo.includes(`htmlFor={\`${idTexto}\`}`));
      if (!conLabel) hallazgos.push(`${f.ruta}: ${c.etiqueta.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return hallazgos;
}

describe("despachos — rotulos 100% en espanol (D-40)", () => {
  it("escanea las paginas, el shell y los componentes de despachos", () => {
    expect(FUENTES.length).toBeGreaterThan(25);
    expect(FUENTES.some((f) => f.ruta === "verticals/despachos/DespachosShell.tsx")).toBe(true);
  });

  it("ningun texto visible usa Bookkeeping, Matching, Overrides, Staff ni Dashboard gerencial", () => {
    expect(rotulosProhibidos(FUENTES)).toEqual([]);
  });

  it("el menu lateral muestra los rotulos oficiales", () => {
    const shell = FUENTES.find((f) => f.ruta === "verticals/despachos/DespachosShell.tsx")!;
    expect(shell.codigo).toContain('label: "Clasificación contable"');
    expect(shell.codigo).toContain('label: "Equipo"');
  });
});

describe("despachos — todo control de formulario tiene label", () => {
  it("cada Input, NativeSelect y Textarea va en un FormField, lleva aria-label o su id lo referencia un Label", () => {
    expect(controlesSinLabel(FUENTES)).toEqual([]);
  });
});

describe("sanidad del guard de despachos (cada regla SI falla ante una violacion)", () => {
  const f = (codigo: string): Fuente => ({ ruta: "verticals/despachos/pages/X.tsx", codigo });

  it("detecta los rotulos en ingles en texto JSX y en cadenas, y no confunde identificadores ni rutas", () => {
    expect(rotulosProhibidos([f("<h2>Bookkeeping</h2>")])).toHaveLength(1);
    expect(rotulosProhibidos([f('const L = { label: "Staff activo" };')])).toHaveLength(1);
    expect(rotulosProhibidos([f('<Button>Correr matching</Button>')])).toHaveLength(1);
    expect(rotulosProhibidos([f('placeholder="Agregar override"')])).toHaveLength(1);
    expect(rotulosProhibidos([f('const { staffFullName } = ctx; fetchSugerenciasOverridesBookkeeping(x); { to: "bookkeeping" }; navigate("/despachos/x/staff");')])).toEqual([]);
    expect(rotulosProhibidos([f('import { StaffInvite } from "../lib/staff-client.ts";')])).toEqual([]);
    expect(rotulosProhibidos([f("<h2>Clasificación contable</h2> <h2>Equipo</h2>")])).toEqual([]);
  });

  it("detecta un control sin label y acepta las tres formas validas", () => {
    expect(controlesSinLabel([f('<Input id="a" value={v} onChange={(e) => set(e.target.value)} />')])).toHaveLength(1);
    expect(controlesSinLabel([f("<NativeSelect value={v} />")])).toHaveLength(1);
    expect(controlesSinLabel([f('<FormField label="A"><Input id="a" onChange={(e) => x(e)} /></FormField>')])).toEqual([]);
    expect(controlesSinLabel([f('<Textarea aria-label="Nota" />')])).toEqual([]);
    expect(controlesSinLabel([f('<Label htmlFor="b">B</Label><Input id="b" />')])).toEqual([]);
    expect(controlesSinLabel([f('<FormField label="A"><Input id="a" /></FormField><Input id="c" />')])).toHaveLength(1);
  });
});
