// CFO-06 · `GET /v1/restaurantes/:propertyId/admin/cfo/exportar?formato=xlsx|pdf&vista=completo|resumen|estado-resultados|sucursales&desde&hasta&sucursales=`
// Descarga el reporte del CFO como Excel (.xlsx, una hoja por sucursal) o PDF («reporte de consejo»).
//
// Seguridad y comportamiento:
//  - Acción `cfo.exportar` (solo owner/admin) y el MISMO alcance que las lecturas del CFO (CFO-05): un admin acotado exporta solo lo suyo y no recibe
//    «No asignado»; una sucursal ajena, inexistente o de otra organización da el mismo 403. La base vuelve a validar el alcance (doble puerta).
//  - La bitácora (`cfo_registrar_exportacion`, migración 083) se escribe ANTES de responder y DESPUÉS de armar el archivo (no se registra una descarga
//    que no se pudo generar). Si la bitácora falla, NO se entrega el archivo: 503.
//  - Topes: rango máximo 400 días (422); el PDF trae el detalle por sucursal hasta 7 sucursales (con más, el detalle va solo en el Excel); el PDF
//    se limita a 40 páginas (413 si el contenido las excediera). Tope de 6 exportaciones por minuto por persona (429).
//  - El nombre del archivo no lleva datos personales ni nombres: `cfo-<org>-<desde>-<hasta>-<alcance>.<ext>`.
//  - Sin ETag ni caché: el archivo se genera en cada petición y lleva `Cache-Control: no-store`.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CfoNoDisponibleError, CfoParametroInvalidoError, CfoSinAccesoError } from "@atiende/domain-restaurantes/cfo";
import type { ConsultaCfo, ServicioCfo, VistaExportacionCfo } from "@atiende/domain-restaurantes/cfo";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";
import { construirContextoCfo, MENSAJE_SIN_ACCESO_CFO } from "./cfo.ts";
import { invalido, parsearRango, parsearSucursales } from "./cfo-esquemas.ts";
import { construirLibroCfo, VISTAS_EXPORTAR_CFO, XLSX_CONTENT_TYPE } from "./cfo-exportar-xlsx.ts";
import type { AlcanceExportacion, VistaExportarCfo, VistasCfo } from "./cfo-exportar-xlsx.ts";
import { CfoPdfDemasiadasPaginas, construirReporteCfoPdf } from "./cfo-exportar-pdf.ts";

const BASE = "/v1/restaurantes/:propertyId/admin/cfo";
export const CFO_EXPORTAR_LIMITE_POR_MIN = 6;
const PDF_CONTENT_TYPE = "application/pdf";

/** La vista de la bitácora (083 admite un conjunto fijo): «completo» se registra como `resumen`. */
const VISTA_BITACORA: Readonly<Record<VistaExportarCfo, VistaExportacionCfo>> = {
  completo: "resumen",
  resumen: "resumen",
  "estado-resultados": "estado_resultados",
  sucursales: "sucursales",
};

type ClaveVista = keyof VistasCfo;
const TODAS_XLSX: readonly ClaveVista[] = ["resumen", "ventas", "sucursales", "estadoResultados", "clientes", "productos", "operacion", "cuadreSr"];
/** Qué vistas del servicio arma cada exportación. El PDF solo usa un subconjunto (nada de platillos, operación ni SoftRestaurant). */
const NECESITA: Readonly<Record<"xlsx" | "pdf", Readonly<Record<VistaExportarCfo, readonly ClaveVista[]>>>> = {
  xlsx: {
    completo: TODAS_XLSX,
    resumen: ["resumen", "ventas"],
    "estado-resultados": ["estadoResultados", "resumen"],
    sucursales: ["sucursales", "estadoResultados", "resumen"],
  },
  pdf: {
    completo: ["resumen", "ventas", "sucursales", "estadoResultados", "clientes"],
    resumen: ["resumen", "ventas"],
    "estado-resultados": ["estadoResultados", "resumen"],
    sucursales: ["sucursales", "estadoResultados", "resumen"],
  },
};

export async function cargarVistasCfo(servicio: ServicioCfo, vista: VistaExportarCfo, formato: "xlsx" | "pdf", q: ConsultaCfo): Promise<VistasCfo> {
  const n = new Set(NECESITA[formato][vista]);
  // Secuencial: una sola sesión de base; el servicio memoiza lo que dos vistas comparten.
  const resumen = n.has("resumen") ? await servicio.resumen(q) : null;
  const ventas = n.has("ventas") ? await servicio.ventasVista(q) : null;
  const sucursales = n.has("sucursales") ? await servicio.sucursalesVista(q) : null;
  const estadoResultados = n.has("estadoResultados") ? await servicio.estadoResultados(q) : null;
  const clientes = n.has("clientes") ? await servicio.clientesVista(q) : null;
  const productos = n.has("productos") ? await servicio.productosVista(q) : null;
  const operacion = n.has("operacion") ? await servicio.operacionVista(q) : null;
  const cuadreSr = n.has("cuadreSr") ? await servicio.cuadreSr(q) : null;
  return { resumen, ventas, sucursales, estadoResultados, clientes, productos, operacion, cuadreSr };
}

function parsearFormato(raw: string | undefined): "xlsx" | "pdf" {
  if (raw === "xlsx" || raw === "pdf") return raw;
  throw invalido("formato debe ser xlsx o pdf.");
}

function parsearVista(raw: string | undefined): VistaExportarCfo {
  if (raw === undefined || raw === "") return "completo";
  if ((VISTAS_EXPORTAR_CFO as readonly string[]).includes(raw)) return raw as VistaExportarCfo;
  throw invalido("vista debe ser completo, resumen, estado-resultados o sucursales.");
}

/** Identificador corto y sin datos personales de la organización para el nombre del archivo. */
function orgCorta(organizationId: string): string {
  const m = /^[0-9a-f]{8}/i.exec(organizationId);
  return m ? m[0].toLowerCase() : "org";
}

export function nombreArchivoCfo(organizationId: string, desde: string, hasta: string, todas: boolean, organizacionCompleta: boolean, nSucursales: number, formato: "xlsx" | "pdf"): string {
  // «todas» solo si es la organización completa; un admin acotado que pide «todas» las suyas lleva otro rótulo.
  const alcance = todas ? (organizacionCompleta ? "todas" : "acotado") : `${nSucursales}suc`;
  return `cfo-${orgCorta(organizationId)}-${desde}-${hasta}-${alcance}.${formato}`;
}

export function restaurantesCfoExportarRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  // Sin middleware propio: authMiddleware -> dbSession -> requirePropertyMembership ya los pone `restaurantesCfoRoutes` con `use(BASE/*)`. Este sub-app se
  // monta SIEMPRE después de aquel en restaurantes.ts (registrarlos dos veces abriría dos sesiones de base por petición).

  app.get(`${BASE}/exportar`, async (c) => {
    assertAccion(c, "cfo.exportar");
    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope: "cfo-exportar", actor: `${c.get("organizationId")}:${c.get("userId")}`, maxRequests: CFO_EXPORTAR_LIMITE_POR_MIN, windowSeconds: 60 }]);
    if (agotado !== null) throw Errors.tooManyRequests();
    const formato = parsearFormato(c.req.query("formato"));
    const vista = parsearVista(c.req.query("vista"));
    const { desde, hasta } = parsearRango(c.req.query("desde"), c.req.query("hasta"));
    const ids = parsearSucursales(c.req.query("sucursales"));

    let ctx;
    let cuerpo: Uint8Array;
    const generadoEn = new Date();
    try {
      ctx = await construirContextoCfo(deps, c, ids);
      const q: ConsultaCfo = { desde, hasta, comparar: "periodo_anterior", granularidad: "dia" };
      const vistas = await cargarVistasCfo(ctx.servicio, vista, formato, q);
      const alcance: AlcanceExportacion = {
        organizacion: `Organización ${orgCorta(ctx.organizationId)}`,
        vista,
        desde,
        hasta,
        alcance: { ...ctx.alcance, etiqueta: vistas.resumen?.alcance.etiqueta ?? vistas.estadoResultados?.alcance.etiqueta ?? (ctx.alcance.organizacionCompleta && ids === null ? "Todas sus sucursales" : `${ctx.sucursales.length} sucursal(es)`) },
      };
      cuerpo = formato === "xlsx" ? construirLibroCfo(vistas, alcance, generadoEn) : await construirReporteCfoPdf(vistas, alcance, generadoEn);
    } catch (err) {
      if (err instanceof CfoPdfDemasiadasPaginas) throw Errors.payloadTooLarge("El reporte excede las 40 páginas. Acota el rango o las sucursales, o descarga el Excel.");
      if (err instanceof CfoParametroInvalidoError) throw Errors.validation(err.message);
      if (err instanceof CfoSinAccesoError) throw Errors.forbidden(MENSAJE_SIN_ACCESO_CFO);
      if (err instanceof CfoNoDisponibleError) throw Errors.serviceUnavailable("El CFO todavía no está disponible: falta aplicar la actualización de base de datos correspondiente.");
      throw err;
    }

    // Bitácora ANTES de responder: si falla, no se exporta nada.
    try {
      await ctx.repo.registrarExportacion({ organizationId: ctx.organizationId, propertyIds: ctx.propertyIdsSql, vista: VISTA_BITACORA[vista], formato, desde, hasta });
    } catch (err) {
      if (err instanceof CfoSinAccesoError) throw Errors.forbidden(MENSAJE_SIN_ACCESO_CFO);
      if (err instanceof CfoParametroInvalidoError) throw Errors.validation(err.message);
      logEvent(c, "error", "restaurantes_cfo_exportacion_bitacora_fallida", { organizationId: ctx.organizationId, formato, message: err instanceof Error ? err.message : String(err) });
      throw Errors.serviceUnavailable("No se pudo registrar la exportación en la bitácora; por seguridad no se entrega el archivo. Intenta de nuevo.");
    }
    logEvent(c, "info", "restaurantes_cfo_exportado", { actorUserId: c.get("userId"), organizationId: ctx.organizationId, vista, formato, bytes: cuerpo.length });

    const archivo = nombreArchivoCfo(ctx.organizationId, desde, hasta, ctx.alcance.todas, ctx.alcance.organizacionCompleta, ctx.sucursales.length, formato);
    return new Response(Buffer.from(cuerpo), {
      status: 200,
      headers: {
        "content-type": formato === "xlsx" ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${archivo}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  return app;
}
