// Cobertura de colonias de PM por radio de 8 km: la regla (sucursal de despacho activa mas cercana, 8 km o menos, limite inclusivo), el dataset versionado
// y los archivos generados (SQL de carga, SQL de verificacion, documento). Puro: sin base, sin reloj, sin zonas horarias.
// La pieza del dataset recalcula con SU PROPIO Haversine (no importa el de la regla) para que un error del modulo no se oculte a si mismo.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RADIO_TIERRA_KM, SUCURSALES_DESPACHO, calcularColonias, masCercanaDentroDelRadio, renderCargaSql, renderDocumento, renderVerificaSql, resumir } from "../src/seed/colonias-radio-8km.ts";
import type { PmSeedColonia } from "../src/seed/pm-demo.ts";
import { RUTA_CARGA, RUTA_DOCUMENTO, RUTA_VERIFICA } from "../../../scripts/seed-pm-demo/generar-colonias-8km.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/inputs.ts";

const { data } = loadSeedInputs();
const colonias = data.colonias as readonly PmSeedColonia[];

// Haversine independiente del modulo (misma formula, escrita aparte a proposito).
function kmEntre(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
const pinesDatos = Object.fromEntries(SUCURSALES_DESPACHO.map((id) => [id, data.sucursales.find((b) => b.id === id)!.coordenadas_propuestas!])) as Record<string, { lat: number; lng: number }>;

/** Coordenada al norte de `origen` a exactamente `km` kilometros (a lo largo del meridiano la distancia es R * delta-latitud). */
function alNorte(origen: { lat: number; lng: number }, km: number) {
  return { lat: origen.lat + (km / RADIO_TIERRA_KM) * (180 / Math.PI), lng: origen.lng };
}

/** La comprobacion que debe fallar si una asignacion no es la mas cercana a 8 km o menos. Devuelve las violaciones. */
function violaciones(lista: readonly PmSeedColonia[]): string[] {
  const malas: string[] = [];
  for (const c of lista) {
    const asignadas = c.sucursales ?? [];
    if (asignadas.some((id) => id === "T4" || id === "T5")) malas.push(`${c.nombre}: asignada a una sucursal que no reparte`);
    if (!c.coordenada) {
      // Sin coordenada solo se admite la cobertura explicita del dueño (chats) o ninguna.
      if (asignadas.length > 0 && c.asignacion !== "chats_t7") malas.push(`${c.nombre}: asignada sin coordenada`);
      continue;
    }
    const ranking = SUCURSALES_DESPACHO.map((id) => ({ id, km: kmEntre(c.coordenada!, pinesDatos[id]!) })).sort((a, b) => a.km - b.km);
    const mejor = ranking[0]!;
    const esperado = mejor.km <= 8 ? [mejor.id] : [];
    if (JSON.stringify(asignadas) !== JSON.stringify(esperado)) malas.push(`${c.nombre}: tiene [${asignadas}] y la mas cercana a 8 km o menos es [${esperado}] (${mejor.km.toFixed(2)} km)`);
  }
  return malas;
}

describe("regla: sucursal de despacho mas cercana a 8 km o menos", () => {
  const pin = { lat: 21, lng: -89.6 };

  it("limite inclusivo: 7.99 y 8.00 km entran; 8.01 km queda fuera de cobertura", () => {
    const a = masCercanaDentroDelRadio(alNorte(pin, 7.99), { T1: pin });
    const b = masCercanaDentroDelRadio(alNorte(pin, 8.0), { T1: pin });
    const c = masCercanaDentroDelRadio(alNorte(pin, 8.01), { T1: pin });
    expect(a.primera.km).toBeCloseTo(7.99, 6);
    expect(a.asignada).toBe("T1");
    expect(b.primera.km).toBeCloseTo(8.0, 6);
    expect(b.asignada).toBe("T1");
    expect(c.primera.km).toBeCloseTo(8.01, 6);
    expect(c.asignada).toBeNull();
    expect(c.fuera).toBe(true);
    // Las tres estan a menos de 300 m del limite: borde.
    for (const r of [a, b, c]) expect(r.borde).toContain("limite_8km");
  });

  it("a mas de 300 m del limite no es borde (7.69 y 8.31 km)", () => {
    expect(masCercanaDentroDelRadio(alNorte(pin, 7.69), { T1: pin }).borde).toEqual([]);
    expect(masCercanaDentroDelRadio(alNorte(pin, 8.31), { T1: pin }).borde).toEqual([]);
  });

  it("empate exacto: la misma distancia se rompe por el orden T1, T2, T3, T7, T8 y se marca borde", () => {
    const punto = { lat: 21, lng: -89.6 };
    // Dos pines simetricos al este y al oeste del punto: misma distancia (Haversine simetrico en longitud).
    const km = 3;
    const dLng = (km / (RADIO_TIERRA_KM * Math.cos((21 * Math.PI) / 180))) * (180 / Math.PI);
    const pines = { T3: { lat: 21, lng: -89.6 + dLng }, T1: { lat: 21, lng: -89.6 - dLng } };
    const r = masCercanaDentroDelRadio(punto, pines);
    expect(Math.abs(r.candidatas[0]!.km - r.candidatas[1]!.km)).toBeLessThan(1e-9);
    expect(r.asignada).toBe("T1");
    expect(r.borde).toContain("empate");
    // Cambiar el orden cambia el desempate, no la distancia.
    expect(masCercanaDentroDelRadio(punto, pines, { orden: ["T3", "T1"] }).asignada).toBe("T3");
  });

  it("casi empate (dentro de 300 m) es borde; una segunda sucursal fuera del radio no cuenta como empate", () => {
    const base = { lat: 21, lng: -89.6 };
    const r = masCercanaDentroDelRadio(base, { T1: alNorte(base, 5), T2: alNorte(base, 5.2) });
    expect(r.asignada).toBe("T1");
    expect(r.borde).toEqual(["empate"]);
    const lejos = masCercanaDentroDelRadio(base, { T1: alNorte(base, 7.9), T2: alNorte(base, 8.1) });
    expect(lejos.asignada).toBe("T1");
    expect(lejos.borde).toEqual(["limite_8km"]);
    const claro = masCercanaDentroDelRadio(base, { T1: alNorte(base, 5), T2: alNorte(base, 5.5) });
    expect(claro.borde).toEqual([]);
  });

  it("solo compiten las sucursales de despacho: T4 y T5 nunca son candidatas aunque haya pin", () => {
    const todas = { ...pinesDatos, T4: { lat: 21.039541, lng: -89.6311778 }, T5: { lat: 21.2945018, lng: -89.6087611 } };
    const r = masCercanaDentroDelRadio({ lat: 21.039541, lng: -89.6311778 }, todas);
    expect(r.candidatas.map((c) => c.id).sort()).toEqual([...SUCURSALES_DESPACHO].sort());
  });
});

describe("dataset de colonias de PM contra la regla (recalculado con Haversine)", () => {
  it("cada colonia asignada va a la sucursal de despacho mas cercana a 8 km o menos; las demas no tienen cobertura", () => {
    expect(violaciones(colonias)).toEqual([]);
  });

  it("la comprobacion FALLA si una asignacion no es la mas cercana (Centro en T1), si pasa de 8 km o si va a una sucursal sin reparto", () => {
    const centro = colonias.find((c) => c.nombre === "Centro")!;
    const conT1 = colonias.map((c) => (c === centro ? { ...c, sucursales: ["T1"] } : c));
    expect(violaciones(conT1).join("\n")).toMatch(/Centro: tiene \[T1\] y la mas cercana a 8 km o menos es \[T3\]/);
    const progreso = colonias.find((c) => c.nombre === "Progreso")!;
    expect(violaciones(colonias.map((c) => (c === progreso ? { ...c, sucursales: ["T2"] } : c))).join("\n")).toMatch(/Progreso: tiene \[T2\] y la mas cercana a 8 km o menos es \[\]/);
    expect(violaciones(colonias.map((c) => (c === centro ? { ...c, sucursales: ["T4"] } : c))).join("\n")).toMatch(/Centro: asignada a una sucursal que no reparte/);
    const olivos = colonias.find((c) => c.nombre === "Olivos")!;
    expect(violaciones(colonias.map((c) => (c === olivos ? { ...c, sucursales: ["T1"] } : c))).join("\n")).toMatch(/Olivos: asignada sin coordenada/);
  });

  it("la regla calculada por el modulo coincide con el dataset y con el recalculo independiente", () => {
    for (const f of calcularColonias(data)) {
      const c = colonias.find((x) => x.nombre === f.nombre)!;
      expect(f.esperado, f.nombre).toEqual(c.sucursales ?? []);
      if (c.coordenada) {
        const mejor = SUCURSALES_DESPACHO.map((id) => kmEntre(c.coordenada!, pinesDatos[id]!)).sort((a, b) => a - b)[0]!;
        expect(f.masCercanaSiempre!.km, f.nombre).toBeCloseTo(mejor, 9);
      }
    }
  });

  it("resuelve las decisiones abiertas: Centro y Centro Historico a T3, Benito Juarez Norte a T1 (borde), Real Montejo a T2", () => {
    const por = (n: string) => calcularColonias(data).find((f) => f.nombre === n)!;
    expect(por("Centro").esperado).toEqual(["T3"]);
    expect(por("Centro Histórico").esperado).toEqual(["T3"]);
    expect(por("Benito Juárez Norte").esperado).toEqual(["T1"]);
    expect(por("Benito Juárez Norte").borde).toContain("empate");
    expect(por("Real Montejo").esperado).toEqual(["T2"]);
    for (const n of ["Centro", "Centro Histórico", "Benito Juárez Norte", "Real Montejo"]) {
      const c = colonias.find((x) => x.nombre === n)!;
      expect(c.asignacion, n).toBe("mas_cercana_v3");
      expect(c.pendiente_dueno, n).toBeUndefined();
    }
  });

  it("conteos: 167 asignadas (165 por la regla + Cabo Norte y Los Pinos del dueño), 13 a mas de 8 km y 6 sin coordenada; T4 y T5 sin colonias", () => {
    const filas = calcularColonias(data);
    const r = resumir(filas);
    expect(filas.length).toBe(186);
    expect(r.asignadas).toBe(167);
    expect(filas.filter((f) => f.regla === "mas_cercana").length).toBe(165);
    expect(filas.filter((f) => f.regla === "explicita_dueno").map((f) => f.nombre).sort()).toEqual(["Cabo Norte", "Los Pinos"]);
    expect(r.fuera.length).toBe(13);
    expect(r.sinCoordenada.map((f) => f.nombre).sort()).toEqual(["Cecilio Chi", "Nueva Salvador Alvarado Sur", "Olivos", "Revolución Cordemex", "San Diego Cutz", "Yucatán"]);
    expect(r.coloniasPorSucursal).toEqual({ T1: 44, T2: 31, T3: 37, T7: 23, T8: 32 });
    // Base real del 8-oct-2026: 169 filas (51/24/33/29/32) -> 175 (46/32/39/24/34) con +30 altas, -24 reemplazos y 5 sobrantes sin tocar.
    expect(r.antesPorSucursal).toEqual({ T1: 51, T2: 24, T3: 33, T7: 29, T8: 32 });
    expect(r.despuesPorSucursal).toEqual({ T1: 46, T2: 32, T3: 39, T7: 24, T8: 34 });
    expect(r.altas).toBe(30);
    expect(r.reemplazos).toBe(24);
    expect(r.sobrantes.map((f) => f.nombre).sort()).toEqual(["Mulchechen", "Revolución Cordemex", "Salvador Alvarado Sur", "Santa Maria Chi", "Yucatán"]);
    expect(colonias.every((c) => !(c.sucursales ?? []).some((id) => id === "T4" || id === "T5"))).toBe(true);
  });

  it("las colonias fuera de cobertura y las de borde cercanas al limite quedan marcadas", () => {
    const filas = calcularColonias(data);
    const borde = (n: string) => filas.find((f) => f.nombre === n)!.borde;
    expect(borde("Quinta Real")).toContain("limite_8km"); // 7.80 km, asignada a T7
    expect(borde("Serapio Rendón")).toContain("limite_8km"); // 8.09 km, fuera
    expect(borde("Komchen")).toContain("limite_8km"); // 8.24 km, fuera
    expect(borde("Mulchechen")).toEqual([]); // 8.42 km
    expect(filas.filter((f) => f.borde.length > 0).length).toBe(26);
  });
});

describe("archivos generados", () => {
  it("el SQL de carga, el de verificacion y el documento estan sincronizados con los datos (regenerar con generar-colonias-8km.ts)", () => {
    expect(readFileSync(RUTA_CARGA, "utf8")).toBe(renderCargaSql(data));
    expect(readFileSync(RUTA_VERIFICA, "utf8")).toBe(renderVerificaSql(data));
    expect(readFileSync(RUTA_DOCUMENTO, "utf8")).toBe(renderDocumento(data));
  });

  it("el SQL de carga es transaccional, aborta con comprobaciones, no hace DELETE masivo ni toca coordenadas, sucursales ni la cuenta demo", () => {
    const sql = renderCargaSql(data);
    expect(sql).toMatch(/^begin;$/m);
    expect(sql).toMatch(/^commit;$/m);
    expect(sql.match(/raise exception/g)!.length).toBeGreaterThanOrEqual(6);
    // El unico DELETE es por pares (colonia, sucursal) contra la lista, con tope.
    const deletes = sql.match(/delete from [^\n]*/g) ?? [];
    expect(deletes).toEqual(["delete from restaurantes.branch_delivery_zone b using sobra s"]);
    expect(sql).toMatch(/c_max_reemplazos constant integer := 24;/);
    expect(sql).toMatch(/on conflict \(property_id, zone_id\) do nothing/);
    const sinComentarios = sql.replace(/--[^\n]*/g, "");
    expect(sinComentarios).not.toMatch(/\bupdate core\.property\b|\bupdate restaurantes\.branch_detail\b|\bwhatsapp_branch_channel\b|\bset lat\b|\bset lng\b|\btruncate\b|\bdrop table\b/i);
    expect(sql).not.toMatch(/los-taquitos-de-pm-demo|demo-restaurantes/);
    expect(sql).toContain("'los-taquitos-de-pm'");
    // Sin T4 ni T5 como destino (galerias, playa solo aparecen en la comprobacion de que NO tengan cobertura).
    const valores = sql.slice(sql.indexOf("insert into _cob8"), sql.indexOf("create temp table _sin8"));
    expect(valores).not.toMatch(/'galerias'|'playa'/);
    expect((valores.match(/^ {2}\(/gm) ?? []).length).toBe(167);
  });

  it("el SQL de verificacion es de solo lectura y recalcula en la base", () => {
    const sql = renderVerificaSql(data);
    const sinComentarios = sql.replace(/--[^\n]*/g, "");
    expect(sinComentarios).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant)\b/i);
    expect(sinComentarios).toMatch(/asin\(least\(1, sqrt\(/);
    expect(sinComentarios).toMatch(/'PASA'/);
    expect((sql.match(/^ {2}\('/gm) ?? []).length).toBe(5 + 178 + 6 + 2);
  });
});
