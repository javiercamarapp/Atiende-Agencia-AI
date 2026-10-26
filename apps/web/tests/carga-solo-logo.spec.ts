// ds3 / 2.2 -- trinquete de la carga: el unico estado de carga visible es CargandoLogo. Cuenta, por archivo, las ocurrencias de
// `animate-spin|animate-pulse|Skeleton|Loader2` fuera de la implementacion (ver REGLA_CARGA_SOLO_LOGO) y exige que no suban. Cuando bajan, el
// baseline baja con ellas (`carga-solo-logo-baseline.json`); en el retiro del diseno actual (lote 12) debe quedar vacio.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARCHIVOS_IMPLEMENTACION_CARGA, REGLA_CARGA_SOLO_LOGO, cargarFuentesRepo, conteoCargaPorArchivo } from "./test-utils/ds-v2-guard-reglas";

const aqui = dirname(fileURLToPath(import.meta.url));
const raizRepo = resolve(aqui, "..", "..", "..");
const baseline = JSON.parse(readFileSync(join(aqui, "carga-solo-logo-baseline.json"), "utf8")) as { porArchivo: Record<string, number> };
const fuentes = cargarFuentesRepo(raizRepo);
const actual = conteoCargaPorArchivo(fuentes);
const suma = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe("trinquete: la carga solo se pinta con CargandoLogo (ds3 / 2.2)", () => {
  it("escanea el codigo real (no pasa en vacio) y la implementacion existe", () => {
    expect(fuentes.length).toBeGreaterThan(300);
    for (const ruta of ARCHIVOS_IMPLEMENTACION_CARGA) expect(fuentes.some((f) => f.ruta === ruta), ruta).toBe(true);
  });

  it("el conteo distingue una ocurrencia y respeta la implementacion y los comentarios (sanidad)", () => {
    const f = (ruta: string, codigo: string) => ({ ruta, codigo });
    expect(conteoCargaPorArchivo([f("apps/web/src/x.tsx", '<Loader2 className="animate-spin" />')])).toEqual({ "apps/web/src/x.tsx": 2 });
    expect(conteoCargaPorArchivo([f("packages/ui/src/components/CargandoLogo.tsx", "<Loader2 />")])).toEqual({});
    expect(conteoCargaPorArchivo([f("apps/web/src/x.tsx", "<CargandoLogo /> ds-skeleton EstadoCargandoSkeleton")])).toEqual({});
  });

  it("ningun archivo nuevo ni existente suma ocurrencias por encima de su baseline", () => {
    const subieron = Object.entries(actual).filter(([ruta, n]) => n > (baseline.porArchivo[ruta] ?? 0));
    expect(subieron, `${REGLA_CARGA_SOLO_LOGO.nombre}: usa CargandoLogo / EstadoCargando / RegionCargando / IconoDeCarga`).toEqual([]);
  });

  it("cuando una ocurrencia desaparece, el baseline baja con ella (el piso solo desciende)", () => {
    const sobran = Object.entries(baseline.porArchivo).filter(([ruta, n]) => (actual[ruta] ?? 0) < n);
    expect(sobran, `baja carga-solo-logo-baseline.json (total actual ${suma(actual)}, baseline ${suma(baseline.porArchivo)})`).toEqual([]);
  });
});
