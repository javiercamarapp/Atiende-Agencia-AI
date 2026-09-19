// Fase 6 (bookkeeping / auto-clasificador de pólizas): expone el motor
// determinista de `@atiende/domain-despachos` (puerto de
// `b2b_ai/features/bookkeeping/`, ver domain-despachos/src/bookkeeping/) —
// SIN el nivel ML (ver comentario de cabecera de clasificador.ts). Endpoint
// puro/calculadora, mismo criterio que conciliacion.ts: el cliente HTTP manda
// los CFDI ya clasificables (descripción, montos, tipo) y las correcciones
// humanas (`overrides`) ya persistidas — este motor no guarda estado propio.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import {
  BOOKKEEPING_ROLES,
  VER_BOOKKEEPING_ROLES,
  predecirCategoria,
  necesitaRevisionHumana,
  generatePoliza,
  validatePoliza,
  generateAdjustment,
  getSuggestionsForRetraining,
  CATALOGO_CUENTAS_SAT,
  DEFAULT_MAPPINGS,
} from "@atiende/domain-despachos";
import type { CfdiClassification, OverrideRecord, TipoCfdiBookkeeping } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const TIPOS_VALIDOS = new Set<TipoCfdiBookkeeping>(["I", "E", "T", "P", "N"]);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

interface CfdiBody {
  readonly cfdiUuid?: unknown;
  readonly rfcEmisor?: unknown;
  readonly rfcReceptor?: unknown;
  readonly descripcion?: unknown;
  readonly subtotal?: unknown;
  readonly iva?: unknown;
  readonly total?: unknown;
  readonly tasaIva?: unknown;
  readonly tipoCfdi?: unknown;
}

function parseTipoCfdi(value: unknown, field: string): TipoCfdiBookkeeping {
  const v = requireString(value, field);
  if (!TIPOS_VALIDOS.has(v as TipoCfdiBookkeeping)) throw Errors.validation(`${field}: se esperaba I|E|T|P|N.`);
  return v as TipoCfdiBookkeeping;
}

interface OverrideBody {
  readonly cfdiUuid?: unknown;
  readonly rfcEmisor?: unknown;
  readonly newCategoria?: unknown;
  readonly tenantId?: unknown;
}

function parseOverrides(raw: unknown): readonly OverrideRecord[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("overrides: se esperaba un arreglo.");
  return (raw as OverrideBody[]).map((o, idx) => ({
    cfdiUuid: requireString(o.cfdiUuid, `overrides[${idx}].cfdiUuid`),
    rfcEmisor: requireString(o.rfcEmisor, `overrides[${idx}].rfcEmisor`).toUpperCase(),
    newCategoria: requireString(o.newCategoria, `overrides[${idx}].newCategoria`),
    tenantId: typeof o.tenantId === "string" ? o.tenantId : "",
  }));
}

function overridesARfcMap(overrides: readonly OverrideRecord[]): Map<string, string> {
  // Último override por RFC gana (comportamiento de `add_override`: es un
  // mapa que se sobreescribe, no una agregación por mayoría — la mayoría por
  // RFC es una señal aparte, ver `getRfcCategoryFeedback`/`/overrides/
  // sugerencias`).
  const map = new Map<string, string>();
  for (const o of overrides) map.set(o.rfcEmisor, o.newCategoria);
  return map;
}

export function despachosBookkeepingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/bookkeeping/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): el catálogo de cuentas base es referencia fija
  // (sin datos del cliente) -- auditor/readonly SÍ pueden verlo
  // (VER_BOOKKEEPING_ROLES), aunque nunca clasificar/generar pólizas
  // (BOOKKEEPING_ROLES, sin cambios, en el resto de rutas de este archivo).
  app.get("/despachos/:propertyId/bookkeeping/catalogo", async (c) => {
    assertVerticalRole(c, VER_BOOKKEEPING_ROLES);
    return c.json({ catalogoCuentas: CATALOGO_CUENTAS_SAT, mapeosDefault: DEFAULT_MAPPINGS });
  });

  /** Clasifica un lote de CFDI: override humano exacto por RFC (prioridad
   * máxima) → fallback de reglas por keyword (ver clasificador.ts). */
  app.post("/despachos/:propertyId/bookkeeping/clasificar", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const raw = await readJsonCapped<{ readonly cfdis?: unknown; readonly overrides?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.cfdis)) throw Errors.validation("cfdis: se esperaba un arreglo.");
    const overridesMap = overridesARfcMap(parseOverrides(raw.overrides));

    const resultados = (raw.cfdis as CfdiBody[]).map((cfdi, idx) => {
      const descripcion = typeof cfdi.descripcion === "string" ? cfdi.descripcion : "";
      const tipoCfdi = parseTipoCfdi(cfdi.tipoCfdi, `cfdis[${idx}].tipoCfdi`);
      const rfcEmisor = requireString(cfdi.rfcEmisor, `cfdis[${idx}].rfcEmisor`).toUpperCase();
      const prediccion = predecirCategoria(descripcion, tipoCfdi, rfcEmisor, overridesMap);
      const classification: CfdiClassification = {
        cfdiUuid: requireString(cfdi.cfdiUuid, `cfdis[${idx}].cfdiUuid`),
        rfcEmisor,
        rfcReceptor: typeof cfdi.rfcReceptor === "string" ? cfdi.rfcReceptor.toUpperCase() : "",
        descripcion,
        subtotal: optionalNumber(cfdi.subtotal, `cfdis[${idx}].subtotal`, 0),
        iva: optionalNumber(cfdi.iva, `cfdis[${idx}].iva`, 0),
        total: optionalNumber(cfdi.total, `cfdis[${idx}].total`, 0),
        tasaIva: optionalNumber(cfdi.tasaIva, `cfdis[${idx}].tasaIva`, 0.16),
        tipoCfdi,
        categoria: prediccion.categoria,
        confidence: prediccion.confidence,
        needsHumanReview: necesitaRevisionHumana(prediccion.confidence),
      };
      return classification;
    });

    return c.json({ clasificaciones: resultados });
  });

  /** Genera + valida una póliza por cada CFDI ya clasificado (ver ruta
   * `/clasificar` de arriba, o el propio cliente puede mandar `categoria`
   * directo si ya la conoce). */
  app.post("/despachos/:propertyId/bookkeeping/poliza", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const raw = await readJsonCapped<{ readonly clasificaciones?: unknown; readonly tenantId?: unknown; readonly fecha?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.clasificaciones)) throw Errors.validation("clasificaciones: se esperaba un arreglo.");
    const tenantId = typeof raw.tenantId === "string" ? raw.tenantId : "";
    // Bug real (revisión r6, misma causa raíz que `./vencimientos.ts::todayIso` -- ver su
    // comentario de cabecera): el default de `fecha` (cuando el caller no la manda) usaba
    // el día UTC del proceso, corrido un día adelante del real en CDMX entre las 18:00 y
    // las 23:59 hora local -- mismo bug ya corregido del lado del navegador en
    // `apps/web/src/verticals/despachos/pages/Bookkeeping.tsx` (PR #164, commit `056c28d`).
    const fecha = typeof raw.fecha === "string" ? raw.fecha : hoyFechaNegocio();

    const resultados = (raw.clasificaciones as CfdiBody[]).map((cfdi, idx) => {
      const classification: CfdiClassification = {
        cfdiUuid: requireString(cfdi.cfdiUuid, `clasificaciones[${idx}].cfdiUuid`),
        rfcEmisor: typeof cfdi.rfcEmisor === "string" ? cfdi.rfcEmisor.toUpperCase() : "",
        rfcReceptor: typeof cfdi.rfcReceptor === "string" ? cfdi.rfcReceptor.toUpperCase() : "",
        descripcion: typeof cfdi.descripcion === "string" ? cfdi.descripcion : "",
        subtotal: optionalNumber(cfdi.subtotal, `clasificaciones[${idx}].subtotal`, 0),
        iva: optionalNumber(cfdi.iva, `clasificaciones[${idx}].iva`, 0),
        total: optionalNumber(cfdi.total, `clasificaciones[${idx}].total`, 0),
        tasaIva: optionalNumber(cfdi.tasaIva, `clasificaciones[${idx}].tasaIva`, 0.16),
        tipoCfdi: parseTipoCfdi(cfdi.tipoCfdi, `clasificaciones[${idx}].tipoCfdi`),
        categoria: requireString((cfdi as unknown as { categoria?: unknown }).categoria, `clasificaciones[${idx}].categoria`),
        confidence: optionalNumber((cfdi as unknown as { confidence?: unknown }).confidence, `clasificaciones[${idx}].confidence`, 1),
        needsHumanReview: false,
      };
      const poliza = generatePoliza(classification, tenantId);
      if (!poliza) return { cfdiUuid: classification.cfdiUuid, poliza: null, errores: [`Sin mapeo contable para (tipoCfdi=${classification.tipoCfdi}, categoria=${classification.categoria}).`] };
      const conFecha = { ...poliza, fecha };
      return { cfdiUuid: classification.cfdiUuid, poliza: conFecha, errores: validatePoliza(conFecha) };
    });

    return c.json({ polizas: resultados });
  });

  /** Póliza de ajuste manual (diario) — mismo motor que las pólizas de CFDI,
   * sin garantía estructural de balance (el cliente debe mandar entradas ya
   * balanceadas; `validatePoliza` lo confirma). */
  app.post("/despachos/:propertyId/bookkeeping/ajuste", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const raw = await readJsonCapped<{ readonly fecha?: unknown; readonly concepto?: unknown; readonly entries?: unknown; readonly tenantId?: unknown }>(c.req.raw, 128 * 1024);
    const fecha = requireString(raw.fecha, "fecha");
    const concepto = requireString(raw.concepto, "concepto");
    if (!Array.isArray(raw.entries)) throw Errors.validation("entries: se esperaba un arreglo.");
    const entries = (raw.entries as { cuenta?: unknown; debe?: unknown; haber?: unknown; concepto?: unknown }[]).map((e, idx) => ({
      cuenta: requireString(e.cuenta, `entries[${idx}].cuenta`),
      debe: optionalNumber(e.debe, `entries[${idx}].debe`, 0),
      haber: optionalNumber(e.haber, `entries[${idx}].haber`, 0),
      concepto: typeof e.concepto === "string" ? e.concepto : "",
    }));
    const tenantId = typeof raw.tenantId === "string" ? raw.tenantId : "";
    const poliza = generateAdjustment(fecha, concepto, entries, tenantId);
    return c.json({ poliza, errores: validatePoliza(poliza) });
  });

  /** Agregación de correcciones humanas por RFC (ver overrides.ts) — el
   * cliente manda el historial completo de overrides ya persistido. */
  app.post("/despachos/:propertyId/bookkeeping/overrides/sugerencias", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const raw = await readJsonCapped<{ readonly overrides?: unknown }>(c.req.raw, 512 * 1024);
    const overrides = parseOverrides(raw.overrides);
    return c.json({ sugerencias: getSuggestionsForRetraining(overrides) });
  });

  return app;
}
