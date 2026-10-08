// Fase 4 (cierre de gap): el motor de declaraciones (Fase 2 — ISR de honorarios/PM/
// RESICO, agregación DIOT) quedó construido, verificado contra el intérprete Python
// real y 100% cubierto por tests de dominio, pero ninguna ruta HTTP lo invocaba — un
// oversight real de Fase 2 (que se enfocó en el motor, no en cablearlo), no una
// decisión documentada de diferirlo. Esta ruta lo cierra.
//
// Cálculo de ISR es un endpoint puro (sin persistencia): dado que ningún esquema/
// repositorio de despachos modela "declaración presentada" como entidad propia (a
// diferencia de `invoice`/`fiscal_deadline`), y agregar esa tabla sería alcance nuevo
// no pedido por este cierre de gap, se expone como calculadora — el resultado es
// responsabilidad del cliente HTTP guardarlo donde corresponda (ej. adjuntarlo a un
// vencimiento fiscal ya existente vía `comprobanteUrl`).
//
// DIOT, en cambio, SÍ tiene datos reales que agregar: cada invoice tipo "I" con
// subtotal>0 ya persiste su `diot.proveedoresReportables` (Fase 2, ver
// reglas-fiscales-avanzadas.ts) al ingestarse. `GET .../diot/:periodo` reconstruye los
// candidatos DIOT desde los invoices ya guardados (filtro `periodo` de
// `listInvoices`, aditivo desde Fase 2 — ver domain-despachos/src/repository.ts,
// comentario de `listInvoices`) y llama `agregarDiot()` — nunca vuelve a pedir datos
// crudos del CFDI que el cliente ya envió una vez. El filtro `periodo` de
// `listInvoices` resuelve contra la columna real `invoice.fecha` (migración 006,
// corregida — antes resolvía contra el mismo jsonb de DIOT, así que un CFDI que no
// fuera tipo "I" con subtotal>0 desaparecía del período por completo); esta ruta
// sigue acotando la agregación DIOT en sí a `reportables` (abajo) porque esa
// restricción SÍ es una regla de negocio real de la DIOT (solo reporta proveedores
// tipo "I"), no un artefacto del filtro por período.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, candidatosDiotDesdeInvoices, construirDiotDesdeInvoices, construirDiotLayout, DECLARACIONES_ROLES, DiotLayoutError, LAYOUT_DIOT_VERSION, VER_DECLARACIONES_ROLES } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { rfcContribuyenteDeFicha } from "./ficha-rfc.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface IsrPfBody {
  readonly baseGravable?: unknown;
  readonly annual?: unknown;
  readonly pagosProvisionales?: unknown;
}

interface IsrPmBody {
  readonly utilidadFiscal?: unknown;
  readonly pagosProvisionales?: unknown;
}

interface IsrPmResicoBody {
  readonly ingresosCobrados?: unknown;
  readonly deduccionesAutorizadas?: unknown;
  readonly pagosProvisionales?: unknown;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return requireNumber(value, field);
}

export function despachosDeclaracionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/declaraciones/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/declaraciones/isr/pf", async (c) => {
    assertVerticalRole(c, DECLARACIONES_ROLES);
    const raw = await readJsonCapped<IsrPfBody>(c.req.raw, 8 * 1024);
    const resultado = calcularIsrPf(requireNumber(raw.baseGravable, "baseGravable"), {
      annual: raw.annual === true,
      pagosProvisionales: optionalNumber(raw.pagosProvisionales, "pagosProvisionales", 0),
    });
    return c.json(resultado);
  });

  app.post("/despachos/:propertyId/declaraciones/isr/pm", async (c) => {
    assertVerticalRole(c, DECLARACIONES_ROLES);
    const raw = await readJsonCapped<IsrPmBody>(c.req.raw, 8 * 1024);
    const resultado = calcularIsrPm(requireNumber(raw.utilidadFiscal, "utilidadFiscal"), optionalNumber(raw.pagosProvisionales, "pagosProvisionales", 0));
    return c.json(resultado);
  });

  app.post("/despachos/:propertyId/declaraciones/isr/pm-resico", async (c) => {
    assertVerticalRole(c, DECLARACIONES_ROLES);
    const raw = await readJsonCapped<IsrPmResicoBody>(c.req.raw, 8 * 1024);
    // RESICO PM (Art. 206/209 LISR): tasa fija 30% sobre flujo de efectivo
    // (ingresos efectivamente cobrados − deducciones autorizadas efectivamente
    // pagadas) — corrección del hallazgo CRÍTICO #2, ver isr-engine.ts.
    // `deduccionesAutorizadas` es opcional (default 0): si se omite, el ISR
    // resultante sobreestima la base real en vez de fabricar una deducción que
    // nadie proveyó.
    const resultado = calcularIsrPmResico(requireNumber(raw.ingresosCobrados, "ingresosCobrados"), {
      deduccionesAutorizadas: optionalNumber(raw.deduccionesAutorizadas, "deduccionesAutorizadas", 0),
      pagosProvisionales: optionalNumber(raw.pagosProvisionales, "pagosProvisionales", 0),
    });
    return c.json(resultado);
  });

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): ver la DIOT ya agregada desde invoices
  // persistidos es lectura pura -- auditor/readonly SÍ pueden verla
  // (VER_DECLARACIONES_ROLES), aunque nunca calcular ISR (DECLARACIONES_ROLES,
  // sin cambios, arriba).
  app.get("/despachos/:propertyId/declaraciones/diot/:periodo", async (c) => {
    assertVerticalRole(c, VER_DECLARACIONES_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodo = c.req.param("periodo");
    if (!/^\d{4}-\d{2}$/.test(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");

    // La reconstrucción DIOT desde los invoices persistidos (reglas de `proveedoresReportables`,
    // ivaTrasladado = ivaAcreditable = invoice.iva, fecha real de emisión; D-P3-01: solo compras
    // recibidas, vigentes y válidas, y RFC del contribuyente = el de la FICHA de cartera, nunca un CFDI) vive en `construirDiotDesdeInvoices`, compartida
    // con los reportes de cliente (`reportes/`) para que ambas superficies no puedan divergir.
    const invoices = await repo.listInvoices(propertyId, { periodo });
    const rfcFicha = await rfcContribuyenteDeFicha(deps, c.get("db"), propertyId);
    return c.json(construirDiotDesdeInvoices(invoices, periodo, rfcFicha));
  });

  // D-05: layout DIOT (TXT "|" y XML) del periodo, SIN firma ni envío (el envío con e.firma
  // es D-18). Lectura pura sobre invoices ya persistidos -- mismo rol y misma reconstrucción
  // que el GET de arriba (`candidatosDiotDesdeInvoices` comparte la regla). No requiere
  // migración: no usa ninguna tabla/función nueva. Devuelve JSON con ambos archivos para que
  // el panel los descargue como Blob; `advertencias`/`omitidos` dicen qué NO se capturó.
  app.get("/despachos/:propertyId/declaraciones/diot/:periodo/layout", async (c) => {
    assertVerticalRole(c, VER_DECLARACIONES_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const periodo = c.req.param("periodo");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");

    const propertyId = c.req.param("propertyId");
    const invoices = await repo.listInvoices(propertyId, { periodo });
    const { candidatos, rfcContribuyente } = candidatosDiotDesdeInvoices(invoices, await rfcContribuyenteDeFicha(deps, c.get("db"), propertyId));
    // D-38: el layout DIOT (TXT/XML) es un archivo que sale del sistema -> fila de bitacora (periodo y numero de terceros; sin RFC).
    await auditarAccesoDespachos(deps, c, { recurso: "declaraciones.diot_layout", tipo: "export", metadata: { periodo, terceros: candidatos.length } });
    if (candidatos.length === 0 || rfcContribuyente === null) {
      return c.json({
        version: LAYOUT_DIOT_VERSION,
        periodo,
        rfcContribuyente: null,
        renglones: [],
        omitidos: [],
        advertencias: [
          rfcContribuyente === null
            ? "El cliente no tiene ficha de cartera con RFC: no se puede armar la DIOT. Captura la ficha en Cartera."
            : "No hay terceros reportables en el periodo (solo cuentan compras recibidas, vigentes y válidas): el archivo no contiene renglones.",
        ],
        txt: "",
        xml: "",
      });
    }
    try {
      return c.json(construirDiotLayout(candidatos, rfcContribuyente, periodo));
    } catch (err) {
      if (err instanceof DiotLayoutError) throw Errors.validation(err.message);
      throw err;
    }
  });

  return app;
}
