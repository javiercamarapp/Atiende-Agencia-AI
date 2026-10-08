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
    const explicita = c.asignacion === "chats_t7" || c.asignacion === "dueno_zona_centro";
    if (!c.coordenada) {
      // Sin coordenada solo se admite la cobertura explicita del dueño (chats) o ninguna.
      if (asignadas.length > 0 && !explicita) malas.push(`${c.nombre}: asignada sin coordenada`);
      continue;
    }
    // Criterio conservador: la cobertura EXPLICITA del dueño manda sobre la geometria (se documenta aparte); no se juzga contra la regla.
    if (explicita && asignadas.length > 0) continue;
    // Homonimo pendiente del dueño (San Jose): sin asignar aunque la coordenada elegida caiga dentro del radio.
    if (asignadas.length === 0 && c.pendiente_dueno?.includes("homonimo_discrepancia")) continue;
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

  it("la comprobacion FALLA si una asignacion no es la mas cercana (Buenavista en T3), si pasa de 8 km o si va a una sucursal sin reparto", () => {
    const buenavista = colonias.find((c) => c.nombre === "Buenavista")!;
    const conT3 = colonias.map((c) => (c === buenavista ? { ...c, sucursales: ["T3"] } : c));
    expect(violaciones(conT3).join("\n")).toMatch(/Buenavista: tiene \[T3\] y la mas cercana a 8 km o menos es \[T1\]/);
    const progreso = colonias.find((c) => c.nombre === "Progreso")!;
    expect(violaciones(colonias.map((c) => (c === progreso ? { ...c, sucursales: ["T2"] } : c))).join("\n")).toMatch(/Progreso: tiene \[T2\] y la mas cercana a 8 km o menos es \[\]/);
    expect(violaciones(colonias.map((c) => (c === buenavista ? { ...c, sucursales: ["T4"] } : c))).join("\n")).toMatch(/Buenavista: asignada a una sucursal que no reparte/);
    const olivos = colonias.find((c) => c.nombre === "Olivos")!;
    expect(violaciones(colonias.map((c) => (c === olivos ? { ...c, sucursales: ["T1"] } : c))).join("\n")).toMatch(/Olivos: asignada sin coordenada/);
    // San Jose (homonimo pendiente) solo se salta mientras siga sin asignar ni retirado de pendientes.
    const sanJose = colonias.find((c) => c.nombre === "San Jose")!;
    expect(sanJose.sucursales).toEqual([]);
    expect(violaciones(colonias.map((c) => (c === sanJose ? { ...c, sucursales: ["T1"] } : c))).join("\n")).toMatch(/San Jose: tiene \[T1\]/);
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

  it("criterio conservador: Centro, Centro Historico, Benito Juarez Norte y Real Montejo son explicitas del dueño que DIFIEREN de la regla (T1, T1, T7, T7 contra T3, T3, T1, T2), con su etiqueta", () => {
    const por = (n: string) => calcularColonias(data).find((f) => f.nombre === n)!;
    const esperado: Array<[string, string, string, string]> = [
      ["Centro", "T1", "T3", "dueno_zona_centro"],
      ["Centro Histórico", "T1", "T3", "dueno_zona_centro"],
      ["Benito Juárez Norte", "T7", "T1", "chats_t7"],
      ["Real Montejo", "T7", "T2", "chats_t7"],
    ];
    for (const [n, dueno, regla, etiqueta] of esperado) {
      const f = por(n);
      expect(f.regla, n).toBe("explicita_dueno");
      expect(f.esperado, n).toEqual([dueno]);
      expect(f.opcionRegla?.sucursal, n).toBe(regla);
      expect(f.difiereDeLaRegla, n).toBe(true);
      expect(f.etiqueta, n).toBe(etiqueta);
      expect(colonias.find((c) => c.nombre === n)!.asignacion, n).toBe(etiqueta);
    }
    expect(por("Benito Juárez Norte").borde).toContain("empate"); // 59 m
    // Cabo Norte y Los Pinos: explicitas sin coordenada (no hay distancia que comparar).
    expect(por("Cabo Norte")).toMatchObject({ regla: "explicita_dueno", esperado: ["T7"], opcionRegla: null });
    expect(por("Los Pinos")).toMatchObject({ regla: "explicita_dueno", esperado: ["T8"], opcionRegla: null });
  });

  it("San Jose (homonimo con lecturas a 11.4 km entre si) queda pendiente del dueño y sin asignar; los otros 8 homonimos se asignan y llevan REVISAR", () => {
    const filas = calcularColonias(data);
    expect(filas.find((f) => f.nombre === "San Jose")).toMatchObject({ regla: "homonimo_pendiente", esperado: [] });
    for (const n of ["Arboledas", "Chuburná", "Dzitya", "Los Reyes", "San Angel", "San Luis", "Vergel", "Yucalpeten"]) {
      const f = filas.find((x) => x.nombre === n)!;
      expect(f.regla, n).toBe("mas_cercana");
      expect(f.homonimoKm, n).toBeGreaterThan(1);
      expect(colonias.find((c) => c.nombre === n)!.revisar, n).toBe(true);
    }
    expect(renderDocumento(data)).toMatch(/REVISAR, homonimo: Google y OSM difieren 8\.\d\d km/); // San Angel
  });

  it("conteos: 166 asignadas (160 por la regla + 6 explicitas del dueño), 13 a mas de 8 km, 6 sin coordenada y 1 homonimo pendiente; T4 y T5 sin colonias", () => {
    const filas = calcularColonias(data);
    const r = resumir(filas);
    expect(filas.length).toBe(186);
    expect(r.asignadas).toBe(166);
    expect(filas.filter((f) => f.regla === "mas_cercana").length).toBe(160);
    expect(r.explicitas.map((f) => f.nombre).sort()).toEqual(["Benito Juárez Norte", "Cabo Norte", "Centro", "Centro Histórico", "Los Pinos", "Real Montejo"]);
    expect(r.fuera.length).toBe(13);
    expect(r.sinCoordenada.map((f) => f.nombre).sort()).toEqual(["Cecilio Chi", "Nueva Salvador Alvarado Sur", "Olivos", "Revolución Cordemex", "San Diego Cutz", "Yucatán"]);
    expect(r.homonimosPendientes.map((f) => f.nombre)).toEqual(["San Jose"]);
    expect(r.coloniasPorSucursal).toEqual({ T1: 45, T2: 30, T3: 34, T7: 25, T8: 32 });
    // Base real del 8-oct-2026: 169 filas (51/24/33/29/32) -> 171 (46/31/35/26/33) con +25 altas, -20 reemplazos y -3 retiros de colonias a mas de 8 km.
    expect(r.antesPorSucursal).toEqual({ T1: 51, T2: 24, T3: 33, T7: 29, T8: 32 });
    expect(r.despuesPorSucursal).toEqual({ T1: 46, T2: 31, T3: 35, T7: 26, T8: 33 });
    expect(r.altas).toBe(25);
    expect(r.reemplazos).toBe(20);
    expect(r.retirosFuera.map((f) => `${f.nombre}:${f.antes}`).sort()).toEqual(["Mulchechen:T1", "Salvador Alvarado Sur:T3", "Santa Maria Chi:T8"]);
    expect(r.sobrantes.map((f) => f.nombre).sort()).toEqual(["Revolución Cordemex", "Yucatán"]);
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
    expect(deletes).toEqual(["delete from restaurantes.branch_delivery_zone b using sobra s", "delete from restaurantes.branch_delivery_zone b using restaurantes.known_zone z"]);
    expect(sql).toMatch(/c_max_reemplazos constant integer := 20;/);
    expect(sql).toMatch(/c_max_retiros constant integer := 3;/);
    // Los retiros son SOLO de las colonias a mas de 8 km (motivo 'fuera_de_8km'), nunca de las sin coordenada ni del homonimo pendiente.
    expect(sql).toMatch(/s\.motivo = 'fuera_de_8km'/);
    expect(sql).toMatch(/\('San Jose', 'homonimo_pendiente'\)/);
    expect(sql).toMatch(/on conflict \(property_id, zone_id\) do nothing/);
    const sinComentarios = sql.replace(/--[^\n]*/g, "");
    expect(sinComentarios).not.toMatch(/\bupdate core\.property\b|\bupdate restaurantes\.branch_detail\b|\bwhatsapp_branch_channel\b|\bset lat\b|\bset lng\b|\btruncate\b|\bdrop table\b/i);
    expect(sql).not.toMatch(/los-taquitos-de-pm-demo|demo-restaurantes/);
    expect(sql).toContain("'los-taquitos-de-pm'");
    // Sin T4 ni T5 como destino (galerias, playa solo aparecen en la comprobacion de que NO tengan cobertura).
    const valores = sql.slice(sql.indexOf("insert into _cob8"), sql.indexOf("create temp table _sin8"));
    expect(valores).not.toMatch(/'galerias'|'playa'/);
    expect((valores.match(/^ {2}\(/gm) ?? []).length).toBe(166);
    expect(valores).toMatch(/\('Centro', 'prol-montejo', [\d.]+, 'dueno_zona_centro'\)/);
    expect(valores).toMatch(/\('Real Montejo', 'garcia-lavin', [\d.]+, 'chats_t7'\)/);
  });

  it("el SQL de verificacion es de solo lectura y recalcula en la base", () => {
    const sql = renderVerificaSql(data);
    const sinComentarios = sql.replace(/--[^\n]*/g, "");
    expect(sinComentarios).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant)\b/i);
    expect(sinComentarios).toMatch(/asin\(least\(1, sqrt\(/);
    expect(sinComentarios).toMatch(/'PASA'/);
    expect((sql.match(/^ {2}\('/gm) ?? []).length).toBe(5 + 173 + 7 + 6);
    // Una colonia a mas de 8 km que conserva cobertura es DIFERENCIA (FALLA), no un sobrante informativo.
    expect(sinComentarios).toMatch(/when u\.esperado_slug is null then case when c\.slugs is null then 'ok_fuera_de_cobertura' else 'DIFERENCIA' end/);
  });
});
