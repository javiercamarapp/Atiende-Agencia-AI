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
// crudos del CFDI que el cliente ya envió una vez.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, agregarDiot, DECLARACIONES_ROLES } from "@atiende/domain-despachos";
import type { RegistroDiotCandidato } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
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
  readonly ingresoMensual?: unknown;
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
  const repo = deps.despachosRepo;

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
    const resultado = calcularIsrPmResico(requireNumber(raw.ingresoMensual, "ingresoMensual"), optionalNumber(raw.pagosProvisionales, "pagosProvisionales", 0));
    return c.json(resultado);
  });

  app.get("/despachos/:propertyId/declaraciones/diot/:periodo", async (c) => {
    assertVerticalRole(c, DECLARACIONES_ROLES);
    const propertyId = c.req.param("propertyId");
    const periodo = c.req.param("periodo");
    if (!/^\d{4}-\d{2}$/.test(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");

    const invoices = await repo.listInvoices(propertyId, { periodo });
    const reportables = invoices.filter((inv) => inv.diot.reportable && inv.diot.proveedoresReportables.length > 0);
    if (reportables.length === 0) {
      return c.json({ registros: [], totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0, periodo, rfcContribuyente: null });
    }

    // Un mismo invoice tipo "I" con subtotal>0 produce exactamente un
    // `proveedoresReportables[0]` (ver reglas-fiscales-avanzadas.ts) — se usa ese
    // único elemento junto con `invoice.subtotal`/`invoice.iva` (la fuente de verdad
    // numérica ya persistida) para construir el candidato DIOT. `ivaTrasladado` =
    // `ivaAcreditable` = `invoice.iva`: desde la perspectiva del receptor (este
    // contribuyente), lo que el emisor le trasladó es exactamente lo que puede
    // acreditar en una factura totalmente deducible — el propio
    // `ProveedorReportableDiot.ivaAcreditable` ya se construyó así en Fase 2 (`iva`
    // sin distinguir traslado/acreditamiento, ver línea `ivaAcreditable: iva ? ... `).
    const candidatos: RegistroDiotCandidato[] = reportables.map((inv) => {
      const p = inv.diot.proveedoresReportables[0]!;
      return {
        rfcEmisor: inv.rfcEmisor,
        nombreEmisor: inv.emisorNombre ?? p.nombreProveedor,
        subtotal: inv.subtotal,
        ivaTrasladado: inv.iva ?? 0,
        ivaAcreditable: inv.iva ?? 0,
        tasaIva: p.tasaIva ?? (inv.iva != null && inv.subtotal > 0 ? inv.iva / inv.subtotal : 0),
        tipoCambio: p.tipoCambio ?? 1,
        moneda: p.moneda ?? "MXN",
        fecha: p.fecha ?? inv.createdAt,
      };
    });

    // El RFC del contribuyente que presenta la DIOT es el receptor de sus propios
    // CFDIs de gasto — todos los invoices de una property deben compartir el mismo
    // `rfcReceptor` (es el mismo cliente del despacho); se toma el primero.
    const rfcContribuyente = reportables[0]!.rfcReceptor;
    const agregado = agregarDiot(candidatos, rfcContribuyente, periodo);
    return c.json(agregado);
  });

  return app;
}
