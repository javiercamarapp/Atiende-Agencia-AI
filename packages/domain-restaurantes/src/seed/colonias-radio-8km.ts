// Regla de cobertura de colonias de "Los Taquitos de PM" (orden de Javier, 7-oct-2026): CADA colonia queda asignada a la sucursal de
// DESPACHO ACTIVA mas cercana (Haversine entre el pin de la sucursal y la coordenada de la colonia) si esta a 8 km o menos; las que quedan a mas de
// 8 km de toda sucursal de despacho quedan FUERA de cobertura (no se asignan, se listan y, si hoy tienen cobertura, se RETIRAN). Criterio conservador vigente
// (reversible por Javier): la cobertura EXPLICITA del dueño manda sobre la geometria y se documenta aparte con la distancia de cada opcion. Es la misma regla del despachador de la otra vertical.
//
// Modulo PURO (sin base, sin reloj, sin zonas horarias): lo usan la prueba `tests/colonias-radio-8km.spec.ts`, el generador
// `scripts/seed-pm-demo/generar-colonias-8km.ts` (SQL de carga, SQL de verificacion y documento) y nadie mas. No escribe coordenadas en
// `known_zone` (ver `colonias_meta.coordenadas_en_known_zone` en los datos): las coordenadas viven en los datos versionados y en el SQL de verificacion.
import type { PmSeedColonia, PmSeedData } from "./pm-demo.ts";

export const RADIO_REPARTO_KM = 8;
/** Margen de «borde»: una colonia a esta distancia o menos del limite de 8 km, o cuya segunda sucursal esta a esta distancia o menos de la primera. */
export const MARGEN_BORDE_KM = 0.3;
/** Dos distancias que difieren menos que esto son un EMPATE exacto y se rompe por el orden de `SUCURSALES_DESPACHO`. */
export const EPSILON_KM = 1e-9;
export const RADIO_TIERRA_KM = 6371.0088;
/** Sucursales que reparten a domicilio. Galerias (T4) y Chicxulub (T5) estan inactivas y NO reciben colonias. El orden rompe los empates exactos. */
export const SUCURSALES_DESPACHO = ["T1", "T2", "T3", "T7", "T8"] as const;
export const SUCURSALES_SIN_REPARTO = ["T4", "T5"] as const;
/** Procedencias (`asignacion` de los datos = `known_zone.asignacion_fuente`) que marcan una cobertura EXPLICITA del dueño: mandan sobre la geometria. */
export const ASIGNACIONES_EXPLICITAS_DEL_DUENO = ["chats_t7", "dueno_zona_centro"] as const;
export const ORGANIZACION_SLUG = "los-taquitos-de-pm";

export interface Punto {
  readonly lat: number;
  readonly lng: number;
}

export function haversineKm(a: Punto, b: Punto): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type MotivoBorde = "limite_8km" | "empate";

export interface Candidata {
  readonly id: string;
  readonly km: number;
}

export interface ResultadoMasCercana {
  /** Todas las sucursales de despacho, de la mas cercana a la mas lejana (empate exacto: por el orden de `SUCURSALES_DESPACHO`). */
  readonly candidatas: readonly Candidata[];
  readonly primera: Candidata;
  readonly segunda: Candidata | null;
  /** Sucursal asignada: la mas cercana si esta a `radioKm` o menos; `null` = fuera de cobertura. */
  readonly asignada: string | null;
  readonly fuera: boolean;
  readonly borde: readonly MotivoBorde[];
}

export interface OpcionesMasCercana {
  readonly radioKm?: number;
  readonly margenBordeKm?: number;
  readonly orden?: readonly string[];
}

/** Sucursal de despacho mas cercana a `punto` entre los `pines` y, si esta dentro del radio, la asignada. El limite es INCLUSIVO (8.00 km entra). */
export function masCercanaDentroDelRadio(punto: Punto, pines: Readonly<Record<string, Punto>>, opciones: OpcionesMasCercana = {}): ResultadoMasCercana {
  const radio = opciones.radioKm ?? RADIO_REPARTO_KM;
  const margen = opciones.margenBordeKm ?? MARGEN_BORDE_KM;
  const orden = opciones.orden ?? SUCURSALES_DESPACHO;
  const candidatas = orden
    .filter((id) => pines[id] !== undefined)
    .map((id) => ({ id, km: haversineKm(punto, pines[id]!) }))
    .sort((a, b) => (Math.abs(a.km - b.km) < EPSILON_KM ? orden.indexOf(a.id) - orden.indexOf(b.id) : a.km - b.km));
  const primera = candidatas[0];
  if (!primera) throw new Error("masCercanaDentroDelRadio: no hay pines de sucursales de despacho");
  const segunda = candidatas[1] ?? null;
  const fuera = primera.km > radio + EPSILON_KM;
  const borde: MotivoBorde[] = [];
  if (Math.abs(primera.km - radio) <= margen + EPSILON_KM) borde.push("limite_8km");
  // Un empate solo importa si la segunda tambien podria atender (esta dentro del radio): si no, la primera es la unica opcion valida.
  if (segunda && segunda.km - primera.km <= margen + EPSILON_KM && segunda.km <= radio + EPSILON_KM) borde.push("empate");
  return { candidatas, primera, segunda, asignada: fuera ? null : primera.id, fuera, borde };
}

export type ReglaColonia = "mas_cercana" | "explicita_dueno" | "fuera_de_8km" | "sin_coordenada" | "homonimo_pendiente";

export interface FilaColonia {
  readonly nombre: string;
  readonly regla: ReglaColonia;
  /** Sucursal(es) que la deben cubrir al terminar la carga (ids T1...). Vacio = fuera de cobertura. */
  readonly esperado: readonly string[];
  readonly km: number | null;
  readonly segunda: Candidata | null;
  readonly coordenada: (Punto & { readonly origen: "google" | "osm" | "promedio"; readonly confianza: string }) | null;
  readonly borde: readonly MotivoBorde[];
  /** Homonimo con discrepancia Google/OSM mayor a 1 km (la coordenada elegida en colonias-v3 puede no ser la de la colonia buscada). */
  readonly homonimoKm: number | null;
  /** Cobertura que tiene HOY la base real (verificada con SELECT el 8-oct-2026). */
  readonly antes: readonly string[];
  /** Mas cercana aunque este fuera de 8 km (para listar las que quedan fuera). */
  readonly masCercanaSiempre: Candidata | null;
  /** Solo en explicitas del dueño: su etiqueta de procedencia (`chats_t7`, `dueno_zona_centro`), que queda en `known_zone.asignacion_fuente`. */
  readonly etiqueta: string | null;
  /** Solo en explicitas del dueño CON coordenada: lo que daria la regla de 8 km y si difiere de la cobertura del dueño (pendiente de decision de Javier). */
  readonly opcionRegla: { readonly sucursal: string | null; readonly km: number; readonly masCercana: Candidata } | null;
  readonly difiereDeLaRegla: boolean;
}

export class ColoniasRadioError extends Error {}

export function pinesDeDespacho(data: PmSeedData): Record<string, Punto> {
  const pines: Record<string, Punto> = {};
  for (const id of SUCURSALES_DESPACHO) {
    const s = data.sucursales.find((b) => b.id === id);
    const c = s?.coordenadas_propuestas;
    if (!c) throw new ColoniasRadioError(`La sucursal ${id} no tiene pin (coordenadas_propuestas): no se puede calcular la cobertura`);
    pines[id] = { lat: c.lat, lng: c.lng };
  }
  return pines;
}

/** Cobertura esperada de CADA colonia de los datos segun la regla de 8 km. Las dos colonias explicitas del dueño (sin coordenada) conservan su sucursal. */
export function calcularColonias(data: PmSeedData): readonly FilaColonia[] {
  const pines = pinesDeDespacho(data);
  return (data.colonias ?? []).map((c: PmSeedColonia): FilaColonia => {
    const antes = [...(c.cobertura_base_real ?? [])].sort();
    const co = c.coordenada;
    const hom = c.google && c.osm ? haversineKm(c.google, c.osm) : null;
    const homonimoKm = hom !== null && hom > 1 ? hom : null;
    const explicita = (ASIGNACIONES_EXPLICITAS_DEL_DUENO as readonly string[]).includes(c.asignacion) && (c.sucursales ?? []).length > 0;
    const base = { nombre: c.nombre, homonimoKm, antes, etiqueta: explicita ? c.asignacion : null };
    if (!co) {
      return { ...base, regla: explicita ? "explicita_dueno" : "sin_coordenada", esperado: explicita ? [...(c.sucursales ?? [])] : [], km: null, segunda: null, coordenada: null, borde: [], masCercanaSiempre: null, opcionRegla: null, difiereDeLaRegla: false };
    }
    const r = masCercanaDentroDelRadio(co, pines);
    const coordenada = { lat: co.lat, lng: co.lng, origen: co.origen, confianza: co.confianza };
    if (explicita) {
      const dueno = c.sucursales![0]!;
      const kmDueno = r.candidatas.find((x) => x.id === dueno)?.km ?? haversineKm(co, pines[dueno]!);
      return {
        ...base,
        regla: "explicita_dueno",
        esperado: [...(c.sucursales ?? [])],
        km: kmDueno,
        segunda: r.candidatas.find((x) => x.id !== dueno) ?? null,
        coordenada,
        borde: r.borde,
        masCercanaSiempre: r.primera,
        opcionRegla: { sucursal: r.asignada, km: r.primera.km, masCercana: r.primera },
        difiereDeLaRegla: r.asignada !== dueno,
      };
    }
    // Homonimo cuyas lecturas de Google y OSM no coinciden y sigue pendiente del dueño (San Jose: nombre generico, lecturas a 11.4 km entre si): no se asigna aunque la
    // coordenada elegida caiga dentro del radio. Si esta a mas de 8 km manda fuera_de_8km.
    const pendienteHomonimo = !r.fuera && (c.sucursales ?? []).length === 0 && (c.pendiente_dueno ?? []).includes("homonimo_discrepancia");
    if (pendienteHomonimo) return { ...base, regla: "homonimo_pendiente", esperado: [], km: r.primera.km, segunda: r.segunda, coordenada, borde: r.borde, masCercanaSiempre: r.primera, opcionRegla: null, difiereDeLaRegla: false };
    return { ...base, regla: r.fuera ? "fuera_de_8km" : "mas_cercana", esperado: r.asignada ? [r.asignada] : [], km: r.primera.km, segunda: r.segunda, coordenada, borde: r.borde, masCercanaSiempre: r.primera, opcionRegla: null, difiereDeLaRegla: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Nombres y utilidades de render
// ---------------------------------------------------------------------------------------------------------------------------------------------

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const num = (n: number) => String(Number(n.toFixed(9)));

function slugsPorId(data: PmSeedData): Record<string, string> {
  return Object.fromEntries(data.sucursales.map((b) => [b.id, b.slug]));
}
function nombresPorId(data: PmSeedData): Record<string, string> {
  return Object.fromEntries(data.sucursales.map((b) => [b.id, b.nombre]));
}

export interface ResumenCarga {
  readonly asignadas: number;
  readonly fuera: readonly FilaColonia[];
  readonly sinCoordenada: readonly FilaColonia[];
  readonly homonimosPendientes: readonly FilaColonia[];
  readonly altas: number;
  readonly reemplazos: number;
  /** Colonias sin coordenada que hoy tienen cobertura: pendientes del dueño, se listan y no se tocan. */
  readonly sobrantes: readonly FilaColonia[];
  /** Colonias a mas de 8 km que hoy tienen cobertura: la carga las RETIRA (un par colonia-sucursal por fila de cobertura). */
  readonly retirosFuera: readonly FilaColonia[];
  readonly explicitas: readonly FilaColonia[];
  readonly antesPorSucursal: Readonly<Record<string, number>>;
  readonly despuesPorSucursal: Readonly<Record<string, number>>;
  readonly coloniasPorSucursal: Readonly<Record<string, number>>;
}

/** Puntos de sucursal que ya son zona conocida con su propia cobertura y NO estan en la lista de colonias (T1, T7 y T8; T2 SI esta: «Francisco de Montejo»). */
const PUNTOS_DE_SUCURSAL_FUERA_DE_LA_LISTA: Readonly<Record<string, number>> = { T1: 1, T7: 1, T8: 1 };

export function resumir(filas: readonly FilaColonia[]): ResumenCarga {
  const cuenta = (xs: Iterable<string>) => {
    const m: Record<string, number> = Object.fromEntries(SUCURSALES_DESPACHO.map((id) => [id, 0]));
    for (const x of xs) m[x] = (m[x] ?? 0) + 1;
    return m;
  };
  const antes = cuenta(filas.flatMap((f) => f.antes));
  const colonias = cuenta(filas.flatMap((f) => f.esperado));
  const despues = cuenta([...filas.flatMap((f) => (f.esperado.length > 0 ? f.esperado : f.regla === "fuera_de_8km" ? [] : f.antes))]);
  for (const [id, n] of Object.entries(PUNTOS_DE_SUCURSAL_FUERA_DE_LA_LISTA)) {
    antes[id] = (antes[id] ?? 0) + n;
    despues[id] = (despues[id] ?? 0) + n;
  }
  const asignadas = filas.filter((f) => f.esperado.length > 0);
  return {
    asignadas: asignadas.length,
    fuera: filas.filter((f) => f.regla === "fuera_de_8km"),
    sinCoordenada: filas.filter((f) => f.regla === "sin_coordenada"),
    homonimosPendientes: filas.filter((f) => f.regla === "homonimo_pendiente"),
    altas: asignadas.reduce((n, f) => n + f.esperado.filter((id) => !f.antes.includes(id)).length, 0),
    reemplazos: asignadas.reduce((n, f) => n + f.antes.filter((id) => !f.esperado.includes(id)).length, 0),
    sobrantes: filas.filter((f) => (f.regla === "sin_coordenada" || f.regla === "homonimo_pendiente") && f.antes.length > 0),
    retirosFuera: filas.filter((f) => f.regla === "fuera_de_8km" && f.antes.length > 0),
    explicitas: filas.filter((f) => f.regla === "explicita_dueno"),
    antesPorSucursal: antes,
    despuesPorSucursal: despues,
    coloniasPorSucursal: colonias,
  };
}

const ORIGEN_TEXTO: Record<string, string> = {
  google: "Google Maps (ficha de la colonia, colonias-v3)",
  osm: "OpenStreetMap/Nominatim (colonias-v3)",
  promedio: "promedio de las lecturas de Google y OSM (colonias-v3, confianza baja)",
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// SQL de carga (idempotente, escribe)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export function renderCargaSql(data: PmSeedData): string {
  const filas = calcularColonias(data);
  const slug = slugsPorId(data);
  const r = resumir(filas);
  const asignadas = filas.filter((f) => f.esperado.length > 0);
  const sinCobertura = filas.filter((f) => f.esperado.length === 0);
  const valoresCob = asignadas
    .flatMap((f) => f.esperado.map((id) => ({ f, id })))
    .map(({ f, id }) => `  (${lit(f.nombre)}, ${lit(slug[id]!)}, ${f.km === null ? "null" : num(f.km)}, ${lit(f.etiqueta ?? "mas_cercana_v3")})`)
    .join(",\n");
  const valoresSin = sinCobertura.map((f) => `  (${lit(f.nombre)}, ${lit(f.regla)})`).join(",\n");
  const despacho = SUCURSALES_DESPACHO.map((id) => lit(slug[id]!)).join(", ");
  const sinReparto = SUCURSALES_SIN_REPARTO.map((id) => lit(slug[id]!)).join(", ");
  return `-- Cobertura de colonias de Los Taquitos de PM: sucursal de despacho ACTIVA mas cercana a 8 km o menos (Haversine desde los pines de Google de las sucursales
-- hasta la coordenada de cada colonia). GENERADO por scripts/seed-pm-demo/generar-colonias-8km.ts a partir de scripts/seed-pm-demo/data/pm-seed-data.json:
-- NO lo edite a mano (una prueba falla si se desincroniza). Documento con la tabla completa: docs/restaurantes-colonias-radio-8km.md.
--
-- Ejecutar:  supabase db query --linked -f colonias-8km-carga.sql      (desde una carpeta ligada al proyecto)
--
-- IDEMPOTENTE: la 2.a corrida no cambia nada (0 altas, 0 reemplazos, 0 metadatos). Una sola transaccion: cualquier comprobacion que falle ABORTA todo.
-- NO hace DELETE masivo: solo retira (a) las filas de cobertura de una colonia ASIGNADA que
-- apuntan a OTRA sucursal que la esperada (reemplazos; esperados en la base real del 8-oct-2026: ${r.reemplazos}) y (b) TODA la cobertura, de cualquier sucursal, de las colonias a MAS DE 8 KM de toda
-- sucursal de despacho (retiros: ${r.retirosFuera.length}, a saber ${r.retirosFuera.map((f) => f.nombre + " " + f.antes.join("/")).join(", ")}); si hubiera mas de lo esperado en cualquiera de los dos, aborta.
-- Las colonias SIN coordenada (pendientes del dueño) y las explicitas del dueño no se tocan: el SELECT final lista las sin coordenada que hoy tienen cobertura.
-- Esperado sobre la base real de ${Object.values(r.antesPorSucursal).reduce((a, b) => a + b, 0)} filas: +${r.altas} altas, -${r.reemplazos} reemplazos, -${r.retirosFuera.reduce((n, f) => n + f.antes.length, 0)} retiros, ${Object.values(r.despuesPorSucursal).reduce((a, b) => a + b, 0)} filas al terminar.
-- Actualiza known_zone.asignacion_fuente SOLO en las zonas cuya cobertura cambia (sobrescribe su procedencia anterior: sin_asignar, ambigua_cubierta_por_dos,
-- distancia_piloto, mas_cercana_osm_v2b, reasignada_desde_galerias); NO toca ninguna etiqueta dueno_zona_centro ni chats_t7; las retiradas quedan 'sin_asignar'.
-- NO escribe lat/lng en known_zone ni toca branch_detail, estado de sucursales, whatsapp_branch_channel ni la cuenta demo.

begin;

set local lock_timeout = '15s';

create temp table _cob8 (
  zona text not null,
  sucursal_slug text not null,
  km numeric,
  regla text not null,
  primary key (zona, sucursal_slug)
) on commit drop;

-- ${asignadas.length} colonias asignadas (${asignadas.reduce((n, f) => n + f.esperado.length, 0)} pares colonia-sucursal): la mas cercana a 8 km o menos, mas las 2 coberturas explicitas del dueño sin coordenada (Cabo Norte, Los Pinos).
insert into _cob8 (zona, sucursal_slug, km, regla) values
${valoresCob};

create temp table _sin8 (zona text primary key, motivo text not null) on commit drop;

-- ${sinCobertura.length} colonias FUERA de cobertura: ${r.fuera.length} a mas de 8 km de toda sucursal de despacho, ${r.sinCoordenada.length} sin coordenada (no se estiman a mano) y ${r.homonimosPendientes.length} homonimo pendiente del dueño (San Jose).
insert into _sin8 (zona, motivo) values
${valoresSin};

create temp table _cambiadas (zone_id uuid primary key, regla text not null) on commit drop;

do $carga$
declare
  v_org uuid;
  v_n integer;
  v_altas integer;
  v_reemplazos integer;
  v_meta integer;
  v_total integer;
  c_max_reemplazos constant integer := ${r.reemplazos};
  c_max_retiros constant integer := ${r.retirosFuera.reduce((n, f) => n + f.antes.length, 0)};
  v_retiros integer;
begin
  select o.id into v_org from core.organization o where o.slug = ${lit(data.organizacion.slug)};
  if v_org is null then
    raise exception 'colonias 8 km: no existe la organizacion ${data.organizacion.slug}';
  end if;

  -- 1. Las 5 sucursales de despacho existen y estan ACTIVAS (T2 y T8 incluidas).
  select count(*) into v_n
  from core.property p join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = v_org and p.status = 'active' and bd.slug in (${despacho});
  if v_n <> ${SUCURSALES_DESPACHO.length} then
    raise exception 'colonias 8 km: se esperaban ${SUCURSALES_DESPACHO.length} sucursales de despacho activas y hay %', v_n;
  end if;

  -- 2. Cada colonia de la lista existe EXACTAMENTE una vez en known_zone (no se crean zonas ni se adivinan nombres).
  select count(*) into v_n
  from (select zona from _cob8 union select zona from _sin8) l
  where (select count(*) from restaurantes.known_zone z where z.organization_id = v_org and z.name = l.zona) <> 1;
  if v_n <> 0 then
    raise exception 'colonias 8 km: % colonias de la lista no existen una sola vez en known_zone', v_n;
  end if;

  -- 3. Antes: ninguna cobertura en sucursales sin reparto (Galerias, Playa).
  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org and bd.slug in (${sinReparto});
  if v_n <> 0 then
    raise exception 'colonias 8 km: hay % coberturas en sucursales que no reparten (Galerias/Playa)', v_n;
  end if;

  -- 4. Reemplazos: filas de colonias asignadas que apuntan a una sucursal distinta de la esperada. Tope exacto de la base real conocida.
  select count(*) into v_reemplazos
  from restaurantes.branch_delivery_zone b
  join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org
    and exists (select 1 from _cob8 c where c.zona = z.name)
    and not exists (select 1 from _cob8 c where c.zona = z.name and c.sucursal_slug = bd.slug);
  if v_reemplazos > c_max_reemplazos then
    raise exception 'colonias 8 km: % reemplazos superan el tope de % (la base cambio; revise antes de seguir)', v_reemplazos, c_max_reemplazos;
  end if;

  with sobra as (
    select b.property_id, b.zone_id
    from restaurantes.branch_delivery_zone b
    join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
    join restaurantes.branch_detail bd on bd.property_id = b.property_id
    where b.organization_id = v_org
      and exists (select 1 from _cob8 c where c.zona = z.name)
      and not exists (select 1 from _cob8 c where c.zona = z.name and c.sucursal_slug = bd.slug)
  ), borradas as (
    delete from restaurantes.branch_delivery_zone b using sobra s
    where b.property_id = s.property_id and b.zone_id = s.zone_id and b.organization_id = v_org
    returning b.zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct b.zone_id, 'mas_cercana_v3' from borradas b
  on conflict (zone_id) do nothing;

  -- 4b. Retiros: la cobertura de colonias a mas de 8 km de toda sucursal de despacho (orden de Javier: fuera de cobertura). Tope exacto.
  select count(*) into v_retiros
  from restaurantes.branch_delivery_zone b
  join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  where b.organization_id = v_org and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km');
  if v_retiros > c_max_retiros then
    raise exception 'colonias 8 km: % retiros superan el tope de % (la base cambio; revise antes de seguir)', v_retiros, c_max_retiros;
  end if;

  with retiradas as (
    delete from restaurantes.branch_delivery_zone b using restaurantes.known_zone z
    where z.id = b.zone_id and z.organization_id = v_org and b.organization_id = v_org
      and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km')
    returning b.zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct r.zone_id, 'sin_asignar' from retiradas r
  on conflict (zone_id) do nothing;

  -- 5. Altas: una fila por (colonia, sucursal esperada) que falte. Idempotente (on conflict do nothing).
  with nuevas as (
    insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
    select bd.property_id, z.id, v_org
    from _cob8 c
    join restaurantes.known_zone z on z.organization_id = v_org and z.name = c.zona
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = c.sucursal_slug
    on conflict (property_id, zone_id) do nothing
    returning zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct n.zone_id, 'mas_cercana_v3' from nuevas n
  on conflict (zone_id) do nothing;

  select count(*) into v_altas from _cambiadas;

  -- 6. Procedencia (solo lectura para el reporte de colonias ambiguas): unicamente las zonas cuya cobertura cambio en esta corrida.
  update restaurantes.known_zone z
     set asignacion_fuente = coalesce((select max(c.regla) from _cob8 c where c.zona = z.name), k.regla)
    from _cambiadas k
   where z.id = k.zone_id and z.organization_id = v_org
     and z.asignacion_fuente is distinct from coalesce((select max(c.regla) from _cob8 c where c.zona = z.name), k.regla);
  get diagnostics v_meta = row_count;

  -- 7. Despues: cada colonia asignada tiene EXACTAMENTE sus sucursales esperadas (ni una mas, ni una menos).
  select count(*) into v_n
  from (select distinct zona from _cob8) l
  where (select coalesce(string_agg(bd.slug, ',' order by bd.slug), '')
           from restaurantes.branch_delivery_zone b
           join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org and z.name = l.zona
           join restaurantes.branch_detail bd on bd.property_id = b.property_id
          where b.organization_id = v_org)
        <> (select string_agg(c.sucursal_slug, ',' order by c.sucursal_slug) from _cob8 c where c.zona = l.zona);
  if v_n <> 0 then
    raise exception 'colonias 8 km: % colonias no quedaron con la cobertura esperada; se aborta y se deshace todo', v_n;
  end if;

  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org and bd.slug in (${sinReparto});
  if v_n <> 0 then
    raise exception 'colonias 8 km: Galerias o Playa quedaron con cobertura (%)', v_n;
  end if;

  -- 8. Ninguna colonia a mas de 8 km conserva cobertura.
  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  where b.organization_id = v_org and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km');
  if v_n <> 0 then
    raise exception 'colonias 8 km: % coberturas de colonias a mas de 8 km no se retiraron', v_n;
  end if;

  select count(*) into v_total from restaurantes.branch_delivery_zone b where b.organization_id = v_org;
  raise notice 'colonias 8 km: zonas con cobertura cambiada=% (reemplazos retirados=%, retiros fuera de 8 km=%), metadatos de procedencia actualizados=%, filas de cobertura totales=%', v_altas, v_reemplazos, v_retiros, v_meta, v_total;
end
$carga$;

commit;

-- Resultado (una sola consulta; solo lectura): cobertura por sucursal y las colonias SIN coordenada que hoy tienen cobertura (pendientes del dueño; no se tocan).
select seccion, clave, valor
from (
  select 'cobertura_por_sucursal' as seccion, bd.slug as clave, count(*)::text as valor
  from restaurantes.branch_delivery_zone b
  join core.organization o on o.id = b.organization_id and o.slug = ${lit(data.organizacion.slug)}
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by bd.slug
  union all
  select 'cobertura_total', 'filas', count(*)::text
  from restaurantes.branch_delivery_zone b join core.organization o on o.id = b.organization_id and o.slug = ${lit(data.organizacion.slug)}
  union all
  select 'pendiente_sin_coordenada_con_cobertura', z.name, string_agg(bd.slug, ',' order by bd.slug)
  from restaurantes.known_zone z
  join core.organization o on o.id = z.organization_id and o.slug = ${lit(data.organizacion.slug)}
  join restaurantes.branch_delivery_zone b on b.zone_id = z.id
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where z.name in (${sinCobertura.filter((f) => f.regla !== "fuera_de_8km").map((f) => lit(f.nombre)).join(", ")})
  group by z.name
) x
order by seccion, clave;
`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// SQL de verificacion (solo lectura)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export function renderVerificaSql(data: PmSeedData): string {
  const filas = calcularColonias(data);
  const slug = slugsPorId(data);
  const pines = pinesDeDespacho(data);
  const conCoordenada = filas.filter((f) => f.coordenada && f.regla !== "explicita_dueno" && f.regla !== "homonimo_pendiente");
  const explicitas = filas.filter((f) => f.regla === "explicita_dueno");
  const sinRegla = filas.filter((f) => f.regla === "sin_coordenada" || f.regla === "homonimo_pendiente");
  const pinesSql = SUCURSALES_DESPACHO.map((id) => `  (${lit(id)}, ${lit(slug[id]!)}, ${pines[id]!.lat}, ${pines[id]!.lng})`).join(",\n");
  const coloniasSql = conCoordenada.map((f) => `  (${lit(f.nombre)}, ${f.coordenada!.lat}, ${f.coordenada!.lng}, ${lit(f.coordenada!.origen)})`).join(",\n");
  const sinCoordSql = sinRegla.map((f) => `  (${lit(f.nombre)})`).join(",\n");
  const explicitasSql = explicitas.map((f) => `  (${lit(f.nombre)}, ${lit(slug[f.esperado[0]!]!)})`).join(",\n");
  return `-- VERIFICACION (solo lectura) de la cobertura de colonias de Los Taquitos de PM contra la regla de 8 km. GENERADO por
-- scripts/seed-pm-demo/generar-colonias-8km.ts desde scripts/seed-pm-demo/data/pm-seed-data.json: NO lo edite a mano (una prueba falla si se desincroniza).
--
-- Ejecutar:  supabase db query --linked -f colonias-8km-verifica.sql
--
-- RECALCULA EN LA BASE la sucursal de despacho mas cercana de cada colonia (Haversine, radio terrestre ${RADIO_TIERRA_KM} km, SQL puro) desde los pines de
-- las 5 sucursales de despacho y las coordenadas de las ${conCoordenada.length} colonias (Google/OSM/promedio de colonias-v3; known_zone NO guarda coordenadas a proposito)
-- y lo compara con restaurantes.branch_delivery_zone. No escribe nada.
--
-- Lectura del resultado (columnas seccion, clave, a, b, c):
--   resumen / <categoria> / n   : ok | ok_fuera_de_cobertura | explicita_dueno_ok | pendiente_sin_cobertura | pendiente_con_cobertura | DIFERENCIA | zona_inexistente
--   resumen / PASA o FALLA / n  : FALLA si hay alguna DIFERENCIA o zona_inexistente. DIFERENCIA = una colonia asignada que no tiene exactamente su sucursal, una
--                                 explicita del dueño que no tiene la suya, o una colonia a MAS DE 8 KM que todavia tiene cobertura. Las explicitas del dueño
--                                 (Centro, Centro Historico, Benito Juarez Norte, Real Montejo, Cabo Norte, Los Pinos) se comparan con SU sucursal, no con la mas cercana.
--                                 'pendiente_*' = sin coordenada o homonimo pendiente (San Jose): no se asignan; si hoy tienen cobertura se listan, no cuentan como FALLA.
--   DIFERENCIA / <colonia> / esperado / cargado / km   (idem para zona_inexistente y pendiente_con_cobertura)
--   cobertura_por_sucursal / <slug> / filas
with pines (id, slug, lat, lng) as (
  values
${pinesSql}
), colonias (nombre, lat, lng, origen) as (
  values
${coloniasSql}
), pendientes (nombre) as (
  values
${sinCoordSql}
), explicitas (nombre, slug) as (
  values
${explicitasSql}
), dist as (
  select c.nombre, p.id, p.slug,
         2 * ${RADIO_TIERRA_KM} * asin(least(1, sqrt(
           power(sin(radians(p.lat - c.lat) / 2), 2)
           + cos(radians(c.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - c.lng) / 2), 2)))) as km
  from colonias c cross join pines p
), orden as (
  select d.*, row_number() over (partition by d.nombre order by round(d.km::numeric, 9), d.id) as rn from dist d
), esperado as (
  -- la mas cercana, solo si esta a ${RADIO_REPARTO_KM} km o menos (limite inclusivo)
  select nombre, slug, km, (km <= ${RADIO_REPARTO_KM} + 0.000000001) as dentro from orden where rn = 1
), org as (
  select id from core.organization where slug = ${lit(data.organizacion.slug)}
), zonas as (
  select z.id, z.name from restaurantes.known_zone z join org on z.organization_id = org.id
), cargado as (
  select zn.name, string_agg(bd.slug, ',' order by bd.slug) as slugs
  from zonas zn
  join restaurantes.branch_delivery_zone b on b.zone_id = zn.id
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by zn.name
), universo as (
  select e.nombre, case when e.dentro then e.slug end as esperado_slug, e.km, 'mas_cercana'::text as tipo from esperado e
  union all select s.nombre, null, null, 'pendiente' from pendientes s
  union all select x.nombre, x.slug, null, 'explicita' from explicitas x
), juicio as (
  select u.nombre, u.tipo, u.esperado_slug, u.km, c.slugs as cargado_slugs, (select count(*) from zonas z where z.name = u.nombre) as zonas_n,
         case
           when (select count(*) from zonas z where z.name = u.nombre) <> 1 then 'zona_inexistente'
           when u.tipo = 'explicita' then case when c.slugs is not distinct from u.esperado_slug then 'explicita_dueno_ok' else 'DIFERENCIA' end
           when u.tipo = 'pendiente' then case when c.slugs is null then 'pendiente_sin_cobertura' else 'pendiente_con_cobertura' end
           when u.esperado_slug is null then case when c.slugs is null then 'ok_fuera_de_cobertura' else 'DIFERENCIA' end
           when c.slugs is not distinct from u.esperado_slug then 'ok'
           else 'DIFERENCIA'
         end as categoria
  from universo u left join cargado c on c.name = u.nombre
)
select seccion, clave, a, b, c from (
  select 'resumen' as seccion, categoria as clave, count(*)::text as a, null::text as b, null::text as c, 1 as orden from juicio group by categoria
  union all
  select 'resumen', case when count(*) filter (where categoria in ('DIFERENCIA', 'zona_inexistente')) = 0 then 'PASA' else 'FALLA' end,
         count(*) filter (where categoria in ('DIFERENCIA', 'zona_inexistente'))::text, null, null, 0 from juicio
  union all
  select categoria, nombre, coalesce(esperado_slug, '-'), coalesce(cargado_slugs, '-'), round(km::numeric, 2)::text, 2
  from juicio where categoria in ('DIFERENCIA', 'zona_inexistente', 'pendiente_con_cobertura')
  union all
  select 'cobertura_por_sucursal', bd.slug, count(*)::text, null, null, 3
  from restaurantes.branch_delivery_zone b join org on b.organization_id = org.id join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by bd.slug
  union all
  select 'cobertura_total', 'filas', count(*)::text, null, null, 3
  from restaurantes.branch_delivery_zone b join org on b.organization_id = org.id
) r
order by orden, seccion, clave;
`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------------------------------------------------------------------------

const f2 = (n: number) => n.toFixed(2);

export function renderDocumento(data: PmSeedData): string {
  const filas = [...calcularColonias(data)].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const nombre = nombresPorId(data);
  const slug = slugsPorId(data);
  const pines = pinesDeDespacho(data);
  const r = resumir(filas);
  const etiqueta = (id: string) => `${id} ${nombre[id] ?? id}`;
  const sumaAntes = Object.values(r.antesPorSucursal).reduce((a, b) => a + b, 0);
  const sumaDespues = Object.values(r.despuesPorSucursal).reduce((a, b) => a + b, 0);
  const bordes = filas.filter((f) => f.borde.length > 0);
  const notaBorde = (f: FilaColonia) => {
    const partes: string[] = [];
    if (f.borde.includes("limite_8km")) partes.push(`borde: a ${Math.round(Math.abs((f.km ?? 0) - RADIO_REPARTO_KM) * 1000)} m del limite de 8 km`);
    if (f.borde.includes("empate") && f.segunda) partes.push(`borde: empate con ${f.segunda.id} (a ${Math.round(Math.abs(f.segunda.km - (f.km ?? 0)) * 1000)} m de diferencia)`);
    return partes.join("; ");
  };
  const nota = (f: FilaColonia): string => {
    const n: string[] = [];
    if (f.regla === "explicita_dueno") n.push(f.coordenada === null ? `explicita del dueño (${f.etiqueta}; solo aparece en sus chats, sin coordenada: no se mide)` : f.difiereDeLaRegla ? `explicita del dueño (${f.etiqueta}) que DIFIERE de la regla de 8 km: pendiente de decision de Javier (ver seccion aparte)` : `explicita del dueño (${f.etiqueta}); coincide con la regla`);
    if (f.regla === "homonimo_pendiente") n.push(`PENDIENTE del dueño: homonimo con lecturas de Google y OSM a ${f2(f.homonimoKm ?? 0)} km entre si (nombre generico); con la coordenada elegida seria ${f.masCercanaSiempre!.id} a ${f2(f.masCercanaSiempre!.km)} km, pero no se asigna: prometeria un reparto falso`);
    if (f.regla === "fuera_de_8km") n.push(`fuera de 8 km: la mas cercana es ${f.masCercanaSiempre!.id} a ${f2(f.masCercanaSiempre!.km)} km`);
    if (f.regla === "sin_coordenada") n.push("sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano");
    if (f.borde.length > 0) n.push(notaBorde(f));
    if (f.homonimoKm !== null && f.regla !== "sin_coordenada" && f.regla !== "homonimo_pendiente" && f.regla !== "fuera_de_8km") n.push(`REVISAR, homonimo: Google y OSM difieren ${f2(f.homonimoKm)} km; se uso la coordenada elegida en colonias-v3`);
    if (f.coordenada?.confianza === "baja") n.push("confianza de la coordenada: baja");
    const cambio = f.esperado.length > 0 && f.antes.join(",") !== f.esperado.join(",");
    if (cambio) n.push(f.antes.length === 0 ? "alta nueva (hoy sin cobertura)" : `cambia: hoy ${f.antes.join(", ")}`);
    if (f.regla === "fuera_de_8km" && f.antes.length > 0) n.push(`RETIRO: la base real hoy la cubre ${f.antes.join(", ")}; la carga retira esa fila`);
    if ((f.regla === "sin_coordenada" || f.regla === "homonimo_pendiente") && f.antes.length > 0) n.push(`la base real hoy la cubre ${f.antes.join(", ")}; pendiente del dueño, no se toca`);
    return n.join("; ");
  };
  const fuenteCoord = (f: FilaColonia) => (f.coordenada ? (ORIGEN_TEXTO[f.coordenada.origen] ?? f.coordenada.origen) : f.regla === "explicita_dueno" ? "chats del dueño (sin coordenada)" : "sin coordenada");
  const asignada = (f: FilaColonia) => (f.esperado.length > 0 ? f.esperado.map(etiqueta).join(" + ") : "fuera de cobertura");
  const tabla = filas.map((f) => `| ${f.nombre} | ${asignada(f)} | ${f.km === null ? "-" : f2(f.regla === "fuera_de_8km" ? f.masCercanaSiempre!.km : f.km)} | ${fuenteCoord(f)} | ${nota(f)} |`).join("\n");
  const porSucursal = SUCURSALES_DESPACHO.map((id) => `| ${etiqueta(id)} (${slug[id]}) | ${r.antesPorSucursal[id]} | ${r.coloniasPorSucursal[id]} | ${r.despuesPorSucursal[id]} |`).join("\n");
  const pinesTabla = SUCURSALES_DESPACHO.map((id) => `| ${etiqueta(id)} | ${pines[id]!.lat}, ${pines[id]!.lng} |`).join("\n");
  const fuera = r.fuera.map((f) => `- ${f.nombre}: la mas cercana es ${etiqueta(f.masCercanaSiempre!.id)} a ${f2(f.masCercanaSiempre!.km)} km`).join("\n");
  const sinCoord = r.sinCoordenada.map((f) => `- ${f.nombre}`).join("\n");
  const sobrantes = r.sobrantes.map((f) => `- ${f.nombre}: hoy ${f.antes.map(etiqueta).join(", ")} (${f.regla === "homonimo_pendiente" ? "homonimo pendiente" : "sin coordenada"}); no se toca`).join("\n");
  const retiros = r.retirosFuera.map((f) => `- ${f.nombre}: ${f.antes.map(etiqueta).join(", ")} -> sin cobertura (la mas cercana es ${f.masCercanaSiempre!.id} a ${f2(f.masCercanaSiempre!.km)} km)`).join("\n");
  const nRetiros = r.retirosFuera.reduce((n, f) => n + f.antes.length, 0);
  const explicitasTabla = r.explicitas.filter((f) => f.coordenada).map((f) => {
    const o = f.opcionRegla!;
    return `| ${f.nombre} | ${etiqueta(f.esperado[0]!)} a ${f2(f.km!)} km | ${o.sucursal ? etiqueta(o.sucursal) : "fuera de cobertura"} a ${f2(o.km)} km | ${f.etiqueta} | ${f.difiereDeLaRegla ? "difiere: pendiente de decision de Javier" : "coincide"}${f.borde.length > 0 ? `; ${notaBorde(f)}` : ""} |`;
  }).join("\n");
  const cambios = filas
    .filter((f) => f.esperado.length > 0 && f.antes.join(",") !== f.esperado.join(","))
    .map((f) => `- ${f.nombre}: ${f.antes.length === 0 ? "sin cobertura" : f.antes.join(", ")} -> ${f.esperado.join(", ")}`)
    .join("\n");
  const bordesLista = bordes.map((f) => `- ${f.nombre} (${asignada(f)}): ${notaBorde(f)}`).join("\n");
  return `# Colonias de Los Taquitos de PM: sucursal más cercana en un radio de 8 km

Generado por \`scripts/seed-pm-demo/generar-colonias-8km.ts\` desde \`scripts/seed-pm-demo/data/pm-seed-data.json\` (no se edita a mano; una prueba falla si se desincroniza).
Orden de Javier (7-oct-2026 13:30 y 17:50): cada colonia a la sucursal de despacho activa más cercana dentro de 8 km, como el despachador de la otra vertical. Criterio conservador vigente (reversible por Javier): la cobertura explícita del dueño manda sobre la geometría.

## Regla

1. Cada colonia se asigna a la sucursal de **despacho activa más cercana**, en línea recta (Haversine, radio terrestre ${RADIO_TIERRA_KM} km), desde el pin de la sucursal hasta la coordenada de la colonia, si está a **${RADIO_REPARTO_KM} km o menos** (el límite es inclusivo: 8.00 km entra, 8.01 km no).
2. Despachan T1, T2, T3, T7 y T8 (las cinco activas). Galerías (T4) y Playa/Chicxulub (T5) están inactivas y **no reciben colonias**.
3. Las colonias a más de 8 km de toda sucursal de despacho quedan **fuera de cobertura**: no se asignan, se listan y, si hoy tienen cobertura, la carga **retira toda su cobertura**, de cualquier sucursal (tope exacto: sobre la base real son exactamente Mulchechen-T1, Salvador Alvarado Sur-T3 y Santa Maria Chi-T8). Las que no tienen coordenada tampoco se asignan: las coordenadas nunca se estiman a mano; si hoy tienen cobertura se listan y no se tocan.
4. Empate exacto de distancia: gana la primera en el orden T1, T2, T3, T7, T8. Se marca **borde** cuando la colonia queda a ${MARGEN_BORDE_KM * 1000} m o menos del límite de 8 km, o cuando la segunda sucursal (también dentro de 8 km) está a ${MARGEN_BORDE_KM * 1000} m o menos de la primera.
5. **Cobertura explícita del dueño** (criterio conservador): manda sobre la geometría. Son ${r.explicitas.length}: ${r.explicitas.map((f) => f.nombre).join(", ")}. Cabo Norte y Los Pinos no tienen coordenada (no hay distancia que comparar); las otras cuatro difieren de la regla y están en la sección «Explícitas del dueño que difieren de la regla de 8 km».
6. Los homónimos con discrepancia entre Google y OSM mayor a 1 km se asignan con la coordenada elegida en colonias-v3 y quedan marcados «REVISAR»; San José (nombre genérico, lecturas a 11.4 km entre sí) queda pendiente del dueño, sin asignar.

## Pines de las sucursales de despacho

| Sucursal | Pin (lat, lng) — ficha de negocio de Google Maps, 7-oct-2026 |
|---|---|
${pinesTabla}

Son los pines propuestos de los datos (\`coordenadas_propuestas\`), **pendientes de confirmar por el dueño**. Las coordenadas vigentes en \`branch_detail\` de T1, T2, T7 y T8 siguen desviadas 1.9 a 4.4 km y T3 no tiene; esta carga **no las modifica** (ver «Lo que no cubre»).

## Resultado

- Colonias en la lista: ${filas.length}. **Asignadas: ${r.asignadas}** (${r.asignadas - r.explicitas.length} por la regla + ${r.explicitas.length} explícitas del dueño). **Sin cobertura: ${r.fuera.length + r.sinCoordenada.length + r.homonimosPendientes.length}** (${r.fuera.length} a más de 8 km + ${r.sinCoordenada.length} sin coordenada + ${r.homonimosPendientes.length} homónimo pendiente).
- Colonias marcadas borde: ${bordes.length}.
- Base real el 8-oct-2026: ${sumaAntes} filas de cobertura. Al cargar: +${r.altas} altas, -${r.reemplazos} reemplazos (retiro por pares de la sucursal equivocada), -${nRetiros} retiros de colonias a más de 8 km = ${sumaDespues} filas. ${r.sobrantes.length} colonias sin coordenada o con homónimo pendiente conservan su cobertura actual (pendientes del dueño).
- La carga actualiza \`known_zone.asignacion_fuente\` solo en las zonas cuya cobertura cambia y **sobrescribe** su procedencia anterior (sobre la base real del 8-oct: sin_asignar 19, ambigua_cubierta_por_dos 14, distancia_piloto 4, mas_cercana_osm_v2b 4, reasignada_desde_galerias 1); no toca ninguna etiqueta dueno_zona_centro ni chats_t7; las colonias a más de 8 km retiradas quedan «sin_asignar». Las 14 colonias con doble cobertura quedan en una sola.

### Conteos por sucursal

| Sucursal | Filas hoy (base real) | Colonias asignadas (incluye las explícitas del dueño) | Filas después de cargar |
|---|---|---|---|
${porSucursal}
| **Total** | **${sumaAntes}** | **${r.asignadas}** | **${sumaDespues}** |

«Filas» incluye los puntos de sucursal que ya son zona conocida (T1, T7 y T8 tienen uno; el de T2 es la colonia Francisco de Montejo) y las coberturas de las colonias pendientes de abajo. «Colonias asignadas» cuenta solo colonias de la lista e incluye Cabo Norte y Los Pinos y las cuatro explícitas del dueño que difieren de la regla.

## Explícitas del dueño que difieren de la regla de 8 km: pendiente de decisión de Javier

Se conservan con la sucursal del dueño (criterio conservador, reversible). Etiqueta de procedencia en \`known_zone.asignacion_fuente\`: la de la columna «Etiqueta». Si Javier decide aplicar la regla, solo hay que cambiar la asignación en los datos y regenerar.

| Colonia | Opción del dueño (km) | Opción de la regla de 8 km (km) | Etiqueta | Nota |
|---|---|---|---|---|
${explicitasTabla}

Evidencia: Centro y Centro Histórico, «Prolongación Montejo.- zona centro, norte» (cuestionario l.153); Benito Juárez Norte, chats de T7 y P-v2-16 de pendientes-dueno.md (la geometría es un empate de 59 m); Real Montejo, chats de T7 (evidencia débil: preguntar al dueño).

## Sin cobertura

Más de 8 km de toda sucursal de despacho (${r.fuera.length}):

${fuera}

Retiros que hace la carga (${nRetiros}):

${retiros}

Sin coordenada (${r.sinCoordenada.length}) y homónimo pendiente (${r.homonimosPendientes.length}): pendientes del dueño, no se asignan:

${sinCoord}
${r.homonimosPendientes.map((f) => `- ${f.nombre} (homónimo pendiente)`).join("\n")}

Las que hoy tienen cobertura y no se tocan:

${sobrantes}

## Colonias borde

${bordesLista}

## Cambios contra la base real

Altas y reemplazos que hace el SQL de carga (${r.altas} altas y ${r.reemplazos} reemplazos; los retiros están arriba):

${cambios}

## Tabla colonia → sucursal

Distancia en km al pin de la sucursal asignada (en las que quedan fuera, a la más cercana). Fuente de coordenadas: Google Maps y OpenStreetMap según \`colonias-v3\` (nunca estimadas a mano; los pines de sucursal salen de la ficha de negocio de Google).

| Colonia | Sucursal asignada | km | Fuente de coordenadas | Nota |
|---|---|---|---|---|
${tabla}

## Cómo se aplica y se comprueba

1. \`scripts/seed-pm-demo/sql/colonias-8km-carga.sql\`: idempotente, una transacción (\`begin\` ... \`commit\`) con comprobaciones que abortan. \`supabase db query --linked -f colonias-8km-carga.sql\`. Segunda corrida: 0 cambios. El archivo con varias sentencias y \`begin\`/\`commit\` se envía como una sola consulta de protocolo simple (comprobado en un Postgres efímero con \`psql -c\`, que usa el mismo mensaje; la CLI de Supabase devuelve solo el resultado de la última sentencia, el SELECT final); si una comprobación aborta, nada se aplica. Tras un aborto la sesión de esa consulta termina; no hace falta limpiar nada.
2. \`scripts/seed-pm-demo/sql/colonias-8km-verifica.sql\`: solo lectura; recalcula en la base la sucursal más cercana de cada colonia y la compara con lo cargado. Debe devolver \`PASA\` con 0 diferencias (una colonia a más de 8 km que conserve cobertura cuenta como diferencia).
3. Prueba \`packages/domain-restaurantes/tests/colonias-radio-8km.spec.ts\`: recalcula con Haversine todo el dataset y falla si alguna asignación no es la más cercana a 8 km o menos (incluye 7.99 / 8.00 / 8.01 km y empate).

## Lo que no cubre

- **Seguimiento de los pines:** no cambia \`branch_detail.lat/lng\`. Las coordenadas vigentes de T1, T2, T7 y T8 están desviadas 1.9 a 4.4 km y T3 no tiene; con un pin de WhatsApp y sin colonia, el agente mide contra esas coordenadas desviadas hasta que el dueño confirme los pines (\`coordenadas_propuestas\`; la dirección de T8 también está por confirmar) y se encienda la bandera de coordenadas propuestas. La cobertura de colonias de este documento no depende de eso.
- No escribe coordenadas de colonias en \`known_zone\` (lat/lng siguen nulos), no toca \`whatsapp_branch_channel\` (0 filas) ni la cuenta demo.
- No decide por el dueño los homónimos ni los bordes: quedan marcados para revisión.
`;
}
