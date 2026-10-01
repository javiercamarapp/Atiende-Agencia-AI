// Guard estatico GLOBAL del DS v2 (diseno-ux PR-11 + PR-12): fija en 0 los patrones que el plan
// prohibe en TODO apps/web/src (shell, paginas publicas, componentes, superadmin y las 6 verticales).
// Reemplaza a los 6 guards por vertical (eran un subconjunto de este). Las reglas viven en
// test-utils/ds-v2-guard-reglas.ts y su sanidad (que SI fallan ante una violacion) en
// web-ds-v2-guard-sanidad.spec.ts. Escanea el codigo SIN comentarios. Ver docs/diseno-ux-guard.md.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGLAS, REGLAS_DELEGACION, cargarFuentes, infractores, violacionesDelegacion } from "./test-utils/ds-v2-guard-reglas";

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const FUENTES = cargarFuentes(RAIZ);

// Minimo de archivos por area: evita que un directorio renombrado o vacio haga pasar el guard en falso
// (los umbrales son los de los guards por vertical que este reemplaza).
const AREAS: ReadonlyArray<readonly [string, number]> = [
  ["verticals/restaurantes/", 40],
  ["verticals/hoteles/", 30],
  ["verticals/rentas/", 30],
  ["verticals/despachos/", 30],
  ["verticals/licitaciones/", 30],
  ["superadmin/", 25],
];

describe("apps/web/src — guard global del DS v2 (baseline 0)", () => {
  it("encuentra los archivos de la app (no escanea un directorio vacio)", () => {
    expect(FUENTES.length).toBeGreaterThan(200);
  });

  for (const [prefijo, minimo] of AREAS) {
    it(`escanea al menos ${minimo} archivos en ${prefijo}`, () => {
      expect(FUENTES.filter((f) => f.ruta.startsWith(prefijo)).length).toBeGreaterThan(minimo);
    });
  }

  for (const regla of REGLAS) {
    it(`sin ${regla.nombre}`, () => {
      expect(infractores(FUENTES, regla)).toEqual([]);
    });
  }

  for (const regla of REGLAS_DELEGACION) {
    it(regla.nombre, () => {
      expect(violacionesDelegacion(FUENTES, regla)).toEqual([]);
    });
  }
});
