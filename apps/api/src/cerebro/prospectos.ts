// Prospectos del Cerebro de ventas (SA-L-37): lectura, validacion, guardado con scoring determinista (SA-L-41), personas
// de contacto y linea de tiempo. Las funciones SQL (migracion 0051) exigen caller-binding y superadmin; aqui solo se valida
// la forma, se calcula el score con el modulo determinista y se guarda junto con su version y su explicacion.
//
// El cerebro PROPONE y el humano envia: nada de este modulo contacta a nadie. Aislamiento: solo lee core.prospecto y sus
// tablas hijas, nunca datos de clientes de los tenants.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { avisarCerebroNoMigrado, esCerebroNoMigrado } from "./acceso.ts";
import { calcularScore } from "./scoring.ts";
import type { ProspectoScoring, ResultadoScore, SenalProspecto } from "./scoring.ts";
import { listarTaxonomia, toScoringTaxonomia, vigentesPorVertical, VERTICALES } from "./taxonomia.ts";
import type { TaxonomiaVersion } from "./taxonomia.ts";

export const BASES_LICITUD = ["interes_declarado", "relacion_previa", "fuente_publica_b2b", "referido_con_consentimiento"] as const;
export const ORIGENES_PERSONA = ["sitio_web_oficial", "directorio_publico", "perfil_profesional_publico", "formulario_propio", "referido_documentado"] as const;
export const CANALES_PERSONA = ["telefono", "correo", "whatsapp", "otro"] as const;
export const CONFIANZAS_PERSONA = ["alta", "media", "baja"] as const;

interface ProspectoCerebroRow {
  id: string;
  empresa: string;
  vertical: string;
  ciudad: string | null;
  contacto_nombre: string | null;
  telefono: string | null;
  correo: string | null;
  estado: string;
  fuente: string | null;
  notas: string | null;
  creado_por: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  necesita_seguimiento_desde: string | Date | null;
  subtipo: string | null;
  tamano: string | null;
  entidad: string | null;
  municipio: string | null;
  zona: string | null;
  lat: string | number | null;
  lng: string | number | null;
  sitio_web: string | null;
  sitio_verificado: boolean;
  redes: Record<string, string> | null;
  senales: Array<{ tipo: string; valor?: string | null; fuente: string; url?: string | null; observado_en: string }> | null;
  base_licitud: string | null;
  consentimiento_en: string | Date | null;
  score_ajuste: number | null;
  score_urgencia: number | null;
  score_cierre: number | null;
  score_completitud: number | null;
  score_explicacion: unknown;
  score_version: string | null;
  duplicado_de: string | null;
  vendedor_id: string | null;
  organization_id: string | null;
  org_demo_id: string | null;
  ultimo_toque_en: string | Date | null;
  siguiente_paso: string | null;
  siguiente_paso_en: string | Date | null;
  contacto_legado: boolean;
}

export interface SenalSerializada {
  readonly tipo: string;
  readonly valor: string | null;
  readonly fuente: string;
  readonly url: string | null;
  readonly observadoEn: string;
}

export interface ProspectoCerebro {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly notas: string | null;
  readonly creadoPor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly necesitaSeguimientoDesde: string | null;
  readonly subtipo: string | null;
  readonly tamano: string | null;
  readonly entidad: string | null;
  readonly municipio: string | null;
  readonly zona: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly sitioWeb: string | null;
  readonly sitioVerificado: boolean;
  readonly redes: Readonly<Record<string, string>>;
  readonly senales: readonly SenalSerializada[];
  readonly baseLicitud: string | null;
  readonly consentimientoEn: string | null;
  readonly scoreAjuste: number | null;
  readonly scoreUrgencia: number | null;
  readonly scoreCierre: number | null;
  readonly scoreCompletitud: number | null;
  readonly scoreExplicacion: unknown;
  readonly scoreVersion: string | null;
  readonly duplicadoDe: string | null;
  readonly vendedorId: string | null;
  readonly organizationId: string | null;
  readonly orgDemoId: string | null;
  readonly ultimoToqueEn: string | null;
  readonly siguientePaso: string | null;
  readonly siguientePasoEn: string | null;
  /** `true` = capturado antes de exigir base de licitud: no debe contactarse hasta registrarla. */
  readonly contactoLegado: boolean;
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}
function isoONull(v: string | Date | null): string | null {
  return v === null ? null : iso(v);
}
function numONull(v: string | number | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapProspectoCerebro(r: ProspectoCerebroRow): ProspectoCerebro {
  return {
    id: r.id,
    empresa: r.empresa,
    vertical: r.vertical,
    ciudad: r.ciudad,
    contactoNombre: r.contacto_nombre,
    telefono: r.telefono,
    correo: r.correo,
    estado: r.estado,
    fuente: r.fuente,
    notas: r.notas,
    creadoPor: r.creado_por,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    necesitaSeguimientoDesde: isoONull(r.necesita_seguimiento_desde),
    subtipo: r.subtipo,
    tamano: r.tamano,
    entidad: r.entidad,
    municipio: r.municipio,
    zona: r.zona,
    lat: numONull(r.lat),
    lng: numONull(r.lng),
    sitioWeb: r.sitio_web,
    sitioVerificado: r.sitio_verificado === true,
    redes: r.redes ?? {},
    senales: (r.senales ?? []).map((s) => ({ tipo: s.tipo, valor: s.valor ?? null, fuente: s.fuente, url: s.url ?? null, observadoEn: s.observado_en })),
    baseLicitud: r.base_licitud,
    consentimientoEn: isoONull(r.consentimiento_en),
    scoreAjuste: r.score_ajuste,
    scoreUrgencia: r.score_urgencia,
    scoreCierre: r.score_cierre,
    scoreCompletitud: r.score_completitud,
    scoreExplicacion: r.score_explicacion ?? null,
    scoreVersion: r.score_version,
    duplicadoDe: r.duplicado_de,
    vendedorId: r.vendedor_id,
    organizationId: r.organization_id,
    orgDemoId: r.org_demo_id,
    ultimoToqueEn: isoONull(r.ultimo_toque_en),
    siguientePaso: r.siguiente_paso,
    siguientePasoEn: isoONull(r.siguiente_paso_en),
    contactoLegado: r.contacto_legado === true,
  };
}

export function aProspectoScoring(p: ProspectoCerebro, personasConEvidencia: number): ProspectoScoring {
  const senales: SenalProspecto[] = p.senales.map((s) => ({ tipo: s.tipo, valor: s.valor, fuente: s.fuente, url: s.url, observadoEn: s.observadoEn }));
  return {
    subtipo: p.subtipo,
    tamano: p.tamano,
    ciudad: p.ciudad,
    entidad: p.entidad,
    municipio: p.municipio,
    sitioWeb: p.sitioWeb,
    sitioVerificado: p.sitioVerificado,
    telefono: p.telefono,
    correo: p.correo,
    baseLicitud: p.baseLicitud,
    senales,
    personasConEvidencia,
    actualizadoEn: p.updatedAt,
  };
}

export type ListaProspectos = { readonly disponible: true; readonly prospectos: readonly ProspectoCerebro[] } | { readonly disponible: false };

export async function listarProspectos(db: TenantDbSession, callerId: string): Promise<ListaProspectos> {
  return runWithSavepointFallback<ListaProspectos>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<ProspectoCerebroRow>("select * from core.list_prospectos_cerebro_for_superadmin($1);", [callerId]);
      return { disponible: true as const, prospectos: rows.map(mapProspectoCerebro) };
    },
    isRecoverable: esCerebroNoMigrado,
    fallback: async () => {
      avisarCerebroNoMigrado("list_prospectos_cerebro_for_superadmin");
      return { disponible: false as const };
    },
  });
}

// ---- Personas y eventos ----

export interface PersonaContacto {
  readonly id: string;
  readonly nombre: string;
  readonly cargo: string | null;
  readonly canal: string;
  readonly dato: string | null;
  readonly origen: string;
  readonly confianza: string;
  readonly evidenciaUrl: string;
  readonly creadoEn: string;
}
export interface EventoProspecto {
  readonly id: string;
  readonly tipo: string;
  readonly actorId: string | null;
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly costoMicroUsd: number | null;
  readonly creadoEn: string;
}

interface PersonaRow {
  id: string;
  nombre: string;
  cargo: string | null;
  canal: string;
  dato: string | null;
  origen: string;
  confianza: string;
  evidencia_url: string;
  creado_en: string | Date;
}
interface EventoRow {
  id: string;
  tipo: string;
  actor_id: string | null;
  detalle: Record<string, unknown>;
  costo_micro_usd: number | string | null;
  creado_en: string | Date;
}

const mapPersona = (r: PersonaRow): PersonaContacto => ({ id: r.id, nombre: r.nombre, cargo: r.cargo, canal: r.canal, dato: r.dato, origen: r.origen, confianza: r.confianza, evidenciaUrl: r.evidencia_url, creadoEn: iso(r.creado_en) });
const mapEvento = (r: EventoRow): EventoProspecto => ({ id: r.id, tipo: r.tipo, actorId: r.actor_id, detalle: r.detalle, costoMicroUsd: numONull(r.costo_micro_usd), creadoEn: iso(r.creado_en) });

export type DetalleProspecto = { readonly disponible: true; readonly personas: readonly PersonaContacto[]; readonly eventos: readonly EventoProspecto[] } | { readonly disponible: false };

export async function detalleProspecto(db: TenantDbSession, callerId: string, prospectoId: string): Promise<DetalleProspecto> {
  return runWithSavepointFallback<DetalleProspecto>({
    session: db,
    primary: async () => {
      const personas = await db.query<PersonaRow>("select * from core.list_prospecto_personas_for_superadmin($1, $2);", [callerId, prospectoId]);
      const eventos = await db.query<EventoRow>("select * from core.list_prospecto_eventos_for_superadmin($1, $2, 50);", [callerId, prospectoId]);
      return { disponible: true as const, personas: personas.rows.map(mapPersona), eventos: eventos.rows.map(mapEvento) };
    },
    isRecoverable: esCerebroNoMigrado,
    fallback: async () => {
      avisarCerebroNoMigrado("list_prospecto_personas_for_superadmin");
      return { disponible: false as const };
    },
  });
}

async function contarPersonas(db: TenantDbSession, callerId: string, prospectoId: string): Promise<number> {
  const { rows } = await db.query<PersonaRow>("select * from core.list_prospecto_personas_for_superadmin($1, $2);", [callerId, prospectoId]);
  return rows.length;
}

// ---- Guardado con scoring ----

export interface ScorePersistible {
  readonly ajuste: number | null;
  readonly urgencia: number | null;
  readonly cierre: number | null;
  readonly completitud: number;
  readonly explicacion: unknown;
  readonly version: string;
}

function aScorePersistible(r: ResultadoScore): ScorePersistible {
  return { ajuste: r.ajuste, urgencia: r.urgencia, cierre: r.cierre, completitud: r.completitud, explicacion: r.explicacion, version: r.version };
}

/**
 * Recalcula y guarda el score de un prospecto ya persistido (despues de crear, editar o agregar una persona).
 * Una sola transaccion con el guardado: o quedan datos y score, o ninguno.
 */
async function recalcularYGuardar(db: TenantDbSession, callerId: string, prospecto: ProspectoCerebro, ahora: Date): Promise<ProspectoCerebro> {
  const tax = await listarTaxonomia(db, callerId);
  const versiones: readonly TaxonomiaVersion[] = tax.disponible ? tax.versiones : [];
  const taxonomia = toScoringTaxonomia(vigentesPorVertical(versiones).get(prospecto.vertical));
  const personas = await contarPersonas(db, callerId, prospecto.id);
  const score = calcularScore(aProspectoScoring(prospecto, personas), taxonomia, ahora);
  const { rows } = await db.query<ProspectoCerebroRow>("select * from core.save_prospecto_cerebro_for_superadmin($1, $2, '{}'::jsonb, $3::jsonb);", [callerId, prospecto.id, JSON.stringify(aScorePersistible(score))]);
  const row = rows[0];
  if (!row) throw new Error("save_prospecto_cerebro_for_superadmin no devolvió ninguna fila.");
  return mapProspectoCerebro(row);
}

export type ResultadoGuardarProspecto = { readonly estado: "guardado"; readonly prospecto: ProspectoCerebro } | { readonly estado: "no_migrada" } | { readonly estado: "no_existe" };

/** `datos`: objeto con claves snake_case de la lista blanca de la funcion SQL (ver `validarDatosProspecto`). */
export async function guardarProspecto(db: TenantDbSession, callerId: string, prospectoId: string | null, datos: Record<string, unknown>, ahora: Date): Promise<ResultadoGuardarProspecto> {
  return runWithSavepointFallback<ResultadoGuardarProspecto>({
    session: db,
    primary: async () => {
      // Un P0002 (prospecto inexistente) deja la transaccion abortada: lo resuelve `isRecoverable`/`fallback` con
      // ROLLBACK TO SAVEPOINT, nunca un try/catch aqui dentro.
      const r = await db.query<ProspectoCerebroRow>("select * from core.save_prospecto_cerebro_for_superadmin($1, $2, $3::jsonb, null);", [callerId, prospectoId, JSON.stringify(datos)]);
      const guardado = r.rows[0];
      if (!guardado) throw new Error("save_prospecto_cerebro_for_superadmin no devolvió ninguna fila.");
      const conScore = await recalcularYGuardar(db, callerId, mapProspectoCerebro(guardado), ahora);
      return { estado: "guardado" as const, prospecto: conScore };
    },
    isRecoverable: (err) => esCerebroNoMigrado(err) || (err as { code?: string } | null)?.code === "P0002",
    fallback: async (err) => {
      if ((err as { code?: string } | null)?.code === "P0002") return { estado: "no_existe" as const };
      avisarCerebroNoMigrado("save_prospecto_cerebro_for_superadmin");
      return { estado: "no_migrada" as const };
    },
  });
}

export interface EntradaPersona {
  readonly nombre: string;
  readonly cargo: string | null;
  readonly canal: string;
  readonly dato: string | null;
  readonly origen: string;
  readonly confianza: string;
  readonly evidenciaUrl: string;
}

export type ResultadoAgregarPersona =
  | { readonly estado: "agregada"; readonly persona: PersonaContacto; readonly prospecto: ProspectoCerebro }
  | { readonly estado: "no_migrada" }
  | { readonly estado: "no_existe" };

export async function agregarPersona(db: TenantDbSession, callerId: string, prospectoId: string, p: EntradaPersona, ahora: Date): Promise<ResultadoAgregarPersona> {
  return runWithSavepointFallback<ResultadoAgregarPersona>({
    session: db,
    primary: async () => {
      const r = await db.query<PersonaRow>("select * from core.add_prospecto_persona_for_superadmin($1, $2, $3, $4, $5, $6, $7, $8, $9);", [callerId, prospectoId, p.nombre, p.cargo, p.canal, p.dato, p.origen, p.confianza, p.evidenciaUrl]);
      const fila = r.rows[0];
      if (!fila) throw new Error("add_prospecto_persona_for_superadmin no devolvió ninguna fila.");
      // La persona suma a completitud y a cierre: se recalcula el score con el prospecto actual.
      const lista = await db.query<ProspectoCerebroRow>("select * from core.list_prospectos_cerebro_for_superadmin($1);", [callerId]);
      const actual = lista.rows.find((x) => x.id === prospectoId);
      if (!actual) throw new Error("El prospecto desapareció durante la operación.");
      const prospecto = await recalcularYGuardar(db, callerId, mapProspectoCerebro(actual), ahora);
      return { estado: "agregada" as const, persona: mapPersona(fila), prospecto };
    },
    isRecoverable: (err) => esCerebroNoMigrado(err) || (err as { code?: string } | null)?.code === "P0002",
    fallback: async (err) => {
      if ((err as { code?: string } | null)?.code === "P0002") return { estado: "no_existe" as const };
      avisarCerebroNoMigrado("add_prospecto_persona_for_superadmin");
      return { estado: "no_migrada" as const };
    },
  });
}

// ---- Validacion de la entrada del formulario ----

type Validado<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string; readonly codigo?: string };

const URL_RE = /^https?:\/\/[^\s]{4,}$/iu;
const CORREO_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_RE = /^[a-z0-9][a-z0-9_]{1,59}$/u;
const MAX_SENALES = 30;

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto opcional: `undefined` = clave ausente (no se toca); `null` = limpiar; string = valor (recortado). */
function textoOpcional(raw: Record<string, unknown>, clave: string, max: number, etiqueta: string): Validado<string | null | undefined> {
  if (!(clave in raw)) return { ok: true, valor: undefined };
  const v = raw[clave];
  if (v === null) return { ok: true, valor: null };
  if (typeof v !== "string") return { ok: false, error: `${etiqueta} debe ser texto.` };
  const t = v.trim();
  if (t.length === 0) return { ok: true, valor: null };
  if (t.length > max) return { ok: false, error: `${etiqueta} admite hasta ${max} caracteres.` };
  return { ok: true, valor: t };
}

function fechaValida(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && !Number.isNaN(Date.parse(v));
}

export interface TaxonomiaParaValidar {
  readonly subtipos: readonly string[];
  readonly rangos: readonly string[];
}

/**
 * Valida el cuerpo del formulario y lo traduce a la lista blanca de la funcion SQL (claves snake_case). Solo las claves
 * presentes viajan: una ausente conserva el valor actual y `null` lo limpia. `esAlta` exige empresa y vertical.
 * Reglas de negocio con mensaje propio: base de licitud obligatoria con datos de contacto, consentimiento para
 * "interes declarado" y "referido con consentimiento", subtipo y tamano dentro de la taxonomia vigente.
 */
export function validarDatosProspecto(raw: unknown, esAlta: boolean, taxonomia: TaxonomiaParaValidar | null): Validado<Record<string, unknown>> {
  if (!esObjeto(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const out: Record<string, unknown> = {};
  const poner = (clave: string, v: Validado<unknown>): string | null => {
    if (!v.ok) return v.error;
    if (v.valor !== undefined) out[clave] = v.valor;
    return null;
  };

  if (esAlta || "empresa" in raw) {
    const e = typeof raw.empresa === "string" ? raw.empresa.trim() : "";
    if (e.length === 0 || e.length > 200) return { ok: false, error: "La empresa es obligatoria (hasta 200 caracteres)." };
    out.empresa = e;
  }
  if (esAlta || "vertical" in raw) {
    if (typeof raw.vertical !== "string" || !(VERTICALES as readonly string[]).includes(raw.vertical)) return { ok: false, error: "vertical inválida o ausente." };
    out.vertical = raw.vertical;
  }

  const textos: Array<[string, string, number, string]> = [
    ["ciudad", "ciudad", 120, "La ciudad"],
    ["contactoNombre", "contacto_nombre", 200, "El nombre de contacto"],
    ["telefono", "telefono", 40, "El teléfono"],
    ["fuente", "fuente", 200, "La fuente"],
    ["notas", "notas", 4000, "Las notas"],
    ["subtipo", "subtipo", 60, "El subtipo"],
    ["tamano", "tamano", 40, "El tamaño"],
    ["entidad", "entidad", 120, "La entidad"],
    ["municipio", "municipio", 120, "El municipio"],
    ["zona", "zona", 120, "La zona"],
    ["siguientePaso", "siguiente_paso", 500, "El siguiente paso"],
  ];
  for (const [clave, columna, max, etiqueta] of textos) {
    const err = poner(columna, textoOpcional(raw, clave, max, etiqueta));
    if (err) return { ok: false, error: err };
  }

  // Correo, sitio web y fechas con formato propio.
  if ("correo" in raw) {
    const v = textoOpcional(raw, "correo", 254, "El correo");
    if (!v.ok) return v;
    if (v.valor && !CORREO_RE.test(v.valor)) return { ok: false, error: "El correo no tiene un formato válido." };
    out.correo = v.valor;
  }
  if ("sitioWeb" in raw) {
    const v = textoOpcional(raw, "sitioWeb", 300, "El sitio web");
    if (!v.ok) return v;
    if (v.valor && !URL_RE.test(v.valor)) return { ok: false, error: "El sitio web debe empezar con http:// o https://." };
    out.sitio_web = v.valor;
  }
  for (const [clave, columna, etiqueta] of [["consentimientoEn", "consentimiento_en", "La fecha de consentimiento"], ["siguientePasoEn", "siguiente_paso_en", "La fecha del siguiente paso"]] as const) {
    if (!(clave in raw)) continue;
    const v = raw[clave];
    if (v === null || v === "") out[columna] = null;
    else if (fechaValida(v)) out[columna] = v;
    else return { ok: false, error: `${etiqueta} no es una fecha válida.` };
  }

  if ("sitioVerificado" in raw) {
    if (typeof raw.sitioVerificado !== "boolean") return { ok: false, error: "sitioVerificado debe ser verdadero o falso." };
    out.sitio_verificado = raw.sitioVerificado;
  }

  if ("lat" in raw || "lng" in raw) {
    const lat = raw.lat ?? null;
    const lng = raw.lng ?? null;
    if ((lat === null) !== (lng === null)) return { ok: false, error: "Latitud y longitud van juntas." };
    if (lat !== null) {
      if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: "Latitud (-90 a 90) y longitud (-180 a 180) inválidas." };
    }
    out.lat = lat;
    out.lng = lng;
  }

  if ("baseLicitud" in raw) {
    const b = raw.baseLicitud;
    if (b === null || b === "") out.base_licitud = null;
    else if (typeof b === "string" && (BASES_LICITUD as readonly string[]).includes(b)) out.base_licitud = b;
    else return { ok: false, error: "La base de licitud no es válida." };
  }

  if ("redes" in raw) {
    const r = raw.redes;
    if (r === null) out.redes = {};
    else if (esObjeto(r)) {
      const claves = Object.keys(r);
      if (claves.length > 8) return { ok: false, error: "Redes admite hasta 8 entradas." };
      const limpio: Record<string, string> = {};
      for (const k of claves) {
        const v = r[k];
        if (!SLUG_RE.test(k) || typeof v !== "string" || !URL_RE.test(v.trim()) || v.length > 300) return { ok: false, error: "Cada red necesita un nombre (minúsculas) y una URL http(s)." };
        limpio[k] = v.trim();
      }
      out.redes = limpio;
    } else return { ok: false, error: "Redes debe ser un objeto." };
  }

  if ("senales" in raw) {
    const s = raw.senales;
    if (!Array.isArray(s) || s.length > MAX_SENALES) return { ok: false, error: `Las señales deben ser una lista de hasta ${MAX_SENALES}.` };
    const lista: Array<Record<string, unknown>> = [];
    for (const x of s) {
      const tipo = esObjeto(x) && typeof x.tipo === "string" ? x.tipo.trim() : "";
      const fuente = esObjeto(x) && typeof x.fuente === "string" ? x.fuente.trim() : "";
      const valor = esObjeto(x) && typeof x.valor === "string" && x.valor.trim() ? x.valor.trim() : null;
      const url = esObjeto(x) && typeof x.url === "string" && x.url.trim() ? x.url.trim() : null;
      const observadoEn = esObjeto(x) ? x.observadoEn : undefined;
      if (!SLUG_RE.test(tipo) || fuente.length === 0 || fuente.length > 200 || !fechaValida(observadoEn)) {
        return { ok: false, error: "Cada señal necesita tipo, fuente y fecha de observación válidos." };
      }
      if ((valor?.length ?? 0) > 300) return { ok: false, error: "El valor de una señal admite hasta 300 caracteres." };
      if (url !== null && (!URL_RE.test(url) || url.length > 500)) return { ok: false, error: "La URL de una señal debe empezar con http:// o https://." };
      lista.push({ tipo, valor, fuente, url, observado_en: observadoEn });
    }
    out.senales = lista;
  }

  for (const [clave, columna] of [["duplicadoDe", "duplicado_de"], ["vendedorId", "vendedor_id"]] as const) {
    if (!(clave in raw)) continue;
    const v = raw[clave];
    if (v === null || v === "") out[columna] = null;
    else if (typeof v === "string" && UUID_RE.test(v)) out[columna] = v;
    else return { ok: false, error: `${clave} debe ser un identificador válido.` };
  }

  if (taxonomia) {
    const sub = out.subtipo;
    if (typeof sub === "string" && !taxonomia.subtipos.includes(sub)) return { ok: false, error: `El subtipo "${sub}" no existe en la taxonomía vigente de la vertical.` };
    const tam = out.tamano;
    if (typeof tam === "string" && !taxonomia.rangos.includes(tam)) return { ok: false, error: `El tamaño "${tam}" no existe en la taxonomía vigente de la vertical.` };
  }

  const base = out.base_licitud;
  if ((base === "interes_declarado" || base === "referido_con_consentimiento") && !out.consentimiento_en) {
    return { ok: false, error: "Esta base de licitud exige la fecha de consentimiento." };
  }
  if (esAlta) {
    const hayContacto = Boolean(out.telefono) || Boolean(out.correo) || Boolean(out.contacto_nombre);
    if (hayContacto && !out.base_licitud) {
      return { ok: false, error: "La base de licitud es obligatoria para guardar datos de contacto.", codigo: "base_licitud_requerida" };
    }
  }
  return { ok: true, valor: out };
}

export function validarPersona(raw: unknown): Validado<EntradaPersona> {
  if (!esObjeto(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const nombre = typeof raw.nombre === "string" ? raw.nombre.trim() : "";
  if (nombre.length < 2 || nombre.length > 120) return { ok: false, error: "El nombre de la persona es obligatorio (2 a 120 caracteres)." };
  const cargo = typeof raw.cargo === "string" && raw.cargo.trim() ? raw.cargo.trim() : null;
  if ((cargo?.length ?? 0) > 120) return { ok: false, error: "El cargo admite hasta 120 caracteres." };
  if (typeof raw.canal !== "string" || !(CANALES_PERSONA as readonly string[]).includes(raw.canal)) return { ok: false, error: "El canal no es válido." };
  const dato = typeof raw.dato === "string" && raw.dato.trim() ? raw.dato.trim() : null;
  if ((dato?.length ?? 0) > 254) return { ok: false, error: "El dato de contacto admite hasta 254 caracteres." };
  if (raw.canal === "correo" && dato !== null && !CORREO_RE.test(dato)) return { ok: false, error: "El correo no tiene un formato válido." };
  if (typeof raw.origen !== "string" || !(ORIGENES_PERSONA as readonly string[]).includes(raw.origen)) {
    return { ok: false, error: "El origen no es válido: solo se aceptan datos con un origen verificable (nunca un correo armado por patrón).", codigo: "origen_invalido" };
  }
  if (typeof raw.confianza !== "string" || !(CONFIANZAS_PERSONA as readonly string[]).includes(raw.confianza)) return { ok: false, error: "La confianza debe ser alta, media o baja." };
  const evidencia = typeof raw.evidenciaUrl === "string" ? raw.evidenciaUrl.trim() : "";
  if (!URL_RE.test(evidencia) || evidencia.length > 500) {
    return { ok: false, error: "La evidencia es obligatoria: indica la URL (http o https) donde viste este dato.", codigo: "evidencia_requerida" };
  }
  return { ok: true, valor: { nombre, cargo, canal: raw.canal, dato, origen: raw.origen, confianza: raw.confianza, evidenciaUrl: evidencia } };
}
