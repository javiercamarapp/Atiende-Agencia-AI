// Contrato por cliente (SA-43, superadmin "CFO"): alta, enmienda (version nueva inmutable), historial y
// facturacion ESTIMADA del mes. Ver packages/db/migrations/0037_superadmin_contrato_cliente.sql,
// packages/billing/src/contrato.ts y docs/SUPERADMIN_CONTRATOS.md.
//
// Autenticacion, gateo de superadmin, corte por rol `finanzas` (solo lectura, ver zona-cfo.ts) y step-up corren
// ANTES (montados una vez en routes/superadmin.ts sobre `/superadmin/*`). Alta y enmienda son sensibles (step-up).
// Aqui la autoridad real sigue estando en SQL: caller-binding, superadmin real y no-restringido.
//
// Esta ruta NO cobra, NO emite factura y NO envia nada: la estimacion es una lectura. Dinero SIEMPRE en
// centavos MXN enteros (JSON de enteros: ningun flotante cruza la API); la pantalla formatea.
//
// Base sin migrar (0037 sin aplicar): lecturas `disponible: false` con mensaje honesto (200); alta y enmienda 503;
// nunca un 500.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { ContratoInvalidoError, diasDelMes, estimarFacturacionMes, validarTerminos } from "@atiende/billing";
import type { VersionContrato } from "@atiende/billing";
import type { ContratoVersionRow, TerminosContratoInput } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

export const CONTRATOS_NO_DISPONIBLE = "El contrato por cliente todavía no está disponible en este despliegue (falta aplicar la migración 0037_superadmin_contrato_cliente).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const LIMITE_DEFAULT = 200;
const LIMITE_MAX = 500;

function serializarVersion(v: ContratoVersionRow) {
  return {
    id: v.id,
    contractId: v.contractId,
    organizationId: v.organizationId,
    organizacion: v.organizationName,
    version: v.version,
    vigenteDesde: v.vigenteDesde,
    vigenteHasta: v.vigenteHasta,
    moneda: v.moneda,
    baseCentavos: v.baseCentavos,
    porSucursalCentavos: v.porSucursalCentavos,
    sucursalesIncluidas: v.sucursalesIncluidas,
    bolsaMinutos: v.bolsaMinutos,
    excedenteCentavosMinuto: v.excedenteCentavosMinuto,
    instalacionCentavos: v.instalacionCentavos,
    descuentoBp: v.descuentoBp,
    descuentoFijoCentavos: v.descuentoFijoCentavos,
    motivo: v.motivo,
    creadoPor: v.creadoPor,
    creadoPorCorreo: v.creadoPorCorreo,
    creadoEnMs: v.creadoEnMs,
  };
}

function aVersionContrato(v: ContratoVersionRow): VersionContrato {
  return {
    contractId: v.contractId,
    version: v.version,
    vigenteDesde: v.vigenteDesde,
    vigenteHasta: v.vigenteHasta,
    baseCentavos: v.baseCentavos,
    porSucursalCentavos: v.porSucursalCentavos,
    sucursalesIncluidas: v.sucursalesIncluidas,
    bolsaMinutos: v.bolsaMinutos,
    excedenteCentavosMinuto: v.excedenteCentavosMinuto,
    instalacionCentavos: v.instalacionCentavos,
    descuentoBp: v.descuentoBp,
    descuentoFijoCentavos: v.descuentoFijoCentavos,
  };
}

function entero(raw: Record<string, unknown>, campo: string, porDefecto?: number): number {
  const v = raw[campo];
  if (v === undefined && porDefecto !== undefined) return porDefecto;
  if (typeof v !== "number" || !Number.isInteger(v)) throw Errors.validation(`${campo} debe ser un entero (centavos MXN, minutos o puntos base; nunca decimales).`);
  return v;
}

/** Valida el cuerpo de alta/enmienda con las mismas reglas que la base (`validarTerminos`) y lo normaliza. */
export function parsearTerminos(raw: Record<string, unknown>): TerminosContratoInput {
  if (raw.moneda !== undefined && raw.moneda !== "MXN") throw Errors.validation("moneda debe ser MXN.");
  const vigenteDesde = typeof raw.vigenteDesde === "string" ? raw.vigenteDesde : "";
  if (raw.vigenteHasta !== undefined && raw.vigenteHasta !== null && typeof raw.vigenteHasta !== "string") throw Errors.validation("vigenteHasta debe ser una fecha YYYY-MM-DD o null.");
  const vigenteHasta = typeof raw.vigenteHasta === "string" ? raw.vigenteHasta : null;
  const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
  if (motivo.length < 20 || motivo.length > 500) throw Errors.validation("motivo es obligatorio (20 a 500 caracteres).");
  const terminos: TerminosContratoInput = {
    vigenteDesde,
    vigenteHasta,
    baseCentavos: entero(raw, "baseCentavos"),
    porSucursalCentavos: entero(raw, "porSucursalCentavos"),
    sucursalesIncluidas: entero(raw, "sucursalesIncluidas"),
    bolsaMinutos: entero(raw, "bolsaMinutos"),
    excedenteCentavosMinuto: entero(raw, "excedenteCentavosMinuto"),
    instalacionCentavos: entero(raw, "instalacionCentavos", 0),
    descuentoBp: entero(raw, "descuentoBp", 0),
    descuentoFijoCentavos: entero(raw, "descuentoFijoCentavos", 0),
    motivo,
  };
  try {
    validarTerminos(terminos);
  } catch (err) {
    if (err instanceof ContratoInvalidoError) throw Errors.validation(err.message);
    throw err;
  }
  return terminos;
}

/** Mes en curso `YYYY-MM` en hora de Mexico (UTC-6 fijo desde 2022). */
function mesActualMx(): string {
  return new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 7);
}

export function superadminContratosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string): Promise<void> {
    const allowed = await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de contrato en poco tiempo.");
  }

  // Historial de versiones (de una organizacion, o de todas), la mas reciente primero.
  app.get("/superadmin/contratos", async (c) => {
    const organizationId = c.req.query("organizationId") ?? null;
    if (organizationId !== null && !UUID_RE.test(organizationId)) throw Errors.validation("organizationId debe ser un UUID válido.");
    const limiteRaw = c.req.query("limite");
    let limite = LIMITE_DEFAULT;
    if (limiteRaw !== undefined && limiteRaw !== "") {
      if (!/^\d{1,4}$/u.test(limiteRaw) || Number(limiteRaw) < 1) throw Errors.validation("limite debe ser un entero >= 1.");
      limite = Math.min(LIMITE_MAX, Number(limiteRaw));
    }
    if (!deps.contratosRepo) return c.json({ disponible: false, mensaje: CONTRATOS_NO_DISPONIBLE, versiones: [] });
    const repo = deps.contratosRepo;
    const callerId = c.get("userId");
    const { availability, versions } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listVersions(callerId, organizationId, limite));
    if (availability === "not_migrated") return c.json({ disponible: false, mensaje: CONTRATOS_NO_DISPONIBLE, versiones: [] });
    return c.json({ disponible: true, versiones: versions.map(serializarVersion) });
  });

  // Facturacion ESTIMADA del mes (lectura): contrato + sucursales activas + minutos de voz medidos. No cobra nada.
  app.get("/superadmin/contratos/estimacion", async (c) => {
    const organizationId = c.req.query("organizationId") ?? "";
    if (!UUID_RE.test(organizationId)) throw Errors.validation("organizationId debe ser un UUID válido.");
    const mesRaw = c.req.query("mes");
    const mes = mesRaw === undefined || mesRaw === "" ? mesActualMx() : mesRaw;
    if (!MES_RE.test(mes)) throw Errors.validation("mes debe tener el formato YYYY-MM.");
    if (!deps.contratosRepo) return c.json({ disponible: false, mensaje: CONTRATOS_NO_DISPONIBLE, mes, estimacion: null });
    const repo = deps.contratosRepo;
    const callerId = c.get("userId");
    // Las dos lecturas comparten UNA transaccion; cada una corre bajo su propio SAVEPOINT en el repositorio.
    const { versiones, insumos } = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = repo(db);
      const v = await r.listVersions(callerId, organizationId, LIMITE_MAX);
      if (v.availability === "not_migrated") return { versiones: null, insumos: null };
      const i = await r.getBillingInputs(callerId, organizationId, mes);
      return { versiones: v.versions, insumos: i.availability === "not_migrated" ? null : i.inputs };
    });
    if (versiones === null) return c.json({ disponible: false, mensaje: CONTRATOS_NO_DISPONIBLE, mes, estimacion: null });
    if (insumos === null) throw Errors.notFound("La organización no existe.");

    // Con 0 eventos de voz los minutos NO estan medidos: se declara, no se inventa un cero.
    const minutosVoz = insumos.eventosVoz > 0 ? insumos.minutosVoz : null;
    const base = { disponible: true, mes, diasDelMes: diasDelMes(mes), organizationId, insumos: { sucursalesActivas: insumos.sucursalesActivas, minutosVoz, eventosVoz: insumos.eventosVoz } };
    try {
      const estimacion = estimarFacturacionMes({ mes, versiones: versiones.map(aVersionContrato), sucursalesActivas: insumos.sucursalesActivas, minutosVoz });
      return c.json({ ...base, estimacion });
    } catch (err) {
      if (err instanceof ContratoInvalidoError) return c.json({ ...base, estimacion: null, inconsistente: err.message });
      throw err;
    }
  });

  // Sensible (step-up). Alta: version 1 de un contrato nuevo.
  app.post("/superadmin/contratos", async (c) => {
    if (!deps.contratosRepo) throw Errors.serviceUnavailable(CONTRATOS_NO_DISPONIBLE);
    const repo = deps.contratosRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "contratos-alta");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    if (!UUID_RE.test(organizationId)) throw Errors.validation("organizationId debe ser un UUID válido.");
    const terminos = parsearTerminos(raw);
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).createContract(callerId, organizationId, terminos));
      if (r.availability === "not_migrated" || !r.contractId) throw Errors.serviceUnavailable(CONTRATOS_NO_DISPONIBLE);
      return c.json({ ok: true, contractId: r.contractId, version: 1 }, 201);
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  // Sensible (step-up). Enmienda: version n+1 del mismo contrato; la anterior queda intacta.
  app.post("/superadmin/contratos/:contractId/enmiendas", async (c) => {
    if (!deps.contratosRepo) throw Errors.serviceUnavailable(CONTRATOS_NO_DISPONIBLE);
    const repo = deps.contratosRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "contratos-enmienda");
    const contractId = c.req.param("contractId");
    if (!UUID_RE.test(contractId)) throw Errors.validation("contractId debe ser un UUID válido.");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const terminos = parsearTerminos(raw);
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).amendContract(callerId, contractId, terminos));
      if (r.availability === "not_migrated" || r.version === null) throw Errors.serviceUnavailable(CONTRATOS_NO_DISPONIBLE);
      return c.json({ ok: true, contractId, version: r.version }, 201);
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
