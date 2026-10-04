// Geometria del Cerebro: proyeccion Mercator del viewBox 1000x629 (las constantes con las que se horneo el mapa de Likida), distancia
// esferica y casado de la entidad capturada a mano con los 32 estados del mapa.
import { describe, expect, it } from "vitest";
import { ESTADOS_GEO, VIEWBOX_ESTADOS } from "../src/superadmin/cerebro/mexico-estados-geo.ts";
import { estadoDeEntidad, haversineKm, proyectar } from "../src/superadmin/cerebro/geo.ts";

describe("proyectar", () => {
  it("el centro de la CDMX cae dentro del viewBox y dentro del bbox del estado Ciudad de Mexico (o pegado a el)", () => {
    const { x, y } = proyectar(19.4326, -99.1332);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(VIEWBOX_ESTADOS.w);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(VIEWBOX_ESTADOS.h);
    const cdmx = ESTADOS_GEO.find((e) => e.nombre === "Ciudad de México")!;
    expect(Math.abs(x - cdmx.cx)).toBeLessThan(25);
    expect(Math.abs(y - cdmx.cy)).toBeLessThan(25);
  });

  it("al norte y al oeste es menor y/x (el mapa crece hacia el sur y el este)", () => {
    const tijuana = proyectar(32.5149, -117.0382);
    const cancun = proyectar(21.1619, -86.8515);
    expect(tijuana.x).toBeLessThan(cancun.x);
    expect(tijuana.y).toBeLessThan(cancun.y);
  });

  it("los 32 estados del mapa tienen un bbox consistente con su centro", () => {
    expect(ESTADOS_GEO).toHaveLength(32);
    for (const e of ESTADOS_GEO) {
      expect(e.cx).toBeGreaterThanOrEqual(e.bx);
      expect(e.cx).toBeLessThanOrEqual(e.bx + e.bw);
      expect(e.cy).toBeGreaterThanOrEqual(e.by);
      expect(e.cy).toBeLessThanOrEqual(e.by + e.bh);
    }
  });
});

describe("haversineKm", () => {
  it("CDMX a Guadalajara ronda los 460 km y es simetrica", () => {
    const a = { lat: 19.4326, lng: -99.1332 };
    const b = { lat: 20.6597, lng: -103.3496 };
    const d = haversineKm(a, b);
    expect(d).toBeGreaterThan(440);
    expect(d).toBeLessThan(480);
    expect(haversineKm(b, a)).toBeCloseTo(d, 6);
    expect(haversineKm(a, a)).toBe(0);
  });
});

describe("estadoDeEntidad", () => {
  it("casa con o sin acentos, mayusculas y alias de uso comun", () => {
    expect(estadoDeEntidad("yucatan")?.nombre).toBe("Yucatán");
    expect(estadoDeEntidad("  NUEVO LEON ")?.nombre).toBe("Nuevo León");
    expect(estadoDeEntidad("CDMX")?.nombre).toBe("Ciudad de México");
    expect(estadoDeEntidad("Distrito Federal")?.nombre).toBe("Ciudad de México");
    expect(estadoDeEntidad("Estado de México")?.nombre).toBe("México");
    expect(estadoDeEntidad("Coahuila de Zaragoza")?.nombre).toBe("Coahuila");
    expect(estadoDeEntidad("Veracruz de Ignacio de la Llave")?.nombre).toBe("Veracruz");
  });
  it("una entidad vacia o desconocida es null: se dice 'sin plaza', no se inventa estado", () => {
    expect(estadoDeEntidad(null)).toBeNull();
    expect(estadoDeEntidad("")).toBeNull();
    expect(estadoDeEntidad("Atlantida")).toBeNull();
  });
});
