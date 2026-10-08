// import-orig-01 -- sucursal de DESPACHO mas cercana con radio de 8 km (decisiones de Javier, 7-oct-2026 13:30 y 17:50).
//
// Cierra los hallazgos de la revision de #500 en el CODIGO del agente:
//   (a) el tope de reparto de `taqueria_pm` baja de 20 a 8 km (configurable por organizacion);
//   (b) `buscar_sucursal_cercana` nombra la sucursal de despacho mas cercana y su distancia aproximada, y dice «fuera de zona habitual» sin prometer envio;
//   (c) una colonia con DOBLE cobertura elige una sucursal (nunca `no_reconocida`);
//   (d) coordenadas propuestas (pines de Google) detras de una bandera APAGADA por omision;
//   (e) la cobertura explicita del dueño (Cabo Norte, Los Pinos; y cualquier override futuro) manda sobre la geometria; Centro, Centro Historico, Benito Juarez Norte y
//       Real Montejo ya NO son override: Javier (8-oct) resolvio que manda la regla de 8 km;
//   (f) las 19 colonias que quedan fuera de cobertura (13 a mas de 8 km, 6 sin coordenada) dan una respuesta honesta, sin inventar.
// Los datos son los REALES del seed (`pm-seed-data.json`, colonias-v3): coordenadas de Google de las colonias y de las 5 sucursales de despacho.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import {
  assignBranch,
  EMPATE_DOBLE_COBERTURA_KM,
  RADIO_REPARTO_PM_KM,
  RADIO_REPARTO_POR_OMISION_KM,
  radioRepartoDelPerfil,
  type BranchAssignment,
} from "../src/branch-assignment.ts";
import { BANDERA_COORDENADAS_PROPUESTAS, COORDENADAS_PROPUESTAS_PM, coordenadasPropuestasActivas } from "../src/coordenadas-sucursales.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { haversineKm, haversineKmExact, kmAproxTexto, normalizeZoneText } from "../src/nearest-branch.ts";
import { quoteOrder } from "../src/orders.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
type Colonia = NonNullable<typeof data.colonias>[number];
const COLONIAS = data.colonias ?? [];
const SUCURSALES = data.sucursales;
const slugDe = (id: string): string => SUCURSALES.find((s) => s.id === id)!.slug;
const nombreDe = (slug: string): string => SUCURSALES.find((s) => s.slug === slug)!.nombre;
const colonia = (nombre: string): Colonia => {
  const c = COLONIAS.find((x) => normalizeZoneText(x.nombre) === normalizeZoneText(nombre));
  if (!c) throw new Error(`colonia de muestra no encontrada en los datos: ${nombre}`);
  return c;
};

/** Mundo en memoria con las colonias REALES. `coordenadas` = el dueño cargo la coordenada de Google de cada colonia en known_zone (HOY no: ver `colonias_meta`);
 * `cobertura` = filas de branch_delivery_zone (seed = la del dueño/regla en el seed; base_real = la que tiene la cuenta real, con 14 dobles; ninguna). */
async function mundo(opts: { coordenadas: boolean; cobertura: "seed" | "base_real" | "ninguna" | "solo_dueno"; invertirOrden?: boolean; vigentesCompletas?: boolean }) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const propertyBySlug = new Map<string, string>();
  const sucursales = opts.invertirOrden ? [...SUCURSALES].reverse() : SUCURSALES;
  for (const s of sucursales) {
    const propertyId = randomUUID();
    propertyBySlug.set(s.slug, propertyId);
    const reparte = ["T1", "T2", "T3", "T7", "T8"].includes(s.id);
    // Coordenadas VIGENTES de main (T3 sin coordenadas; T4 y T5 no reparten: inactivas).
    // `vigentesCompletas`: la base tiene coordenada vigente en TODAS las sucursales de despacho (T3 incluida): la medicion es confiable sin pines propuestos.
    const t3 = opts.vigentesCompletas && s.id === "T3" ? COORDENADAS_PROPUESTAS_PM["pensiones"]! : null;
    repo.seedBranch({ propertyId, organizationId, name: s.nombre, slug: s.slug, status: reparte ? "active" : "inactive", phone: null, address: null, lat: t3 ? t3.lat : (s.lat ?? null), lng: t3 ? t3.lng : (s.lng ?? null) });
    // Galerias y Playa tienen acepta_domicilio=true en la base real: solo las excluye estar inactivas o la lista del perfil PM.
    repo.seedBranchPolicy(propertyId, { aceptaDomicilio: s.id === "T4" || s.id === "T5" ? true : reparte });
  }
  const cobertura = new Map<string, string[]>();
  const idPorNombre = new Map<string, string>();
  for (const c of COLONIAS) {
    const id = randomUUID();
    idPorNombre.set(c.nombre, id);
    const ref = c.referencia;
    repo.seedKnownZone({
      id,
      organizationId,
      name: c.nombre,
      lat: opts.coordenadas && c.coordenada ? c.coordenada.lat : null,
      lng: opts.coordenadas && c.coordenada ? c.coordenada.lng : null,
      fuente: c.fuente,
      asignacionFuente: c.asignacion,
      refSucursalSlug: ref ? slugDe(ref.sucursal) : null,
      refKm: ref ? ref.km : null,
      ref2SucursalSlug: ref ? slugDe(ref.segunda) : null,
      ref2Km: ref ? ref.segunda_km : null,
    });
    const ids =
      opts.cobertura === "seed"
        ? (c.sucursales ?? [])
        : opts.cobertura === "base_real"
          ? ((c as unknown as { cobertura_base_real?: string[] }).cobertura_base_real ?? [])
          : opts.cobertura === "solo_dueno"
            ? c.asignacion === "mas_cercana_v3" || c.asignacion === "sin_asignar" ? [] : (c.sucursales ?? [])
            : [];
    for (const t of ids) cobertura.set(slugDe(t), [...(cobertura.get(slugDe(t)) ?? []), id]);
  }
  for (const [slug, zonas] of cobertura) repo.seedBranchDeliveryZones(propertyBySlug.get(slug)!, zonas);
  await repo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
  return { repo, organizationId, propertyBySlug, idPorNombre };
}

const PIN_PROPUESTAS = { coordenadasPropuestas: COORDENADAS_PROPUESTAS_PM };
const ctxWa = (organizationId: string) => ({ organizationId, channel: "whatsapp" as const, phone: "9991234567" });
const ctxVoz = (organizationId: string) => ({ organizationId, channel: "voz" as const, phone: "9991234567" });

describe("calculo de distancia: Haversine con puntos conocidos y texto «a unos N km»", () => {
  it("un grado de latitud mide ~111.2 km y dos puntos iguales miden 0", () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 1);
    expect(haversineKm(21.0093272, -89.6135974, 21.0093272, -89.6135974)).toBe(0);
  });

  it("Londres a Paris son ~343.5 km (punto de referencia publico)", () => {
    expect(haversineKmExact(51.5074, -0.1278, 48.8566, 2.3522)).toBeCloseTo(343.5, 0);
  });

  it("reproduce los km de colonias-v3 (Google) con el pin de la sucursal: Montecristo a Prolongacion Montejo 1.94 km, Komchen a Francisco de Montejo 8.24 km", () => {
    const t1 = COORDENADAS_PROPUESTAS_PM["prol-montejo"]!;
    const t2 = COORDENADAS_PROPUESTAS_PM["fco-montejo"]!;
    const montecristo = colonia("Montecristo").coordenada!;
    const komchen = colonia("Komchen").coordenada!;
    expect(haversineKmExact(montecristo.lat, montecristo.lng, t1.lat, t1.lng)).toBeCloseTo(1.94, 1);
    expect(haversineKmExact(komchen.lat, komchen.lng, t2.lat, t2.lng)).toBeCloseTo(8.24, 1);
  });

  it("el texto para el cliente no lleva decimales raros", () => {
    expect(kmAproxTexto(4.6)).toBe("a unos 5 km");
    expect(kmAproxTexto(9.57)).toBe("a unos 10 km");
    expect(kmAproxTexto(1.2)).toBe("a cerca de 1 km");
    expect(kmAproxTexto(1.5)).toBe("a unos 2 km");
    expect(kmAproxTexto(0.3)).toBe("a menos de 1 km");
    expect(kmAproxTexto(Number.NaN)).toBe("");
  });
});

describe("radio de reparto: 8 km en el perfil PM, configurable por organizacion", () => {
  it("taqueria_pm = 8 km; los demas perfiles conservan su comportamiento (sin tope duro) salvo que la organizacion configure uno", () => {
    expect(RADIO_REPARTO_PM_KM).toBe(8);
    expect(RADIO_REPARTO_POR_OMISION_KM).toBe(20);
    expect(radioRepartoDelPerfil("taqueria_pm")).toBe(8);
    expect(radioRepartoDelPerfil("generico")).toBeNull();
    expect(radioRepartoDelPerfil("taqueria_pm", 5)).toBe(5);
    expect(radioRepartoDelPerfil("generico", 12)).toBe(12);
    // Un valor invalido de la configuracion nunca abre ni cierra el reparto por accidente.
    for (const malo of [0, -3, Number.NaN, 900, null, undefined]) expect(radioRepartoDelPerfil("taqueria_pm", malo as never)).toBe(8);
  });

  it("(a) un pin a 9.6 km (Komchen) y a 9.9 km (Serapio Rendon) de las coordenadas VIGENTES ya NO se asigna: fuera de zona habitual (antes, con 20 km, si)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed", vigentesCompletas: true });
    for (const nombre of ["Komchen", "Serapio Rendón"]) {
      const { lat, lng } = colonia(nombre).coordenada!;
      const antes = await assignBranch(m.repo, { organizationId: m.organizationId, lat, lng, radioMaximoKm: 20 });
      expect(antes.estado, `${nombre} con el tope anterior de 20 km`).toBe("asignada");
      const ahora = await assignBranch(m.repo, { organizationId: m.organizationId, lat, lng, radioMaximoKm: RADIO_REPARTO_PM_KM });
      expect(ahora.estado, nombre).toBe("fuera_de_zona");
      if (ahora.estado === "fuera_de_zona") {
        expect(ahora.maxKm).toBe(8);
        expect(ahora.distanceKm).toBeGreaterThan(8);
        expect(ahora.origen).toBe("pin");
      }
    }
    const komchen = await assignBranch(m.repo, { organizationId: m.organizationId, ...colonia("Komchen").coordenada!, radioMaximoKm: 8 });
    expect(komchen).toMatchObject({ branchSlug: "fco-montejo", distanceKm: 9.6 });
    const serapio = await assignBranch(m.repo, { organizationId: m.organizationId, ...colonia("Serapio Rendón").coordenada!, radioMaximoKm: 8 });
    // Con Pensiones medible (su pin como vigente) la mas cercana es Pensiones, a 8.1 km: aun asi fuera del radio.
    expect(serapio).toMatchObject({ estado: "fuera_de_zona", branchSlug: "pensiones", distanceKm: 8.1 });
  });

  it("la herramienta de PM aplica 8 km aunque el modelo mande max_km 500; una organizacion que configura 5 km lo recorta; el modelo solo puede bajarlo", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed", vigentesCompletas: true });
    const komchen = colonia("Komchen").coordenada!;
    const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { ...komchen, max_km: 500 });
    expect(r.result).toMatchObject({ encontrada: false, estado: "fuera_de_zona", max_km: 8, reparto: "fuera_de_zona_habitual" });

    const montecristo = colonia("Montecristo").coordenada!; // ~0.3 km de la altabrisa vigente
    expect((await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { ...montecristo })).result).toMatchObject({ encontrada: true });
    // Una organizacion con radio propio de 2 km: un pin a ~3.7 km de la sucursal mas cercana queda fuera.
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [], radioRepartoKm: 2 });
    const lejos = colonia("Mulsay").coordenada!;
    expect((await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { ...lejos })).result).toMatchObject({ estado: "fuera_de_zona", max_km: 2 });
  });

  it("un perfil generico sin configuracion NO hereda el tope (regresion: pm-r2-no-bloqueantes-revision)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, { perfil: "generico", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { ...colonia("Progreso").coordenada! });
    expect(r.result).toMatchObject({ encontrada: true, estado: "asignada" });
  });
});

// Las 26 colonias de muestra: las 4 del dueño, las dos de 9.6 y 9.9 km, doble cobertura, pendientes de cada tipo y asignadas de cada sucursal.
const MUESTRA = [
  "Centro",
  "Centro Histórico",
  "Benito Juárez Norte",
  "Real Montejo",
  "Komchen",
  "Serapio Rendón",
  "Montecristo",
  "Mulsay",
  "Vergel",
  "Alcala Martin",
  "Alemán",
  "Algarrobos Residencial",
  "Montealban",
  "Plan de Ayala",
  "Temozón Norte",
  "Montebello",
  "Los Pinos",
  "México",
  "Arboledas",
  "Cecilio Chi",
  "Olivos",
  "Chicxulub",
  "Progreso",
  "San Jose Tzal",
  "Santa Maria Chi",
  "Roble Agrícola",
  "San Angel",
] as const;

describe("(e) cobertura explicita del dueño = override: Cabo Norte y Los Pinos (sin coordenada); la capacidad sigue mandando sobre la geometria", () => {
  // [colonia, sucursal del dueño / chats]: las unicas dos colonias con cobertura explicita que quedan (solo existen en sus chats; no hay distancia que comparar).
  const DUENO: Array<[string, string]> = [
    ["Cabo Norte", "garcia-lavin"],
    ["Los Pinos", "altabrisa"],
  ];

  it("un override explicito del dueño manda aunque la geometria (coordenadas de Google + pines propuestos) diga otra sucursal (capacidad del motor; ya no se usa con Centro y compañia)", async () => {
    // Antes del 8-oct estas cuatro eran override del dueño/chats; ahora la regla de 8 km las asigna (T3, T3, T1, T2). El motor conserva la capacidad: se prueba sembrando el override.
    const casos: Array<[string, string]> = [["Centro", "prol-montejo"], ["Centro Histórico", "prol-montejo"], ["Benito Juárez Norte", "garcia-lavin"], ["Real Montejo", "garcia-lavin"]];
    let divergen = 0;
    for (const [nombre, dueno] of casos) {
      const m = await mundo({ coordenadas: true, cobertura: "ninguna" }); // un mundo por caso: con filas de cobertura una colonia no cubierta pasa a `sugerida`
      const c = colonia(nombre);
      const geometria = slugDe(c.mas_cercana!.sucursal);
      const sinOverride = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: nombre, radioMaximoKm: 8, ...PIN_PROPUESTAS });
      expect(sinOverride, `${nombre} por geometria`).toMatchObject({ estado: "asignada", origen: "distancia", branchSlug: geometria });
      m.repo.seedBranchDeliveryZones(m.propertyBySlug.get(dueno)!, [m.idPorNombre.get(nombre)!]);
      const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: nombre, radioMaximoKm: 8, ...PIN_PROPUESTAS });
      expect(r, nombre).toMatchObject({ estado: "asignada", branchSlug: dueno, origen: "cobertura_dueno", via: "zona", ajustePorZona: geometria !== dueno });
      if (geometria !== dueno) divergen += 1;
    }
    expect(divergen).toBe(4);
  });

  it("sin coordenadas de colonia (la cuenta real hoy) tambien: la cobertura del dueño es la respuesta, sin distancia inventada", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    for (const [nombre, dueno] of DUENO) {
      expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: nombre, radioMaximoKm: 8 }), nombre).toMatchObject({ estado: "asignada", branchSlug: dueno, distanceKm: null, origen: "cobertura_dueno" });
    }
  });

  it("la cobertura explicita del dueño no se recorta por el radio (es SU decision), ni escribiendo la colonia ni con pin", async () => {
    const m = await mundo({ coordenadas: true, cobertura: "ninguna" });
    const zona = (await m.repo.listKnownZones(m.organizationId)).find((z) => z.name === "Komchen")!;
    // Komchen (8.24 km de T2 con los pines propuestos): sin cobertura => fuera; el dueño la cubre con T2 => se atiende.
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Komchen", radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ estado: "fuera_de_zona", branchSlug: "fco-montejo" });
    m.repo.seedBranchDeliveryZones(m.propertyBySlug.get("fco-montejo")!, [zona.id]);
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Komchen", radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ estado: "asignada", branchSlug: "fco-montejo", origen: "cobertura_dueno" });
    // Con pin Y colonia cubierta, MANDA la cobertura (dos respuestas distintas segun como de la ubicacion seria incoherente) ...
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Komchen", lat: 21.1403, lng: -89.6471, radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ estado: "asignada", branchSlug: "fco-montejo", origen: "cobertura_dueno", via: "coordenadas" });
    // ... salvo que el pin claramente NO este en esa colonia: otra sucursal DENTRO del radio (pin en Cholul: a 9.6 km de Francisco de Montejo y a 2.4 km de Altabrisa) y medicion confiable.
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Komchen", ...colonia("Cholul").coordenada!, radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ estado: "asignada", branchSlug: "altabrisa", origen: "pin" });
  });
});

describe("(c) doble cobertura: las 14 colonias reales con dos sucursales nunca son `no_reconocida`", () => {
  const dobles = COLONIAS.filter((c) => ((c as unknown as { cobertura_base_real?: string[] }).cobertura_base_real ?? []).length > 1);

  it("hay 14 en la cuenta real, incluida Montecristo", () => {
    expect(dobles.length).toBe(14);
    expect(dobles.map((c) => c.nombre)).toContain("Montecristo");
  });

  it("sin coordenadas de colonia: gana la que el piloto pone primero; el resultado NO depende del orden de listado de las sucursales", async () => {
    const a = await mundo({ coordenadas: false, cobertura: "base_real" });
    const b = await mundo({ coordenadas: false, cobertura: "base_real", invertirOrden: true });
    for (const c of dobles) {
      const ra = await assignBranch(a.repo, { organizationId: a.organizationId, colonia: c.nombre, radioMaximoKm: 8 });
      const rb = await assignBranch(b.repo, { organizationId: b.organizationId, colonia: c.nombre, radioMaximoKm: 8 });
      expect(ra.estado, c.nombre).toBe("asignada");
      expect(ra).toMatchObject({ dobleCobertura: true, origen: "cobertura_dueno", distanceKm: null });
      expect((ra as { branchSlug: string }).branchSlug, c.nombre).toBe((rb as { branchSlug: string }).branchSlug);
      // La elegida es la 1.a del piloto cuando esta entre las que cubren.
      const cubren = ((c as unknown as { cobertura_base_real: string[] }).cobertura_base_real).map(slugDe);
      const primeraDelPiloto = [slugDe(c.referencia!.sucursal), slugDe(c.referencia!.segunda)].find((s) => cubren.includes(s));
      expect((ra as { branchSlug: string }).branchSlug, c.nombre).toBe(primeraDelPiloto ?? [...cubren].sort()[0]);
    }
  });

  it("Montecristo (T1 1.7 km / T7 2.2 km segun el piloto): elige Prolongacion Montejo, dice a unos 2 km y ofrece Garcia Lavin como alternativa solo si la diferencia es < 1 km", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "base_real" });
    const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Montecristo" });
    expect(r.result).toMatchObject({
      encontrada: true,
      estado: "asignada",
      branch_slug: "prol-montejo",
      distancia_km: null,
      distancia_aprox_km: 1.7,
      distancia_texto: "a unos 2 km",
      doble_cobertura: true,
      origen_asignacion: "cobertura_dueno",
      alternativa: { branch_slug: "garcia-lavin", distancia_texto: "a unos 2 km" },
    });
  });

  it("con coordenadas de colonia gana la MENOR distancia, y si la diferencia es < 0.5 km, la 1.a del piloto (Montealban: T7 1.46 km vs T1 1.73 km => T1)", async () => {
    const m = await mundo({ coordenadas: true, cobertura: "base_real" });
    const c = colonia("Montealban");
    expect(c.mas_cercana).toMatchObject({ sucursal: "T7", segunda: "T1" });
    expect(c.mas_cercana!.segunda_km - c.mas_cercana!.km).toBeLessThan(EMPATE_DOBLE_COBERTURA_KM);
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Montealban", radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ branchSlug: "prol-montejo", dobleCobertura: true });
    // Plan de Ayala: T1 1.01 km vs T7 2.93 km (diferencia grande) => la mas cercana.
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Plan de Ayala", radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ branchSlug: "prol-montejo" });
    // Algarrobos Residencial: T7 1.99 km vs T8 3.35 km => T7 (la menor distancia); con cobertura de ambas.
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Algarrobos Residencial", radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ branchSlug: "garcia-lavin", dobleCobertura: true });
  });
});

describe("(b) la herramienta dice cual es la sucursal de despacho mas cercana, a cuantos km, y jamas presenta como despacho una que no reparte", () => {
  it("con coordenadas de colonia y sin cobertura explicita manda el km: Alcala Martin -> Prolongacion Montejo a unos 2 km (2.1 km con los pines propuestos)", async () => {
    const m = await mundo({ coordenadas: true, cobertura: "ninguna", vigentesCompletas: true });
    const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Alcala Martin" });
    // Con las coordenadas VIGENTES (sin la bandera) tambien hay respuesta: nombra una sucursal de despacho y su distancia.
    expect(r.result).toMatchObject({ encontrada: true, estado: "asignada", origen_asignacion: "distancia", via: "zona" });
    const flag = await invokeAgentTool(m.repo, { ...ctxWa(m.organizationId), usarCoordenadasPropuestas: true }, "buscar_sucursal_cercana", { colonia: "Alcala Martin" });
    // Adenda 2: si hay otra sucursal de despacho a menos de 1 km de diferencia (Pensiones 2.9 km vs Prolongacion Montejo 2.1 km), se dice como alternativa.
    expect(flag.result).toMatchObject({ encontrada: true, branch_slug: "prol-montejo", distancia_texto: "a unos 2 km", alternativa: { branch_slug: "pensiones", distancia_texto: "a unos 3 km" } });
    expect(String((flag.result as { mensaje: string }).mensaje)).toMatch(/También le queda cerca Pensiones \(a unos 3 km\)/);
  });

  it("nunca asigna ni nombra como despacho a Galerias (T4) ni a Chicxulub (T5), ni siquiera con un pin pegado a ellas", async () => {
    const m = await mundo({ coordenadas: true, cobertura: "ninguna" });
    // Pin en la playa de Chicxulub (T5 queda a metros): fuera de zona y la sucursal nombrada es una de despacho.
    const playa = colonia("Chicxulub").coordenada!;
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, ...playa, radioMaximoKm: 8, ...PIN_PROPUESTAS });
    expect(r.estado).toBe("fuera_de_zona");
    if (r.estado === "fuera_de_zona") {
      expect(["prol-montejo", "fco-montejo", "pensiones", "garcia-lavin", "altabrisa"]).toContain(r.branchSlug);
      expect(r.distanceKm).toBeGreaterThan(25);
    }
    // Ninguna colonia del seed queda cubierta por T4 ni T5.
    for (const c of COLONIAS) expect((c.sucursales ?? []).filter((t) => t === "T4" || t === "T5"), c.nombre).toEqual([]);
  });

  it("(a)+(b) Komchen por WhatsApp y por voz: fuera de zona habitual, nombra la sucursal mas cercana a unos 10 km, no promete el envio, sin decimales raros", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed", vigentesCompletas: true });
    const pin = colonia("Komchen").coordenada!;
    for (const ctx of [ctxWa(m.organizationId), ctxVoz(m.organizationId)]) {
      const r = (await invokeAgentTool(m.repo, ctx, "buscar_sucursal_cercana", { ...pin })).result as Record<string, unknown>;
      expect(r).toMatchObject({
        encontrada: false,
        estado: "fuera_de_zona",
        reparto: "fuera_de_zona_habitual",
        sucursal_despacho_mas_cercana: { branch_slug: "fco-montejo", branch_name: "Francisco de Montejo", distancia_km: 9.6, distancia_texto: "a unos 10 km" },
      });
      const mensaje = String(r.mensaje);
      expect(mensaje).toMatch(/fuera de nuestra zona habitual de reparto/);
      expect(mensaje).toMatch(/Francisco de Montejo \(a unos 10 km\)/);
      expect(mensaje).toMatch(/sin prometer el envío/);
      expect(mensaje).not.toMatch(/\d+[.,]\d+ ?km/);
      expect(mensaje).not.toMatch(/no reconozco/i);
    }
  });

  it("un pin dentro del radio devuelve la sucursal, la distancia y el texto; el modelo recibe una frase lista", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const mulsay = colonia("Mulsay").coordenada!; // 3.9 km de Pensiones con su pin; Pensiones no tiene coordenadas vigentes
    const r = (await invokeAgentTool(m.repo, { ...ctxWa(m.organizationId), usarCoordenadasPropuestas: true }, "buscar_sucursal_cercana", { ...mulsay })).result as Record<string, unknown>;
    expect(r).toMatchObject({ encontrada: true, estado: "asignada", branch_slug: "pensiones", distancia_texto: "a unos 4 km", origen_asignacion: "pin" });
    expect(String(r.mensaje)).toMatch(/sucursal de despacho más cercana es Pensiones \(a unos 4 km\)/);
    expect(String(r.mensaje)).not.toMatch(/\d+[.,]\d+ ?km/);
  });
});

describe("(d) coordenadas propuestas: capacidad detras de una bandera APAGADA por omision, con prueba de la diferencia", () => {
  it("el archivo de coordenadas propuestas coincide con el seed (T1, T2, T3, T7, T8) y la bandera esta apagada por omision", () => {
    for (const s of SUCURSALES) {
      const propuesta = (s as unknown as { coordenadas_propuestas?: { lat: number; lng: number } }).coordenadas_propuestas;
      if (!propuesta) continue;
      expect(COORDENADAS_PROPUESTAS_PM[s.slug], s.slug).toEqual({ lat: propuesta.lat, lng: propuesta.lng });
    }
    expect(Object.keys(COORDENADAS_PROPUESTAS_PM).sort()).toEqual(["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"]);
    expect(coordenadasPropuestasActivas({})).toBe(false);
    expect(coordenadasPropuestasActivas({ [BANDERA_COORDENADAS_PROPUESTAS]: "0" })).toBe(false);
    expect(coordenadasPropuestasActivas({ [BANDERA_COORDENADAS_PROPUESTAS]: "1" })).toBe(true);
  });

  it("DIFERENCIA: un pin en Montecristo cae a 0.3 km de Altabrisa con las coordenadas vigentes y a 1.9 km de Prolongacion Montejo con los pines de Google", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "ninguna" });
    const pin = colonia("Montecristo").coordenada!;
    const vigentes = await assignBranch(m.repo, { organizationId: m.organizationId, ...pin, radioMaximoKm: 8 });
    const propuestas = await assignBranch(m.repo, { organizationId: m.organizationId, ...pin, radioMaximoKm: 8, ...PIN_PROPUESTAS });
    // Con las vigentes (Pensiones sin coordenada) la medicion NO es confiable: se asigna como antes pero sin decir distancias ni «la mas cercana».
    expect(vigentes).toMatchObject({ estado: "asignada", branchSlug: "altabrisa", distanceKm: null, aproximada: true });
    expect(propuestas).toMatchObject({ estado: "asignada", branchSlug: "prol-montejo", distanceKm: 1.9 });
  });

  it("DIFERENCIA con Pensiones: sin coordenadas vigentes nunca participa por distancia; con los pines de Google si (Mulsay 3.9 km)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "ninguna" });
    const pin = colonia("Mulsay").coordenada!;
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, ...pin, radioMaximoKm: 8 })).toMatchObject({ branchSlug: "garcia-lavin", distanceKm: null, aproximada: true });
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, ...pin, radioMaximoKm: 8, ...PIN_PROPUESTAS })).toMatchObject({ branchSlug: "pensiones", distanceKm: 3.9 });
  });

  it("la herramienta usa las vigentes por omision y las propuestas solo con ctx.usarCoordenadasPropuestas; nada se escribe en la base", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "ninguna" });
    const pin = colonia("Montecristo").coordenada!;
    const apagada = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { ...pin });
    const encendida = await invokeAgentTool(m.repo, { ...ctxWa(m.organizationId), usarCoordenadasPropuestas: true }, "buscar_sucursal_cercana", { ...pin });
    expect(apagada.result).toMatchObject({ branch_slug: "altabrisa" });
    expect(encendida.result).toMatchObject({ branch_slug: "prol-montejo" });
    const t1 = (await m.repo.listBranchesForOrganizationAdmin(m.organizationId)).find((b) => b.slug === "prol-montejo")!;
    expect([t1.lat, t1.lng]).toEqual([21.028, -89.61]); // las vigentes siguen intactas
  });
});

describe("26 colonias de muestra, con los datos reales de colonias-v3", () => {
  // Cuenta real HOY: known_zone sin coordenadas, cobertura = la del seed (regla + dueño), referencia del piloto.
  it.each(MUESTRA)("%s -- cuenta real (sin coordenadas en known_zone): asignada a la sucursal del seed o respuesta honesta", async (nombre) => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const c = colonia(nombre);
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: nombre, radioMaximoKm: 8 });
    const sucursalesSeed = c.sucursales ?? [];
    if (sucursalesSeed.length > 0) {
      expect(r, nombre).toMatchObject({ estado: "asignada", branchSlug: slugDe(sucursalesSeed[0]!), distanceKm: null, origen: "cobertura_dueno" });
    } else {
      expect(["sugerida", "fuera_de_zona"], `${nombre}: ${JSON.stringify(r)}`).toContain(r.estado);
      expect(r.estado).not.toBe("no_reconocida");
      expect(textoHonesto(r), nombre).toBe(true);
    }
  });

  // Con las coordenadas de Google de las colonias cargadas por el dueño y los pines de las sucursales: el km decide, como en colonias-v3. Las de dueño/chats llevan su
  // cobertura (override); el resto va SIN filas de cobertura (con filas, una colonia no cubierta se marca `sugerida`: el servidor la rechazaria).
  it.each(MUESTRA)("%s -- con coordenadas de colonia y pines de Google: coincide con colonias-v3 (sucursal y km)", async (nombre) => {
    const c = colonia(nombre);
    const conOverride = c.asignacion !== "mas_cercana_v3" && c.asignacion !== "sin_asignar";
    const m = await mundo({ coordenadas: true, cobertura: conOverride ? "solo_dueno" : "ninguna" });
    if (!c.coordenada) return; // las 8 sin coordenada se prueban en la seccion de pendientes
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: nombre, radioMaximoKm: 8, ...PIN_PROPUESTAS });
    const mas = c.mas_cercana!;
    if (!conOverride) {
      if (mas.fuera_de_8km) {
        expect(r, nombre).toMatchObject({ estado: "fuera_de_zona", branchSlug: slugDe(mas.sucursal) });
        expect((r as { distanceKm: number }).distanceKm).toBeCloseTo(mas.km, 1);
      } else {
        expect(r, nombre).toMatchObject({ estado: "asignada", branchSlug: slugDe(mas.sucursal), origen: "distancia" });
        expect(Math.abs((r as { distanceKm: number }).distanceKm - mas.km)).toBeLessThanOrEqual(0.06);
      }
    } else {
      // Dueño / chats / direccion de sucursal: la cobertura explicita manda.
      expect(r, nombre).toMatchObject({ estado: "asignada", branchSlug: slugDe(c.sucursales![0]!), origen: "cobertura_dueno" });
    }
  });
});

/** El texto que recibe el modelo para una colonia pendiente: honesto (ni «no reconozco» ni promesa de envio). */
function textoHonesto(r: BranchAssignment): boolean {
  const t = r.message;
  return !/no reconozco/i.test(t) && !/(enviamos|se enviará|le llevamos|sí repartimos)/i.test(t) && /(no la tengo ubicada con certeza|fuera de nuestra zona habitual)/.test(t);
}

describe("(f) las 19 colonias fuera de cobertura producen una respuesta honesta, sin inventar", () => {
  const pendientes = COLONIAS.filter((c) => (c.sucursales ?? []).length === 0);
  const motivo = (c: Colonia) => c.motivo_sin_asignar;

  it("son 19: 13 fuera de 8 km (una tambien homonima) y 6 sin coordenada; los 9 homonimos ya se asignan por la regla", () => {
    expect(pendientes.length).toBe(19);
    const cuenta = (m: string) => pendientes.filter((c) => c.pendiente_dueno?.includes(m as never)).length;
    expect(cuenta("fuera_de_8km")).toBe(13);
    expect(cuenta("homonimo_discrepancia")).toBe(1); // Mulchechen (fuera de 8 km y homonima)
    expect(cuenta("sin_coordenada")).toBe(6);
    expect(pendientes.filter((c) => motivo(c) === "sin_coordenada").length).toBe(6);
    expect(pendientes.filter((c) => motivo(c) === "homonimo_discrepancia").length).toBe(0);
  });

  it("cuenta real hoy (sin coordenadas en known_zone): ninguna es `no_reconocida`, ninguna se asigna, todas dicen la verdad y ninguna promete envio", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const resumen: Record<string, number> = {};
    for (const c of pendientes) {
      const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: c.nombre, radioMaximoKm: 8 });
      expect(r.estado, c.nombre).not.toBe("asignada");
      expect(r.estado, c.nombre).not.toBe("no_reconocida");
      expect(textoHonesto(r), `${c.nombre}: ${r.message}`).toBe(true);
      resumen[r.estado] = (resumen[r.estado] ?? 0) + 1;
      if (r.estado === "fuera_de_zona") {
        // La sucursal nombrada reparte (nunca Galerias ni Playa) y el km es el de la referencia del piloto, dicho como aproximado.
        expect(["prol-montejo", "fco-montejo", "pensiones", "garcia-lavin", "altabrisa"], c.nombre).toContain(r.branchSlug);
        expect(r.origen).toBe("referencia_piloto");
        expect(r.distanceKm).toBeGreaterThan(8);
      }
    }
    // Lo que hace la regla con la referencia del piloto que SI esta en la base (sin coordenadas de Google): ver el cuerpo del PR.
    expect(resumen).toEqual({ fuera_de_zona: 9, sugerida: 10 });
  });

  it("con las coordenadas de Google cargadas en known_zone: las 13 fuera de 8 km dicen «fuera de zona habitual» y nombran la mas cercana (Komchen: Francisco de Montejo, a unos 8 km)", async () => {
    const m = await mundo({ coordenadas: true, cobertura: "solo_dueno" });
    for (const c of pendientes.filter((x) => x.pendiente_dueno?.includes("fuera_de_8km"))) {
      const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: c.nombre, radioMaximoKm: 8, ...PIN_PROPUESTAS });
      expect(r, c.nombre).toMatchObject({ estado: "fuera_de_zona", branchSlug: slugDe(c.mas_cercana!.sucursal) });
      expect(r.message, c.nombre).toContain(`La sucursal de despacho más cercana es ${nombreDe(slugDe(c.mas_cercana!.sucursal))} (a `);
    }
    const komchen = await invokeAgentTool(m.repo, { ...ctxWa(m.organizationId), usarCoordenadasPropuestas: true }, "buscar_sucursal_cercana", { colonia: "Komchen" });
    expect(komchen.result).toMatchObject({ estado: "fuera_de_zona", sucursal_despacho_mas_cercana: { branch_slug: "fco-montejo", distancia_texto: "a unos 8 km" } });
  });

  it("las 6 sin coordenada: «no la tengo ubicada con certeza, ¿me manda su ubicacion?» (sin nombrar una sucursal como promesa)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    for (const c of pendientes.filter((x) => motivo(x) === "sin_coordenada")) {
      const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: c.nombre });
      const res = r.result as Record<string, unknown>;
      expect(res, c.nombre).toMatchObject({ encontrada: false, colonia_reconocida: c.nombre });
      expect(["sugerida", "fuera_de_zona"], c.nombre).toContain(res.estado);
      expect(String(res.mensaje), c.nombre).not.toMatch(/no reconozco/i);
    }
    const olivos = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Olivos" })).result as Record<string, unknown>;
    expect(olivos).toMatchObject({ estado: "sugerida", reparto: "por_confirmar", colonia_reconocida: "Olivos" });
    expect(String(olivos.mensaje)).toMatch(/No la tengo ubicada con certeza: ¿me manda su ubicación\?/);
    expect(String(olivos.mensaje)).toMatch(/Nunca diga que no reconoce la colonia ni prometa el envío/);
  });
});

describe("(f) detalle de los textos de las pendientes", () => {
  it("por confirmar: nombra la sucursal solo para RECOGER, sin distancias (la referencia del piloto de una pendiente puede estar equivocada: Santa Maria Chi dice 3 km y esta a 9)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Santa Maria Chi" })).result as Record<string, unknown>;
    expect(r).toMatchObject({ estado: "sugerida", reparto: "por_confirmar", sucursal_sugerida: { branch_slug: "altabrisa" } });
    expect(JSON.stringify(r)).not.toMatch(/\d+ ?km/);
  });

  it("dos referencias a menos de 1 km (San Diego Cutz 6.8 vs 7.6, sin coordenada) => ambigua: se ofrecen las dos para recoger", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "San Diego Cutz", radioMaximoKm: 8 });
    expect(r).toMatchObject({ estado: "sugerida", ambigua: true, sugerida: { slug: "altabrisa" }, segunda: { slug: "garcia-lavin" } });
    expect(r.message).toMatch(/Victory Altabrisa o García Lavín/);
  });

  it("fuera de zona por la referencia del piloto: lo dice, nombra la mas cercana (Pensiones, a unos 9 km) y avisa que es aproximado y que el pin lo confirma", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Roble Agrícola" })).result as Record<string, unknown>;
    expect(r).toMatchObject({ estado: "fuera_de_zona", reparto: "fuera_de_zona_habitual", sucursal_despacho_mas_cercana: { branch_slug: "pensiones", distancia_texto: "a unos 9 km" }, max_km: 8 });
    expect(String(r.mensaje)).toMatch(/referencia aproximada/);
    expect(String(r.mensaje)).toMatch(/vuelva a llamar esta herramienta con lat y lng/);
  });
});

describe("prompt del perfil PM: solo `no_reconocida` pide otra referencia; fuera_de_zona y sugerida se dicen con el mensaje de la herramienta", () => {
  const base = { businessName: "Los Taquitos de PM", agentName: "el asistente virtual", deliveryTimeText: "de 40 a 50 minutos", saludo: "Buenas noches", branches: [], entryBranch: null, customer: { isNew: true as const } };
  it("WhatsApp: la regla 4 distingue los estados; voz: `no_reconocida` (fuera de zona ya lo cubre H5 y el mensaje de la herramienta)", () => {
    const wa = buildPmSystemPrompt({ ...base });
    expect(wa).toMatch(/Si responde no_reconocida, pida otra referencia; tras dos intentos sin éxito, escale \(zona_no_reconocida\)\. Con fuera_de_zona o sugerida diga lo que indica su mensaje/);
    expect(wa).not.toMatch(/Si responde encontrada:false, pida otra referencia/);
    const voz = buildPmSystemPrompt({ ...base, canal: "voz" });
    expect(voz).toMatch(/no_reconocida: otra referencia y, tras dos intentos, escale \(zona_no_reconocida\)/);
    expect(voz).not.toMatch(/encontrada:false: otra referencia/);
  });
});

describe("regresiones: pin, colonia inexistente, base sin migracion 056, cotizacion a domicilio", () => {
  // Reloj fijo (miercoles 12:00 de Merida): la cotizacion a domicilio valida que la sucursal este abierta, asi que sin esto la prueba
  // fallaba entre ~01:00 y ~11:00 de Merida (el CI de main corrio a las 01:36 de Merida y la sucursal estaba cerrada).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00-06:00") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("un pin con coordenadas se comporta como hoy: la mas cercana y su distancia", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed", vigentesCompletas: true });
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, lat: 21.0281, lng: -89.6101, radioMaximoKm: 8 });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "prol-montejo", via: "coordenadas", origen: "pin", distanceKm: 0 });
  });

  it("una colonia que no esta en known_zone sigue siendo `no_reconocida` (Cumbres de Montejo)", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Cumbres de Montejo", radioMaximoKm: 8 })).toMatchObject({ estado: "no_reconocida" });
    const r = await invokeAgentTool(m.repo, ctxWa(m.organizationId), "buscar_sucursal_cercana", { colonia: "Cumbres de Montejo" });
    expect(r.result).toMatchObject({ encontrada: false, estado: "no_reconocida" });
  });

  it("una base sin la migracion 056 (`listColoniasReferencia` -> disponible:false) no lanza: colonia sin cobertura = por confirmar sin sucursal sugerida", async () => {
    const m = await mundo({ coordenadas: false, cobertura: "seed" });
    m.repo.listColoniasReferencia = async () => ({ disponible: false, zonas: [] });
    const r = await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Olivos", radioMaximoKm: 8 });
    expect(r).toMatchObject({ estado: "sugerida", reparto: "por_confirmar", sugerida: null, segunda: null });
    // Con cobertura explicita sigue igual que antes.
    expect(await assignBranch(m.repo, { organizationId: m.organizationId, colonia: "Temozón Norte", radioMaximoKm: 8 })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin" });
  });

  it("cotizar a domicilio una colonia SIN cobertura nombra la sucursal de despacho mas cercana para recoger, sin prometer envio; una cubierta pasa", async () => {
    const plan = buildPmSeedPlan(data, agent, { demo: true });
    const world = await buildInMemoryPmWorld(plan);
    const base = { organizationId: world.organizationId, branchSlug: "garcia-lavin", canal: "domicilio" as const, items: [{ productId: world.productIds.get("Coca-Cola")!, requestedQuantity: 6 }] };
    expect((await quoteOrder(world.repo, { ...base, colonia: "Temozón Norte" })).total).toBeGreaterThan(0);
    const error = await quoteOrder(world.repo, { ...base, colonia: "Olivos" }).catch((e: unknown) => e);
    const mensaje = (error as Error).message;
    expect(mensaje).toMatch(/todavía no tiene una sucursal de reparto asignada/);
    expect(mensaje).toMatch(/Para recoger, una sucursal cercana es Victory Altabrisa\./);
    expect(mensaje).toMatch(/pase el pedido con una persona/);
    expect(mensaje).not.toMatch(/\d+ ?km/); // la referencia del piloto de una colonia sin cobertura puede estar equivocada
  });
});
