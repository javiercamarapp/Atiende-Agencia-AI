// ds3 / 2.2 -- sanidad de la regla de carga (`REGLA_CARGA_SOLO_LOGO`): demuestra con fixtures que SI falla ante cada una de las cuatro
// formas prohibidas y que no se dispara con el codigo limpio. Es el gemelo de `web-ds-v2-guard-sanidad.spec.ts` (que no se toca: su
// contrato exige un caso por cada regla de REGLAS en baseline 0, y esta regla es un trinquete aparte).
import { describe, expect, it } from "vitest";
import { REGLA_CARGA_SOLO_LOGO, conteoCargaPorArchivo, infractores, sinComentarios, type Fuente } from "./test-utils/ds-v2-guard-reglas";

const fuente = (codigo: string, ruta = "verticals/x/pages/Y.tsx"): Fuente => ({ ruta, codigo: sinComentarios(codigo) });

const CASOS: ReadonlyArray<{ forma: string; viola: string; limpio: string }> = [
  { forma: "animate-spin", viola: '<RefreshCw className="animate-spin" />', limpio: '<IconoDeCarga cargando={cargando} />' },
  { forma: "animate-pulse", viola: '<div className="h-10 animate-pulse rounded" />', limpio: '<CargandoLogo tamano="panel" className="min-h-24" />' },
  { forma: "Skeleton", viola: '<Skeleton className="h-4 w-1/2" />', limpio: "<EstadoCargando />" },
  { forma: "Loader2", viola: '<Loader2 aria-hidden="true" />', limpio: '<RegionCargando etiqueta="Cargando" />' },
];

describe("sanidad: la regla de carga solo-logo falla ante una violacion", () => {
  for (const c of CASOS) {
    it(`detecta ${c.forma} y no el codigo limpio`, () => {
      expect(infractores([fuente(c.viola)], REGLA_CARGA_SOLO_LOGO)).toEqual(["verticals/x/pages/Y.tsx"]);
      expect(infractores([fuente(c.limpio)], REGLA_CARGA_SOLO_LOGO)).toEqual([]);
    });
  }

  it("ignora los comentarios", () => {
    expect(infractores([fuente("// antes era un Loader2 con animate-spin\n<CargandoLogo />")], REGLA_CARGA_SOLO_LOGO)).toEqual([]);
  });

  it("de punta a punta: un archivo infractor nuevo cuenta contra el trinquete y la implementacion no", () => {
    const nuevo: Fuente = { ruta: "apps/web/src/verticals/x/pages/Nueva.tsx", codigo: '<Skeleton /><Loader2 className="animate-spin" />' };
    const impl: Fuente = { ruta: "packages/ui/src/components/CargandoDelegado.tsx", codigo: '<Loader2 className="animate-spin" />' };
    expect(conteoCargaPorArchivo([nuevo, impl])).toEqual({ "apps/web/src/verticals/x/pages/Nueva.tsx": 3 });
  });
});
