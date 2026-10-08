// Reportes de cliente (D-01): balanza, DIOT, nómina e impuestos de UN contribuyente y
// período, en JSON (pantalla), PDF o Excel (.xlsx).
//   GET /despachos/:propertyId/reportes/:tipo?periodo=YYYY-MM&formato=json|pdf|xlsx
//
// Solo lectura, calculada desde datos reales (CFDI 4.0 ingeridos, vencimientos fiscales
// SAT y, para la balanza, el libro contable de D-24); lo que el modelo no persiste se devuelve "sin datos" con su motivo — ver
// `@atiende/domain-despachos::reportes/builders.ts`. Roles de lectura (`VER_REPORTES_ROLES`);
// la membership de property aplica igual que en el resto de rutas de staff. Sin migración.
// Sin llamadas al SAT ni a PACs.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { PostgresLibroRepository, TIPOS_REPORTE_CLIENTE, VER_REPORTES_ROLES, XLSX_CONTENT_TYPE, construirReporteCliente, leerFuenteOpcional, reporteAXlsx } from "@atiende/domain-despachos";
import type { ReporteCliente, TipoReporteCliente } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";
import { reporteAPdf } from "./reporte-pdf.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";

const PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FORMATOS = ["json", "pdf", "xlsx"] as const;
type Formato = (typeof FORMATOS)[number];

function esTipo(v: string): v is TipoReporteCliente {
  return (TIPOS_REPORTE_CLIENTE as readonly string[]).includes(v);
}

/** Período por defecto: el mes calendario anterior al "hoy" de negocio (el que normalmente se reporta al cliente). */
function periodoAnterior(hoy: string): string {
  const year = Number(hoy.slice(0, 4));
  const month = Number(hoy.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * Construye el reporte de cliente (balanza, DIOT, nomina o impuestos) de un periodo desde los datos persistidos. UNA sola implementacion para
 * `GET .../reportes/:tipo` y para la entrega al cliente al cerrar el periodo (cierre-mensual.ts). Lanza `ApiError` 503 si la base no tiene la
 * migracion 006 (fecha de emision del CFDI).
 */
export async function construirReporteDelPeriodo(deps: AppDeps, db: TenantDbSession, organizationId: string, propertyId: string, tipo: TipoReporteCliente, periodo: string, hoy: string): Promise<ReporteCliente> {
  const repo = deps.despachosRepo(db);
  const branches = await repo.listPropertiesForOrganization(organizationId);
  const nombre = branches.find((b) => b.propertyId === propertyId)?.name ?? "Contribuyente";
  // El filtro por período de `listInvoices` usa `invoice.fecha` (migración 006). Contra una base que
  // todavía no la tiene (SQLSTATE 42703/42P01/42883) la lectura corre en su propio SAVEPOINT y se
  // responde un 503 honesto ("no disponible aún"), nunca un 500 ni un reporte vacío engañoso.
  const invoicesDelPeriodo = await leerFuenteOpcional(repo, () => repo.listInvoices(propertyId, { periodo }));
  if (invoicesDelPeriodo === null) {
    throw Errors.serviceUnavailable("Los reportes por período aún no están disponibles en esta base de datos: falta aplicar la migración 006 (fecha de emisión del CFDI).");
  }
  const vencimientos = await repo.listDeadlines(propertyId);
  // D-24: la balanza sale del libro contable persistido cuando hay pólizas en el periodo; base sin migrar (020) o sin pólizas -> "sin datos".
  const balanzaLibro =
    tipo === "balanza"
      ? (await (deps.libroRepo ? deps.libroRepo(db) : new PostgresLibroRepository(db)).balanza(propertyId, Number(periodo.slice(0, 4)), Number(periodo.slice(5, 7)))).datos
      : undefined;
  const reporte = construirReporteCliente(tipo, { periodo, generadoEn: hoy, contribuyente: { nombre } }, { invoicesDelPeriodo, vencimientosDelPeriodo: vencimientos.filter((v) => v.periodo === periodo), balanzaLibro });
  return reporte;
}

export function despachosReportesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/reportes/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/despachos/:propertyId/reportes/:tipo", async (c) => {
    assertVerticalRole(c, VER_REPORTES_ROLES);
    const tipo = c.req.param("tipo");
    if (!esTipo(tipo)) throw Errors.validation(`tipo: se esperaba uno de ${TIPOS_REPORTE_CLIENTE.join(", ")}.`);
    const formato = (c.req.query("formato") ?? "json") as Formato;
    if (!FORMATOS.includes(formato)) throw Errors.validation(`formato: se esperaba uno de ${FORMATOS.join(", ")}.`);

    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const periodo = c.req.query("periodo") ?? periodoAnterior(hoy);
    if (!PERIODO_RE.test(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    const reporte = await construirReporteDelPeriodo(deps, c.get("db"), c.get("organizationId"), propertyId, tipo, periodo, hoy);

    if (formato === "json") return c.json(reporte);

    // D-38: PDF y XLSX son documentos que salen del sistema -> fila de bitacora (tipo de reporte, periodo y formato; sin datos del contribuyente).
    await auditarAccesoDespachos(deps, c, { recurso: `reporte.${tipo}`, tipo: "export", metadata: { periodo, formato } });

    const archivo = `reporte-${tipo}-${periodo}.${formato}`;
    const cabeceras = { "content-disposition": `attachment; filename="${archivo}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
    if (formato === "xlsx") return new Response(reporteAXlsx(reporte), { headers: { ...cabeceras, "content-type": XLSX_CONTENT_TYPE } });
    return new Response(await reporteAPdf(reporte), { headers: { ...cabeceras, "content-type": "application/pdf" } });
  });

  return app;
}
