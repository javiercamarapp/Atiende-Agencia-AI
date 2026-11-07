// Seed REPETIBLE e idempotente de la cuenta demo de rentas (Rn-33): una gestora con 3 propiedades, 5 unidades, 3 propietarios, feeds iCal
// (con .ics de fixture local, sin internet), reservas importadas y directas, un conflicto abierto, tareas de limpieza, una incidencia,
// plantillas, borradores pendientes, reglas de comision y movimientos financieros. Ver scripts/seed-rentas-demo/README.md.
//
// Modulo PURO (sin red ni fs): arma el plan (parseando los .ics con el parser REAL del dominio), lo valida y renderiza el bloque plpgsql
// que la CLI ejecuta en UNA transaccion; el verificador contra Postgres real (scripts/verify-rentas-seed) ejecuta ese mismo bloque.
//
// Contrato de seguridad: todo dato es ficticio (apellido "Demo", correos @example.test, contactos con lada "00"); la cuenta queda marcada
// por su slug `demo-...` (la consola de superadmin cuenta como demo toda organizacion `demo-%`; NO hay SQL nuevo: ninguna tabla de marca) y el seed
// NUNCA toca una organizacion que ya exista con ese slug y no sea de rentas. Escribe como el rol del operador (el mismo criterio de seed-pm-demo y
// seed-citas-demo: SEED_DATABASE_URL, nunca DATABASE_URL), no con el JWT de un usuario: es un script de operador, no una ruta de la aplicacion.
import { parsearIcs } from "../ical/parser.ts";
import { calcularMovimientoReserva } from "../finanzas/movimiento.ts";
import { ANCLA_FIXTURES_ICS, DATOS_RENTAS_DEMO, NOMBRE_DEMO_RENTAS, SLUG_DEMO_RENTAS } from "./rentas-demo-data.ts";
import type { CanalSeed, DatosRentasDemo, IncidenciaSeed, PlantillaSeed, TareaSeed } from "./rentas-demo-data.ts";

export const SEED_VERSION = "rentas-demo-1";
/**
 * Variables de plantilla que el sistema sabe llenar. Copia a proposito de `VARIABLES_PLANTILLA` (mensajes-automaticos/variables.ts): este
 * modulo lo carga `node --experimental-strip-types` y esa cadena de imports usa "parameter properties", que ese modo no soporta. Un test
 * (seed-rentas-demo.spec.ts) falla si las dos listas se desincronizan.
 */
export const VARIABLES_PLANTILLA_SOPORTADAS: readonly string[] = ["huesped", "propiedad", "unidad", "fecha_check_in", "fecha_check_out", "noches"];
const PATRON_VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
export const FUENTE_REGLA_DEMO = "Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal";

export class RentasSeedError extends Error {}
const fail = (msg: string): never => {
  throw new RentasSeedError(msg);
};

export interface PlanReserva {
  readonly externalId: string;
  readonly propiedad: string;
  readonly unidad: string;
  readonly canal: CanalSeed;
  /** Dias respecto de hoy (zona de la propiedad) en que empieza. */
  readonly desde: number;
  readonly noches: number;
  readonly origen: "ical" | "directa";
  readonly dtstamp: string | null;
  readonly huesped: string | null;
  readonly contacto: string | null;
  readonly financiero: null | {
    readonly brutoCentavos: number;
    readonly yaNeto: boolean;
    readonly comisionCanalBasisPoints: number;
    readonly comisionCanalFuente: string;
    readonly comisionCanalCentavos: number;
    readonly comisionGestorBasisPoints: number;
    readonly comisionGestorCentavos: number;
    readonly montoRecibidoCentavos: number;
    readonly gastosCentavos: number;
    readonly netoCentavos: number;
  };
}

export type PlanTarea = TareaSeed & { readonly deReservaExternalId: string | null };

export interface RentasSeedPlan {
  readonly seedVersion: string;
  readonly organizacion: { readonly slug: string; readonly nombre: string };
  readonly propietarios: readonly { clave: string; nombre: string; email: string }[];
  readonly propiedades: readonly {
    nombre: string;
    zonaHoraria: string;
    accesoActivo: boolean;
    unidades: readonly { nombre: string; propietario: string; duracionMinimaNoches: number; tarifaBaseCentavos: number; temporada: null | { nombre: string; desde: number; hasta: number; precioCentavos: number } }[];
  }[];
  readonly feeds: readonly { propiedad: string; unidad: string; canal: string; url: string; estado: "ok" | "cuarentena" }[];
  readonly reservas: readonly PlanReserva[];
  readonly bloqueos: readonly { externalId: string; propiedad: string; unidad: string; razon: string; desde: number; noches: number }[];
  readonly conflicto: { propiedad: string; unidad: string; reservaExternalId: string; bloqueoExternalId: string };
  readonly tareas: readonly PlanTarea[];
  readonly incidencias: readonly IncidenciaSeed[];
  readonly plantillas: readonly PlantillaSeed[];
  readonly conversaciones: readonly { propiedad: string; unidad: string; canal: string; reservaExternalId: string; huesped: string; mensajeEntrante: string; borradorPendiente: string }[];
  readonly reglasComision: readonly { canal: string; yaNeto: boolean; bps: number }[];
  readonly summary: {
    readonly propiedades: number;
    readonly unidades: number;
    readonly propietarios: number;
    readonly feeds: number;
    readonly reservasImportadas: number;
    readonly reservasDirectas: number;
    readonly bloqueos: number;
    readonly conflictosAbiertos: number;
    readonly tareas: number;
    readonly incidencias: number;
    readonly plantillas: number;
    readonly plantillasAprobadas: number;
    readonly borradoresPendientes: number;
    readonly reglasComision: number;
    readonly movimientosFinancieros: number;
  };
}

const MS_DIA = 86_400_000;
function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / MS_DIA);
}

/** Contacto ficticio con lada "00" (inexistente en Mexico). */
function contactoFicticio(i: number): string {
  return `+52 00 0000 ${String(1000 + i)}`;
}

function urlFeedDemo(fixture: string): string {
  // `.invalid` (RFC 6761) nunca resuelve: la cuenta demo no depende de internet ni puede consultar un calendario real.
  return `https://calendarios.demo.invalid/ical/${fixture}`;
}

/** Valida los datos y arma el plan. `fixturesIcs`: contenido de cada .ics por nombre de archivo. Lanza `RentasSeedError` con el motivo exacto. */
export function buildRentasSeedPlan(fixturesIcs: Readonly<Record<string, string>>, datos: DatosRentasDemo = DATOS_RENTAS_DEMO): RentasSeedPlan {
  if (!/^demo-[a-z0-9-]+$/.test(SLUG_DEMO_RENTAS)) fail("el slug de la cuenta demo debe empezar con demo-");
  const propietarios = new Map(datos.propietarios.map((p) => [p.clave, p]));
  if (propietarios.size !== datos.propietarios.length) fail("propietarios duplicados");
  for (const p of datos.propietarios) if (!/^[^\s@]+@example\.test$/.test(p.email)) fail(`el correo de ${p.nombre} debe ser @example.test`);

  const unidades = new Map<string, { propiedad: string; nombre: string; propietario: string; tarifaBaseCentavos: number; duracionMinimaNoches: number }>();
  const nombresPropiedad = new Set<string>();
  for (const pr of datos.propiedades) {
    if (nombresPropiedad.has(pr.nombre)) fail(`propiedad duplicada: ${pr.nombre}`);
    nombresPropiedad.add(pr.nombre);
    for (const u of pr.unidades) {
      const k = `${pr.nombre}|${u.nombre}`;
      if (unidades.has(k)) fail(`unidad duplicada: ${k}`);
      if (!propietarios.has(u.propietario)) fail(`${k}: propietario inexistente (${u.propietario})`);
      if (!(u.tarifaBaseCentavos > 0)) fail(`${k}: tarifa base invalida`);
      if (u.temporada && !(u.temporada.hasta > u.temporada.desde && u.temporada.precioCentavos > 0)) fail(`${k}: temporada invalida`);
      unidades.set(k, { propiedad: pr.nombre, nombre: u.nombre, propietario: u.propietario, tarifaBaseCentavos: u.tarifaBaseCentavos, duracionMinimaNoches: u.duracionMinimaNoches });
    }
  }
  const unidadDe = (propiedad: string, unidad: string, donde: string) => unidades.get(`${propiedad}|${unidad}`) ?? fail(`${donde}: unidad inexistente ${propiedad} / ${unidad}`);

  const reglas = new Map(datos.reglasComision.map((r) => [r.canal, r]));
  if (reglas.size !== datos.reglasComision.length) fail("reglas de comision duplicadas");
  for (const canal of ["airbnb", "vrbo", "booking", "manual"] as const) if (!reglas.has(canal)) fail(`falta la regla de comision de ${canal}`);

  const movimiento = (unidad: ReturnType<typeof unidadDe>, canal: CanalSeed, noches: number, gastoCentavos: number): NonNullable<PlanReserva["financiero"]> => {
    const regla = reglas.get(canal)!;
    const bruto = unidad.tarifaBaseCentavos * noches;
    const m = calcularMovimientoReserva({
      ocupacionUnidadId: "demo",
      moneda: "MXN",
      montoBrutoCentavos: bruto,
      comisionCanal: { yaNetoDeComision: regla.yaNetoDeComision, comisionBasisPoints: regla.comisionBasisPoints, fuente: FUENTE_REGLA_DEMO },
      comisionGestor: { basisPoints: datos.comisionGestorBasisPoints, base: "neto_de_canal" },
      gastos: gastoCentavos > 0 ? [{ tipo: "limpieza", montoCentavos: gastoCentavos }] : [],
      impuestos: [],
    });
    return {
      brutoCentavos: bruto,
      yaNeto: regla.yaNetoDeComision,
      comisionCanalBasisPoints: regla.comisionBasisPoints,
      comisionCanalFuente: FUENTE_REGLA_DEMO,
      comisionCanalCentavos: m.comisionCanalCentavos,
      comisionGestorBasisPoints: datos.comisionGestorBasisPoints,
      comisionGestorCentavos: m.comisionGestorCentavos,
      montoRecibidoCentavos: m.montoRecibidoCentavos,
      gastosCentavos: m.gastosCentavos,
      netoCentavos: m.netoCentavos,
    };
  };

  const reservas: PlanReserva[] = [];
  // 1) Importadas: salen de los .ics con el parser real.
  const feeds = datos.feeds.map((f) => {
    unidadDe(f.propiedad, f.unidad, `feed ${f.fixture}`);
    const ics = fixturesIcs[f.fixture] ?? fail(`falta el fixture ${f.fixture}`);
    return { propiedad: f.propiedad, unidad: f.unidad, canal: f.canal, url: urlFeedDemo(f.fixture), estado: f.estado, ics };
  });
  const claves = new Set<string>();
  for (const f of feeds) {
    const u = unidadDe(f.propiedad, f.unidad, `feed ${f.url}`);
    const cal = parsearIcs(f.ics);
    if (cal.eventos.length === 0) fail(`el fixture de ${f.unidad}/${f.canal} no trae eventos`);
    for (const e of cal.eventos) {
      if (e.status === "CANCELLED") fail(`${e.uid}: un evento cancelado no es una reserva demo`);
      const ini = e.dtstart;
      const fin = e.dtend;
      if (ini.tipo !== "DATE" || fin.tipo !== "DATE") throw new RentasSeedError(`${e.uid}: el fixture debe usar fechas de dia completo (VALUE=DATE)`);
      const desde = diasEntre(ANCLA_FIXTURES_ICS, ini.fecha);
      const noches = diasEntre(ini.fecha, fin.fecha);
      if (noches < 1) fail(`${e.uid}: rango invalido`);
      if (claves.has(e.uid)) fail(`UID repetido: ${e.uid}`);
      claves.add(e.uid);
      const pasada = desde + noches <= 0;
      reservas.push({ externalId: e.uid, propiedad: f.propiedad, unidad: f.unidad, canal: f.canal, desde, noches, origen: "ical", dtstamp: e.dtstamp, huesped: null, contacto: null, financiero: pasada ? movimiento(u, f.canal, noches, 0) : null });
    }
  }
  // 2) Directas.
  let n = 0;
  for (const r of datos.reservasDirectas) {
    const u = unidadDe(r.propiedad, r.unidad, `reserva ${r.clave}`);
    const externalId = `demo-dir-${r.clave}`;
    if (claves.has(externalId)) fail(`clave de reserva repetida: ${r.clave}`);
    claves.add(externalId);
    if (r.conFinanciero && r.desde + r.noches > 0) fail(`${r.clave}: solo una reserva ya terminada puede traer movimiento financiero`);
    reservas.push({ externalId, propiedad: r.propiedad, unidad: r.unidad, canal: "manual", desde: r.desde, noches: r.noches, origen: "directa", dtstamp: null, huesped: r.huesped, contacto: contactoFicticio(n++), financiero: r.conFinanciero ? movimiento(u, "manual", r.noches, r.gastoLimpiezaCentavos ?? 0) : null });
  }
  // Sin solapes por unidad (la base lo rechazaria con la exclusion de ocupacion, pero el plan debe fallar antes de tocar nada).
  const porUnidad = new Map<string, PlanReserva[]>();
  for (const r of reservas) porUnidad.set(`${r.propiedad}|${r.unidad}`, [...(porUnidad.get(`${r.propiedad}|${r.unidad}`) ?? []), r]);
  for (const [k, lista] of porUnidad) {
    const ordenadas = [...lista].sort((a, b) => a.desde - b.desde);
    for (let i = 1; i < ordenadas.length; i++) {
      const prev = ordenadas[i - 1]!;
      if (ordenadas[i]!.desde < prev.desde + prev.noches) fail(`${k}: ${ordenadas[i]!.externalId} se empalma con ${prev.externalId}`);
    }
    const min = unidades.get(k)!.duracionMinimaNoches;
    for (const r of lista) if (r.noches < min) fail(`${k}: ${r.externalId} dura menos que la estancia minima (${min})`);
  }

  const bloqueos = datos.bloqueos.map((b) => {
    unidadDe(b.propiedad, b.unidad, `bloqueo ${b.clave}`);
    if (b.noches < 1) fail(`bloqueo ${b.clave}: rango invalido`);
    return { externalId: `demo-blq-${b.clave}`, propiedad: b.propiedad, unidad: b.unidad, razon: b.razon, desde: b.desde, noches: b.noches };
  });
  const ca = datos.conflictoAbierto;
  unidadDe(ca.propiedad, ca.unidad, "conflicto abierto");
  const reservaConflicto = reservas.find((r) => r.externalId === ca.reserva || r.externalId === `demo-dir-${ca.reserva}`) ?? fail(`conflicto abierto: reserva inexistente ${ca.reserva}`);
  const bloqueoConflicto = bloqueos.find((b) => b.externalId === `demo-blq-${ca.bloqueo}`) ?? fail(`conflicto abierto: bloqueo inexistente ${ca.bloqueo}`);
  if (!(reservaConflicto.desde < bloqueoConflicto.desde + bloqueoConflicto.noches && bloqueoConflicto.desde < reservaConflicto.desde + reservaConflicto.noches)) fail("conflicto abierto: la reserva y el bloqueo no se cruzan");
  if (`${reservaConflicto.propiedad}|${reservaConflicto.unidad}` !== `${ca.propiedad}|${ca.unidad}`) fail("conflicto abierto: la reserva es de otra unidad");

  const existe = (ext: string) => reservas.some((r) => r.externalId === ext || r.externalId === `demo-dir-${ext}`);
  const externalDe = (ext: string) => reservas.find((r) => r.externalId === ext || r.externalId === `demo-dir-${ext}`)!.externalId;
  const tareas = datos.tareas.map((t) => {
    unidadDe(t.propiedad, t.unidad, "tarea");
    if (t.deReserva !== null && !existe(t.deReserva)) fail(`tarea: reserva inexistente ${t.deReserva}`);
    return { ...t, deReservaExternalId: t.deReserva === null ? null : externalDe(t.deReserva) };
  });
  for (const i of datos.incidencias) unidadDe(i.propiedad, i.unidad, "incidencia");
  const eventos = new Set<string>();
  for (const p of datos.plantillas) {
    if (eventos.has(p.evento)) fail(`plantilla duplicada: ${p.evento}`);
    eventos.add(p.evento);
    const raras = [...new Set([...p.cuerpo.matchAll(PATRON_VARIABLE)].map((m) => m[1]!))].filter((v) => !VARIABLES_PLANTILLA_SOPORTADAS.includes(v));
    if (raras.length > 0) fail(`plantilla ${p.evento}: variables no soportadas (${raras.join(", ")})`);
  }
  const conversaciones = datos.conversaciones.map((c) => {
    unidadDe(c.propiedad, c.unidad, "conversacion");
    if (!existe(c.reserva)) fail(`conversacion: reserva inexistente ${c.reserva}`);
    const r = reservas.find((x) => x.externalId === externalDe(c.reserva))!;
    if (r.canal !== c.canal) fail(`conversacion: ${c.reserva} no es de ${c.canal}`);
    return { propiedad: c.propiedad, unidad: c.unidad, canal: c.canal, reservaExternalId: r.externalId, huesped: c.huesped, mensajeEntrante: c.mensajeEntrante, borradorPendiente: c.borradorPendiente };
  });

  return {
    seedVersion: SEED_VERSION,
    organizacion: { slug: SLUG_DEMO_RENTAS, nombre: NOMBRE_DEMO_RENTAS },
    propietarios: datos.propietarios.map((p) => ({ ...p })),
    propiedades: datos.propiedades.map((p) => ({ nombre: p.nombre, zonaHoraria: p.zonaHoraria, accesoActivo: p.accesoActivo, unidades: p.unidades.map((u) => ({ nombre: u.nombre, propietario: u.propietario, duracionMinimaNoches: u.duracionMinimaNoches, tarifaBaseCentavos: u.tarifaBaseCentavos, temporada: u.temporada ?? null })) })),
    feeds: feeds.map(({ ics: _ics, ...f }) => f),
    reservas,
    bloqueos,
    conflicto: { propiedad: ca.propiedad, unidad: ca.unidad, reservaExternalId: reservaConflicto.externalId, bloqueoExternalId: bloqueoConflicto.externalId },
    tareas,
    incidencias: datos.incidencias,
    plantillas: datos.plantillas,
    conversaciones,
    reglasComision: datos.reglasComision.map((r) => ({ canal: r.canal, yaNeto: r.yaNetoDeComision, bps: r.comisionBasisPoints })),
    summary: {
      propiedades: datos.propiedades.length,
      unidades: unidades.size,
      propietarios: datos.propietarios.length,
      feeds: feeds.length,
      reservasImportadas: reservas.filter((r) => r.origen === "ical").length,
      reservasDirectas: reservas.filter((r) => r.origen === "directa").length,
      bloqueos: bloqueos.length,
      conflictosAbiertos: 1,
      tareas: tareas.length,
      incidencias: datos.incidencias.length,
      plantillas: datos.plantillas.length,
      plantillasAprobadas: datos.plantillas.filter((p) => p.aprobada).length,
      borradoresPendientes: conversaciones.length,
      reglasComision: datos.reglasComision.length,
      movimientosFinancieros: reservas.filter((r) => r.financiero !== null).length,
    },
  };
}

/** SQL que lista lo que falta en la base para que el seed pueda correr (vacio = todo listo). Solo tablas/columnas que el seed escribe. */
export function renderRentasSchemaPreflightSql(): string {
  const requisitos: readonly (readonly [string, string, string])[] = [
    ["tabla rentas.ocupacion", "001_rentas_schema", "to_regclass('rentas.ocupacion') is null"],
    ["tabla rentas.tarifa_base", "002_pricing_schema", "to_regclass('rentas.tarifa_base') is null"],
    ["tabla rentas.regla_comision_canal", "003_finanzas_schema", "to_regclass('rentas.regla_comision_canal') is null"],
    ["tabla rentas.canal_feed_externo", "008_ical_sync_schema", "to_regclass('rentas.canal_feed_externo') is null"],
    ["tabla rentas.plantilla_mensaje", "009_rentas_mensajeria_schema", "to_regclass('rentas.plantilla_mensaje') is null"],
    ["tabla rentas.tarea_operativa", "010_rentas_limpieza_schema", "to_regclass('rentas.tarea_operativa') is null"],
    ["columna rentas.canal_feed_externo.ultimo_intento_en", "024_rentas_ical_sync_lease_backoff_bitacora", "not exists (select 1 from information_schema.columns where table_schema = 'rentas' and table_name = 'canal_feed_externo' and column_name = 'ultimo_intento_en')"],
    ["tabla rentas.acceso_politica", "025_rentas_acceso_huesped", "to_regclass('rentas.acceso_politica') is null"],
    ["columna rentas.plantilla_mensaje.aprobada_por_tenant", "009_rentas_mensajeria_schema", "not exists (select 1 from information_schema.columns where table_schema = 'rentas' and table_name = 'plantilla_mensaje' and column_name = 'aprobada_por_tenant')"],
    ["funcion rentas.sembrar_reglas_comision_base", "027_rentas_operar_tenant_nuevo", "to_regprocedure('rentas.sembrar_reglas_comision_base(uuid)') is null"],
  ];
  return `select faltante, migracion from (values
    ${requisitos.map(([f, m]) => `('${f}', '${m}')`).join(",\n    ")}
  ) as t(faltante, migracion)
  where ${requisitos.map(([f, , cond]) => `(faltante = '${f}' and ${cond})`).join("\n     or ")};`;
}

/**
 * Cuerpo plpgsql del seed (sin envolver). Una sola transaccion (la abre la CLI). Idempotente:
 *   * organizacion por slug estable (si existe en otra vertical, ABORTA sin tocarla); el prefijo `demo-` del slug es la marca;
 *   * propiedades por nombre, unidades por (propiedad, nombre), propietarios por (organizacion, correo), feeds por (unidad, canal);
 *   * ocupaciones por (unidad, external_id): re-ejecutar NO duplica ni mueve las ya sembradas (aunque hoy sea otro dia);
 *   * tablas sin llave natural (tareas, incidencias, conversaciones) solo se siembran si la organizacion demo aun no tiene filas;
 *   * las reglas de comision SUGERIDAS (que nacen con la organizacion, migracion 027) se confirman con valores de demo; una regla que el
 *     usuario ya edito no se pisa.
 * Fechas: offsets respecto de HOY en la zona horaria de cada propiedad.
 * `ownerEmail`: el correo de un usuario de staff que YA existe (nunca crea credenciales); si no existe, el seed ABORTA.
 */
export function renderRentasSeedPlpgsql(plan: RentasSeedPlan, options: { readonly ownerEmail: string }): string {
  const email = options.ownerEmail.trim().toLowerCase();
  if (!/^[^\s@'$]+@[^\s@'$]+\.[^\s@'$]+$/.test(email)) fail("ownerEmail invalido.");
  const json = JSON.stringify({ ...plan, summary: undefined });
  if (json.includes("$rd$")) fail("los datos del seed contienen el delimitador $rd$");
  return `declare
  v jsonb := $rd$${json}$rd$::jsonb;
  v_user uuid;
  v_org uuid;
  v_vertical text;
  v_prop uuid;
  v_zona text;
  v_hoy date;
  v_unidad uuid;
  v_owner uuid;
  v_canal uuid;
  v_oc uuid;
  v_oc_b uuid;
  v_guest uuid;
  v_rf uuid;
  v_conv uuid;
  v_msg uuid;
  v_tarea uuid;
  r jsonb;
  x jsonb;
begin
  select id into v_user from core.staff_user where lower(email) = '${email}';
  if v_user is null then
    raise exception 'seed-rentas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  -- 1) organizacion demo (slug demo-...): solo se crea o se actualiza una organizacion de rentas; cualquier otra con ese slug aborta.
  select id, vertical into v_org, v_vertical from core.organization where slug = v->'organizacion'->>'slug';
  if v_org is not null then
    if v_vertical <> 'rentas' then
      raise exception 'seed-rentas: el slug % ya existe y no es de rentas; no se toca.', v->'organizacion'->>'slug';
    end if;
    update core.organization set name = v->'organizacion'->>'nombre' where id = v_org;
  else
    insert into core.organization (vertical, name, slug) values ('rentas', v->'organizacion'->>'nombre', v->'organizacion'->>'slug') returning id into v_org;
  end if;
  -- El trigger de organization_perfil (027) siembra las 4 reglas de comision SUGERIDAS de la organizacion.
  insert into rentas.organization_perfil (organization_id, tipo) values (v_org, 'empresa_gestora') on conflict (organization_id) do nothing;
  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
    values (v_user, v_org, null, 'owner', 'admin_gestora')
    on conflict do nothing;

  -- 2) propietarios (por organizacion + correo)
  for r in select * from jsonb_array_elements(v->'propietarios') loop
    select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
      where oo.organization_id = v_org and lower(o.email) = lower(r->>'email');
    if v_owner is null then
      insert into rentas.owner (name, email) values (r->>'nombre', r->>'email') returning id into v_owner;
      insert into rentas.owner_organization (owner_id, organization_id) values (v_owner, v_org);
    end if;
  end loop;

  -- 3) propiedades, configuracion, politica de acceso, unidades, tarifas
  for r in select * from jsonb_array_elements(v->'propiedades') loop
    select id into v_prop from core.property where organization_id = v_org and name = r->>'nombre';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'rentas', r->>'nombre', 'active') returning id into v_prop;
    end if;
    insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values (v_prop, v_org, r->>'zonaHoraria', 'MXN')
      on conflict (property_id) do nothing;
    if (r->>'accesoActivo')::boolean then
      insert into rentas.acceso_politica (property_id, organization_id, activo, updated_by) values (v_prop, v_org, true, v_user)
        on conflict (property_id) do nothing;
    end if;
    select zona_horaria into v_zona from rentas.property_config where property_id = v_prop;
    v_hoy := (now() at time zone v_zona)::date;
    for x in select * from jsonb_array_elements(r->'unidades') loop
      select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
        where oo.organization_id = v_org and lower(o.email) = lower((select p->>'email' from jsonb_array_elements(v->'propietarios') p where p->>'clave' = x->>'propietario'));
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'nombre';
      if v_unidad is null then
        insert into rentas.unidad (organization_id, property_id, owner_id, name, duracion_minima_noches)
          values (v_org, v_prop, v_owner, x->>'nombre', (x->>'duracionMinimaNoches')::int) returning id into v_unidad;
      end if;
      if not exists (select 1 from rentas.tarifa_base where unidad_id = v_unidad) then
        insert into rentas.tarifa_base (organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde, creado_por)
          values (v_org, v_prop, v_unidad, (x->>'tarifaBaseCentavos')::bigint, 'MXN', v_hoy - 90, v_user);
      end if;
      if x->'temporada' is not null and x->'temporada' <> 'null'::jsonb
         and not exists (select 1 from rentas.tarifa_temporada where unidad_id = v_unidad and nombre = x->'temporada'->>'nombre') then
        insert into rentas.tarifa_temporada (organization_id, property_id, unidad_id, nombre, fecha_inicio, fecha_fin, precio_noche_centavos, moneda, creado_por)
          values (v_org, v_prop, v_unidad, x->'temporada'->>'nombre', v_hoy + (x->'temporada'->>'desde')::int, v_hoy + (x->'temporada'->>'hasta')::int, (x->'temporada'->>'precioCentavos')::bigint, 'MXN', v_user);
      end if;
    end loop;
  end loop;

  -- 4) reglas de comision: confirma las SUGERIDAS (fuente default_sugerido...) con valores de demo; una regla ya editada no se pisa.
  update rentas.regla_comision_canal rc
    set ya_neto_de_comision = (rg->>'yaNeto')::boolean, comision_basis_points = (rg->>'bps')::int, fuente = '${FUENTE_REGLA_DEMO}'
    from jsonb_array_elements(v->'reglasComision') rg, rentas.canal c
    where c.codigo = rg->>'canal' and rc.organization_id = v_org and rc.canal_id = c.id and rc.property_id is null and rc.fuente like 'default\\_sugerido%';
  insert into rentas.regla_comision_canal (organization_id, property_id, canal_id, ya_neto_de_comision, comision_basis_points, fuente)
    select v_org, null, c.id, (rg->>'yaNeto')::boolean, (rg->>'bps')::int, '${FUENTE_REGLA_DEMO}'
    from jsonb_array_elements(v->'reglasComision') rg join rentas.canal c on c.codigo = rg->>'canal'
    where not exists (select 1 from rentas.regla_comision_canal q where q.organization_id = v_org and q.canal_id = c.id and q.property_id is null);

  -- 5) feeds iCal (por unidad + canal). Las URLs son .invalid: la demo no consulta ningun calendario real.
  for r in select * from jsonb_array_elements(v->'feeds') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo,
                                           ultima_sincronizacion_exitosa_en, en_cuarentena_desde, intentos_fallidos_consecutivos, motivo_cuarentena, ultimo_intento_en)
      values (v_org, v_prop, v_unidad, v_canal, r->>'url', true,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '3 days' end,
              case when r->>'estado' = 'ok' then null else now() - interval '2 days' end,
              case when r->>'estado' = 'ok' then 0 else 6 end,
              case when r->>'estado' = 'ok' then null else 'El calendario dejo de responder (feed demo en cuarentena)' end,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '2 days' end)
      on conflict (unidad_id, canal_id) do nothing;
  end loop;

  -- 6) reservas (importadas y directas) con su huesped minimo, evento importado y movimiento financiero
  for r in select * from jsonb_array_elements(v->'reservas') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId';
    if v_oc is null then
      v_guest := null;
      if r->>'huesped' is not null then
        insert into rentas.guest_minimo (organization_id, property_id, nombre, contacto) values (v_org, v_prop, r->>'huesped', r->>'contacto') returning id into v_guest;
      end if;
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, canal_origen_id, external_id, estado, bloqueante, huesped_minimo_id)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'reserva', 'RESERVA_CANAL', v_canal, r->>'externalId', 'confirmado', true, v_guest)
        returning id into v_oc;
      if r->>'origen' = 'ical' then
        insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
          values (v_org, v_prop, v_unidad, v_canal, r->>'externalId', 0, (r->>'dtstamp')::timestamptz,
                  encode(sha256(convert_to(v_unidad::text || '|' || (r->>'desde') || '|' || (r->>'noches') || '|RESERVA_CANAL', 'UTF8')), 'hex'), v_oc, 'aplicar')
          on conflict (unidad_id, canal_id, uid_evento) do nothing;
      end if;
    end if;
    if r->'financiero' is not null and r->'financiero' <> 'null'::jsonb then
      v_rf := null;
      insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision, comision_canal_basis_points, comision_canal_fuente,
                                             comision_canal_centavos, comision_gestor_basis_points, comision_gestor_base, comision_gestor_centavos, monto_recibido_centavos,
                                             gastos_centavos, impuestos_centavos, neto_centavos, created_by)
        values (v_org, v_prop, v_oc, 'MXN', (r->'financiero'->>'brutoCentavos')::bigint, (r->'financiero'->>'yaNeto')::boolean, (r->'financiero'->>'comisionCanalBasisPoints')::int,
                r->'financiero'->>'comisionCanalFuente', (r->'financiero'->>'comisionCanalCentavos')::bigint, (r->'financiero'->>'comisionGestorBasisPoints')::int, 'neto_de_canal',
                (r->'financiero'->>'comisionGestorCentavos')::bigint, (r->'financiero'->>'montoRecibidoCentavos')::bigint, (r->'financiero'->>'gastosCentavos')::bigint, 0,
                (r->'financiero'->>'netoCentavos')::bigint, v_user)
        on conflict (ocupacion_id) do nothing
        returning id into v_rf;
      if v_rf is not null and (r->'financiero'->>'gastosCentavos')::bigint > 0 then
        insert into rentas.linea_gasto (reserva_financiero_id, tipo, descripcion, monto_centavos, creado_por)
          values (v_rf, 'limpieza', 'Limpieza de salida (demo)', (r->'financiero'->>'gastosCentavos')::bigint, v_user);
      end if;
    end if;
  end loop;

  -- 7) bloqueos y el conflicto abierto (la reserva importada cruza con un bloqueo de mantenimiento)
  for r in select * from jsonb_array_elements(v->'bloqueos') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    if not exists (select 1 from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId') then
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, external_id, estado, bloqueante)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'bloqueo', r->>'razon', r->>'externalId', 'confirmado', true);
    end if;
  end loop;
  x := v->'conflicto';
  select p.id into v_prop from core.property p where p.organization_id = v_org and p.name = x->>'propiedad';
  select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'unidad';
  select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'reservaExternalId';
  select id into v_oc_b from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'bloqueoExternalId';
  if not exists (select 1 from rentas.conflicto_calendario where ocupacion_a_id = v_oc and ocupacion_b_id = v_oc_b) then
    insert into rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
      values (v_org, v_prop, v_unidad, v_oc, v_oc_b, 'capa_cruzada');
  end if;

  -- 8) tareas de limpieza/inspeccion/mantenimiento con su checklist (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.tarea_operativa where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'tareas') loop
      select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
      v_hoy := (now() at time zone v_zona)::date;
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      v_oc := null;
      if r->>'deReservaExternalId' is not null then
        select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'deReservaExternalId';
      end if;
      insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, asignado_a, programada_para, sla_vence_en, completada_en)
        values (v_org, v_prop, v_unidad, v_oc, r->>'tipo', r->>'estado', r->>'prioridad',
                case when (r->>'asignadaAlOwner')::boolean then v_user else null end,
                v_hoy + (r->>'programadaPara')::int,
                case when r->>'slaHoras' is null then null else now() + make_interval(hours => (r->>'slaHoras')::int) end,
                case when r->>'estado' = 'completada' then now() - interval '1 day' else null end)
        returning id into v_tarea;
      insert into rentas.checklist_item_tarea (tarea_id, descripcion, orden, completado, completado_en, completado_por)
        select v_tarea, c.descripcion, c.orden::int - 1, r->>'estado' = 'completada', case when r->>'estado' = 'completada' then now() - interval '1 day' else null end,
               case when r->>'estado' = 'completada' then v_user else null end
        from jsonb_array_elements_text(r->'checklist') with ordinality as c(descripcion, orden);
    end loop;
  end if;

  -- 9) incidencia (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.incidencia_mantenimiento where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'incidencias') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      insert into rentas.incidencia_mantenimiento (organization_id, property_id, unidad_id, severidad, titulo, descripcion, estado, reportado_por)
        values (v_org, v_prop, v_unidad, r->>'severidad', r->>'titulo', r->>'descripcion', 'abierta', v_user);
    end loop;
  end if;

  -- 10) plantillas de mensajeria (por evento + idioma; una plantilla ya editada o aprobada por el usuario no se pisa)
  insert into rentas.plantilla_mensaje (organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa)
    select v_org, p->>'evento', 'es', null, p->>'cuerpo', (p->>'aprobada')::boolean, true
    from jsonb_array_elements(v->'plantillas') p
    where not exists (select 1 from rentas.plantilla_mensaje q where q.organization_id = v_org and q.evento = p->>'evento' and q.idioma = 'es' and q.canal_codigo is null);

  -- 11) conversaciones con su borrador pendiente de aprobacion (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.conversacion where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'conversaciones') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'reservaExternalId';
      insert into rentas.conversacion (organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, propiedad_nombre, huesped_nombre, fecha_check_in, fecha_check_out, reserva_confirmada)
        select v_org, v_prop, v_unidad, r->>'canal', o.id, r->>'propiedad', r->>'huesped', lower(o.rango), upper(o.rango), true from rentas.ocupacion o where o.id = v_oc
        returning id into v_conv;
      insert into rentas.mensaje (conversacion_id, direccion, origen, texto) values (v_conv, 'entrante', 'canal', r->>'mensajeEntrante') returning id into v_msg;
      insert into rentas.borrador_mensaje (conversacion_id, mensaje_entrante_id, canal_codigo, texto, estado, generado_por)
        values (v_conv, v_msg, r->>'canal', r->>'borradorPendiente', 'pendiente_aprobacion', 'agente_llm');
    end loop;
  end if;
end`;
}

/** Envuelve el cuerpo como bloque anonimo (CLI). */
export function renderRentasSeedDoBlock(plan: RentasSeedPlan, options: { readonly ownerEmail: string }): string {
  return `do $seed_rentas$\n${renderRentasSeedPlpgsql(plan, options)}\n$seed_rentas$;`;
}

/**
 * Cuerpo plpgsql de la LIMPIEZA de la cuenta demo: borra la organizacion `demo-...` (todo lo suyo cae en cascada) y los propietarios que solo
 * pertenecian a ella (`rentas.owner` es global: sin esto quedarian huerfanos tras el delete). Un propietario compartido con otra organizacion
 * se conserva. Solo toca la organizacion de rentas con el slug demo; si no existe, no hace nada.
 */
export function renderRentasLimpiarPlpgsql(): string {
  return `declare
  v_org uuid;
  v_owners uuid[];
begin
  select id into v_org from core.organization where slug = '${SLUG_DEMO_RENTAS}' and vertical = 'rentas';
  if v_org is null then
    return;
  end if;
  select coalesce(array_agg(oo.owner_id), '{}') into v_owners from rentas.owner_organization oo
    where oo.organization_id = v_org
      and not exists (select 1 from rentas.owner_organization o2 where o2.owner_id = oo.owner_id and o2.organization_id <> v_org);
  delete from core.organization where id = v_org;
  delete from rentas.owner where id = any (v_owners);
end`;
}

export function renderRentasLimpiarDoBlock(): string {
  return `do $limpiar_rentas$\n${renderRentasLimpiarPlpgsql()}\n$limpiar_rentas$;`;
}
