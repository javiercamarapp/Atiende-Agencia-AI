// Contabilidad electrónica SAT (Anexo 24) — cierre de gap de auditoría: el
// motor completo de `@atiende/domain-despachos/contabilidad-electronica/`
// (catálogo de cuentas XML, balanza de comprobación XML, paquete completo con
// hash SHA-1, transición de estado) ya existía con tests, pero NINGUNA ruta
// HTTP lo exponía — obligación fiscal MENSUAL real de un despacho, que la
// plantilla de cierre mensual ya lista como categoría "electronica"
// (cierre-mensual/templates.ts, tarea "contabilidad_elect") sin poder
// generarla desde el producto.
//
// Endpoint puro/calculadora, mismo criterio que devolucion-iva.ts/
// bookkeeping.ts/conciliacion.ts: el motor de dominio es funcional y sin I/O
// (ver cabecera de contabilidad-electronica/paquete.ts) y este paquete NO
// persiste ningún "paquete de contabilidad electrónica" en una tabla nueva —
// el cliente HTTP manda el catálogo (o usa el default SAT) y los asientos
// contables ya conocidos (mismo patrón que /bookkeeping/ajuste, que tampoco
// tiene una tabla de "pólizas" real todavía) y recibe el XML/hash/estado ya
// calculados. Persistir el paquete/`package_id` queda fuera de alcance de
// esta fase (mismo criterio documentado en la cabecera de paquete.ts: "a
// cargo de un repositorio de más arriba").
//
// `ejercicio`/`mes`/`generadoEn`/`fechaModificacion*` son OBLIGATORIOS en el
// motor de dominio a propósito (ver DESVIACIÓN 1 en paquete.ts: el original
// lee el reloj de sistema dentro del motor, este puerto no). Esta ruta ES esa
// "capa con I/O" que decide el default cuando el cliente no lo manda
// explícito: año actual, mes 1, y el timestamp del servidor al momento de la
// llamada — igual que el propio comentario de dominio anticipa.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CONTABILIDAD_ELECTRONICA_ROLES,
  VER_CONTABILIDAD_ELECTRONICA_ROLES,
  CATALOGO_ANEXO24_BASE,
  crearCatalogoBase,
  generarXmlCatalogo,
  generarBalanza,
  generarXmlBalanza,
  calcularHashSha1,
  generarPaqueteContabilidadElectronica,
  marcarListoParaTimbrar,
  TransicionPaqueteContabilidadInvalidaError,
} from "@atiende/domain-despachos";
import type { AsientoContable, CuentaAnexo24, EstadoPaqueteContabilidad, NaturalezaCuentaAnexo24, TipoEnvioBalanza } from "@atiende/domain-despachos";
import { ESTADOS_PAQUETE_CONTABILIDAD } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const NATURALEZAS_VALIDAS = new Set<NaturalezaCuentaAnexo24>(["D", "A"]);
const TIPOS_ENVIO_BALANZA_VALIDOS = new Set<TipoEnvioBalanza>(["B", "C"]);
const ESTADOS_VALIDOS = new Set<EstadoPaqueteContabilidad>(ESTADOS_PAQUETE_CONTABILIDAD);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Timestamp por defecto para `fechaModificacion`/`generadoEn` cuando el
 * cliente no lo manda — "YYYY-MM-DDTHH:MM:SS" (sin milisegundos ni "Z"),
 * mismo formato de ejemplo que documentan las opciones del motor. */
function nowIsoSeconds(): string {
  return new Date().toISOString().slice(0, 19);
}

interface CuentaBody {
  readonly codigo?: unknown;
  readonly descripcion?: unknown;
  readonly nivel?: unknown;
  readonly naturaleza?: unknown;
  readonly grupo?: unknown;
}

function parseCuenta(raw: unknown, idx: number): CuentaAnexo24 {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`catalogo[${idx}]: se esperaba un objeto.`);
  const c = raw as CuentaBody;
  const naturaleza = typeof c.naturaleza === "string" ? (c.naturaleza.toUpperCase() as NaturalezaCuentaAnexo24) : undefined;
  if (!naturaleza || !NATURALEZAS_VALIDAS.has(naturaleza)) throw Errors.validation(`catalogo[${idx}].naturaleza: se esperaba "D" o "A".`);
  return {
    codigo: requireString(c.codigo, `catalogo[${idx}].codigo`),
    descripcion: requireString(c.descripcion, `catalogo[${idx}].descripcion`),
    nivel: optionalNumber(c.nivel, `catalogo[${idx}].nivel`, 3),
    naturaleza,
    grupo: typeof c.grupo === "string" ? c.grupo : "",
  };
}

/** El catálogo es opcional en el body: por defecto, el catálogo Anexo 24 base
 * del SAT (mismo default que usaría un despacho que no ha migrado/ajustado su
 * propio catálogo — ver GET /catalogo-base de abajo, que expone este mismo
 * default para que la UI lo muestre antes de generar). */
function parseCatalogo(raw: unknown): readonly CuentaAnexo24[] {
  if (raw === undefined) return crearCatalogoBase();
  if (!Array.isArray(raw)) throw Errors.validation("catalogo: se esperaba un arreglo.");
  if (raw.length === 0) throw Errors.validation("catalogo: no puede estar vacío.");
  return raw.map(parseCuenta);
}

interface AsientoBody {
  readonly cuenta?: unknown;
  readonly debe?: unknown;
  readonly haber?: unknown;
  readonly fecha?: unknown;
}

function parseAsiento(raw: unknown, idx: number): AsientoContable {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`asientos[${idx}]: se esperaba un objeto.`);
  const a = raw as AsientoBody;
  const debe = a.debe === undefined || a.debe === null ? undefined : a.debe;
  const haber = a.haber === undefined || a.haber === null ? undefined : a.haber;
  if (debe !== undefined && typeof debe !== "number" && typeof debe !== "string") throw Errors.validation(`asientos[${idx}].debe: se esperaba un número.`);
  if (haber !== undefined && typeof haber !== "number" && typeof haber !== "string") throw Errors.validation(`asientos[${idx}].haber: se esperaba un número.`);
  return {
    cuenta: requireString(a.cuenta, `asientos[${idx}].cuenta`),
    debe: debe as number | string | undefined,
    haber: haber as number | string | undefined,
    fecha: typeof a.fecha === "string" ? a.fecha : null,
  };
}

function parseAsientos(raw: unknown): readonly AsientoContable[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("asientos: se esperaba un arreglo.");
  return raw.map(parseAsiento);
}

function parseSaldosIniciales(raw: unknown): Record<string, number | string> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("saldosIniciales: se esperaba un objeto {cuenta: monto}.");
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "number" && typeof v !== "string") throw Errors.validation(`saldosIniciales.${k}: se esperaba un número.`);
    out[k] = v;
  }
  return out;
}

/** `ejercicio` default: año actual del servidor (ver cabecera de este
 * archivo — el motor de dominio deliberadamente no lee el reloj de sistema,
 * esta ruta sí lo hace por él cuando el cliente no lo especifica, mismo
 * criterio documentado en la DESVIACIÓN 1 de `paquete.ts`). */
function parseEjercicio(raw: unknown): number {
  if (raw === undefined || raw === null) return new Date().getFullYear();
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw Errors.validation("ejercicio: se esperaba un número.");
  return raw;
}

function parseMes(raw: unknown): number {
  const mes = optionalNumber(raw, "mes", 1);
  if (mes < 1 || mes > 12) throw Errors.validation("mes: se esperaba 1-12.");
  return mes;
}

export function despachosContabilidadElectronicaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/contabilidad-electronica/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Catálogo Anexo 24 base del SAT — para que la UI lo muestre/edite antes
   * de generar el XML (mismo rol que GET /bookkeeping/catalogo).
   *
   * Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
   * ninguna ruta lo usa realmente"): es referencia fija (sin datos del cliente) --
   * auditor/readonly SÍ pueden verla (VER_CONTABILIDAD_ELECTRONICA_ROLES), aunque
   * nunca generar el paquete (CONTABILIDAD_ELECTRONICA_ROLES, sin cambios, en el
   * resto de rutas de este archivo). */
  app.get("/despachos/:propertyId/contabilidad-electronica/catalogo-base", async (c) => {
    assertVerticalRole(c, VER_CONTABILIDAD_ELECTRONICA_ROLES);
    return c.json({ catalogo: CATALOGO_ANEXO24_BASE });
  });

  /** Genera el XML del catálogo de cuentas Anexo 24 (`CatalogoCuentas_1_3.xsd`)
   * + su hash SHA-1 (checksum exigido por el SAT junto al XML, ver
   * `calcularHashSha1`). */
  app.post("/despachos/:propertyId/contabilidad-electronica/catalogo", async (c) => {
    assertVerticalRole(c, CONTABILIDAD_ELECTRONICA_ROLES);
    const raw = await readJsonCapped<{ readonly catalogo?: unknown; readonly rfc?: unknown; readonly ejercicio?: unknown; readonly mes?: unknown; readonly fechaModificacion?: unknown }>(c.req.raw, 512 * 1024);
    const catalogo = parseCatalogo(raw.catalogo);
    const ejercicio = parseEjercicio(raw.ejercicio);
    const mes = parseMes(raw.mes);
    const fechaModificacion = optionalString(raw.fechaModificacion) ?? nowIsoSeconds();
    try {
      const xml = generarXmlCatalogo(catalogo, { rfc: optionalString(raw.rfc), ejercicio, mes, fechaModificacion });
      return c.json({ catalogo, xml, sha1: calcularHashSha1(xml) });
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }
  });

  /** Genera la balanza de comprobación (desde los asientos contables del
   * período) + su XML (`BalanzaComprobacion_1_3.xsd`) + hash SHA-1. */
  app.post("/despachos/:propertyId/contabilidad-electronica/balanza", async (c) => {
    assertVerticalRole(c, CONTABILIDAD_ELECTRONICA_ROLES);
    const raw = await readJsonCapped<{
      readonly catalogo?: unknown;
      readonly asientos?: unknown;
      readonly periodo?: unknown;
      readonly saldosIniciales?: unknown;
      readonly rfc?: unknown;
      readonly ejercicio?: unknown;
      readonly mes?: unknown;
      readonly tipoEnvio?: unknown;
      readonly fechaModificacion?: unknown;
    }>(c.req.raw, 1024 * 1024);
    const catalogo = parseCatalogo(raw.catalogo);
    const asientos = parseAsientos(raw.asientos);
    const ejercicio = parseEjercicio(raw.ejercicio);
    const mes = parseMes(raw.mes);
    const periodo = optionalString(raw.periodo) ?? `${ejercicio}-${String(mes).padStart(2, "0")}`;
    const tipoEnvio = typeof raw.tipoEnvio === "string" && TIPOS_ENVIO_BALANZA_VALIDOS.has(raw.tipoEnvio as TipoEnvioBalanza) ? (raw.tipoEnvio as TipoEnvioBalanza) : undefined;
    const fechaModificacion = optionalString(raw.fechaModificacion) ?? nowIsoSeconds();
    const resumen = generarBalanza(catalogo, asientos, periodo, parseSaldosIniciales(raw.saldosIniciales));
    const xml = generarXmlBalanza(resumen.lineas, { rfc: optionalString(raw.rfc), ejercicio, mes, tipoEnvio, fechaModificacion });
    return c.json({ resumen, xml, sha1: calcularHashSha1(xml) });
  });

  /** Genera el paquete completo (catálogo + balanza + hashes + estado
   * `listo_para_timbrar`) — la operación que el checklist de cierre mensual
   * necesita para la tarea "contabilidad_elect". */
  app.post("/despachos/:propertyId/contabilidad-electronica/paquete", async (c) => {
    assertVerticalRole(c, CONTABILIDAD_ELECTRONICA_ROLES);
    const raw = await readJsonCapped<{
      readonly catalogo?: unknown;
      readonly rfc?: unknown;
      readonly razonSocial?: unknown;
      readonly ejercicio?: unknown;
      readonly mes?: unknown;
      readonly asientos?: unknown;
      readonly saldosIniciales?: unknown;
      readonly generadoEn?: unknown;
      readonly fechaModificacionXml?: unknown;
    }>(c.req.raw, 1024 * 1024);
    const catalogo = parseCatalogo(raw.catalogo);
    const ejercicio = parseEjercicio(raw.ejercicio);
    const mes = parseMes(raw.mes);
    const asientos = parseAsientos(raw.asientos);
    const generadoEn = optionalString(raw.generadoEn) ?? new Date().toISOString();
    const fechaModificacionXml = optionalString(raw.fechaModificacionXml) ?? nowIsoSeconds();
    try {
      const paquete = generarPaqueteContabilidadElectronica({
        catalogo,
        rfc: optionalString(raw.rfc),
        razonSocial: optionalString(raw.razonSocial),
        ejercicio,
        mes,
        asientos,
        saldosIniciales: parseSaldosIniciales(raw.saldosIniciales),
        generadoEn,
        fechaModificacionXml,
      });
      return c.json(paquete);
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }
  });

  /** Transiciona el estado del paquete a `listo_para_timbrar` — el estado NO
   * se persiste en esta fase (mismo criterio "endpoint puro/calculadora" que
   * el resto de este archivo): el cliente manda el estado actual que ya
   * conoce (por ejemplo, el que devolvió /paquete) y recibe el nuevo estado
   * validado por el motor de dominio. */
  app.post("/despachos/:propertyId/contabilidad-electronica/listo-para-timbrar", async (c) => {
    assertVerticalRole(c, CONTABILIDAD_ELECTRONICA_ROLES);
    const raw = await readJsonCapped<{ readonly estadoActual?: unknown }>(c.req.raw, 2 * 1024);
    const estadoActual = requireString(raw.estadoActual, "estadoActual");
    if (!ESTADOS_VALIDOS.has(estadoActual as EstadoPaqueteContabilidad)) throw Errors.validation(`estadoActual: se esperaba uno de ${ESTADOS_PAQUETE_CONTABILIDAD.join(", ")}.`);
    try {
      const estado = marcarListoParaTimbrar(estadoActual as EstadoPaqueteContabilidad);
      return c.json({ estado });
    } catch (err) {
      if (err instanceof TransicionPaqueteContabilidadInvalidaError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  return app;
}
