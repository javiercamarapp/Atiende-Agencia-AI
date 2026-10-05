// Rn-P3-06/07 -- cadena de dinero de rentas en piloto automatico:
//   POST /rentas/:propertyId/payouts/importar-csv          importa (o previsualiza) el reporte de pagos de la OTA
//   GET  /rentas/:propertyId/finanzas/cola-importacion      lineas pendientes o en discrepancia
//   GET  /rentas/:propertyId/finanzas/sin-movimiento        reservas confirmadas del periodo sin movimiento financiero
//   GET  /rentas/:propertyId/finanzas/movimientos-en-revision
//   POST /rentas/:propertyId/reservas/:ocupacionId/movimiento/revisado
// Ningun calculo de dinero vive aqui: lo decide @atiende/domain-rentas. Compatibilidad con la base sin migrar: lo que depende de la
// migracion 035 corre dentro de SAVEPOINT (runWithSavepointFallback) y, sin ella, responde un estado honesto "no disponible aun"
// (503 al escribir, `disponible:false` al leer), nunca un 500.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { ApiError, authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { LineaColaImportacion, MovimientoEnRevision } from "@atiende/domain-rentas";
import { FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES, importarReportePagos, LIMITES_REPORTE, parsearReportePagos, RentasDomainError } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { mapRentasDomainError } from "./reservas.ts";

const PERIODO_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MOTIVO_NO_DISPONIBLE = "Requiere la migracion 035 de rentas, pendiente de aplicar en este ambiente.";

type Listado<T> = { readonly disponible: true; readonly items: readonly T[] } | { readonly disponible: false; readonly motivo: string; readonly items: readonly never[] };

function noDisponible(): ApiError {
  return new ApiError(503, "rentas_finanzas_autopiloto_no_disponible", `No disponible aun: ${MOTIVO_NO_DISPONIBLE}`);
}

/** `YYYY-MM` -> `[YYYY-MM-01, primer dia del mes siguiente)`. */
export function rangoDePeriodo(periodo: string): { desde: string; hasta: string } {
  const m = PERIODO_RE.exec(periodo);
  if (!m) throw Errors.validation("periodo: formato esperado YYYY-MM.");
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const siguiente = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;
  return { desde: `${m[1]}-${m[2]}-01`, hasta: siguiente };
}

interface ImportarBody {
  readonly canalCodigo?: unknown;
  readonly contenidoCsv?: unknown;
  readonly aplicar?: unknown;
  readonly comisionGestorBasisPoints?: unknown;
  readonly comisionGestorBase?: unknown;
}

export function rentasFinanzasImportacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const mw = [authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId")] as const;

  const importarPath = "/rentas/:propertyId/payouts/importar-csv";
  const colaPath = "/rentas/:propertyId/finanzas/cola-importacion";
  const sinMovimientoPath = "/rentas/:propertyId/finanzas/sin-movimiento";
  const revisionPath = "/rentas/:propertyId/finanzas/movimientos-en-revision";
  const revisadoPath = "/rentas/:propertyId/reservas/:ocupacionId/movimiento/revisado";
  for (const p of [importarPath, colaPath, sinMovimientoPath, revisionPath, revisadoPath]) app.use(p, ...mw);

  app.post(importarPath, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    // Tope del archivo: 2 MB de contenido (+ margen del envoltorio JSON y de los escapes). Pasarse -> 413 antes de parsear.
    const raw = await readJsonCapped<ImportarBody>(c.req.raw, LIMITES_REPORTE.maxBytes * 2 + 16 * 1024);
    if (typeof raw.canalCodigo !== "string" || raw.canalCodigo.trim() === "" || raw.canalCodigo.length > 60) throw Errors.validation("canalCodigo: se esperaba un texto de 1-60 caracteres.");
    if (typeof raw.contenidoCsv !== "string" || raw.contenidoCsv.length === 0) throw Errors.validation("contenidoCsv: se esperaba el texto del archivo CSV.");
    if (Buffer.byteLength(raw.contenidoCsv, "utf8") > LIMITES_REPORTE.maxBytes) throw Errors.payloadTooLarge(`El archivo excede ${LIMITES_REPORTE.maxBytes / (1024 * 1024)} MB.`);
    if (raw.aplicar !== undefined && typeof raw.aplicar !== "boolean") throw Errors.validation("aplicar: se esperaba true o false (por omision false = vista previa).");
    const aplicar = raw.aplicar === true;
    const bp = raw.comisionGestorBasisPoints;
    if (typeof bp !== "number" || !Number.isInteger(bp) || bp < 0 || bp > 10000) throw Errors.validation("comisionGestorBasisPoints: se esperaba un entero entre 0 y 10000.");
    if (raw.comisionGestorBase !== "bruto" && raw.comisionGestorBase !== "neto_de_canal") throw Errors.validation("comisionGestorBase: se esperaba 'bruto' | 'neto_de_canal'.");
    const comisionGestor = { basisPoints: bp, base: raw.comisionGestorBase } as const;
    const canalCodigo = raw.canalCodigo.trim();

    const canal = await repo.findCanalPorCodigo(canalCodigo);
    if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no existe en el catalogo.`);

    try {
      const parseo = parsearReportePagos(canalCodigo, raw.contenidoCsv);
      if (aplicar && parseo.errores.length > 0) {
        throw new ApiError(422, "reporte_con_errores", `El archivo tiene ${parseo.errores.length} fila(s) con errores; corrigelo y vuelve a subirlo (la importacion es todo o nada): ${parseo.errores.slice(0, 5).map((e) => `fila ${e.fila}: ${e.motivo}`).join(" | ")}`);
      }
      const archivoSha256 = createHash("sha256").update(raw.contenidoCsv).digest("hex");
      // Una transaccion por archivo: la sesion del request ya lo es; el SAVEPOINT deja la transaccion utilizable si la base no tiene la
      // migracion 035 (42703/42P01) y asegura que un error a mitad de archivo no deje filas a medias.
      const resultado = await runWithSavepointFallback({
        session: db,
        primary: () => importarReportePagos(repo, { organizationId, propertyId, userId, canal: { id: canal.id, codigo: canal.codigo }, parseo, archivoSha256, aplicar, comisionGestor }),
        isRecoverable: (err) => isMigrationPendingError(err),
        fallback: () => {
          throw noDisponible();
        },
      });
      if (resultado.aplicado) {
        await repo.registrarAuditoria({
          organizationId,
          actorUserId: userId,
          action: "payout.importado_csv",
          entityType: "payout",
          entityId: resultado.importacionId,
          campo: "lineas",
          antes: null,
          despues: `canal=${canalCodigo} lineas=${resultado.resumen.totalLineas} creadas=${resultado.resumen.creadas} conciliadas=${resultado.resumen.conciliadas} discrepancias=${resultado.resumen.discrepancias} pendientes=${resultado.resumen.pendientes} ya_importadas=${resultado.resumen.yaImportadas}`,
        });
      }
      return c.json({ ...resultado, errores: parseo.errores }, aplicar ? 201 : 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  app.get(colaPath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const repo = deps.rentasRepo(c.get("db"));
    const items = await runWithSavepointFallback<Listado<LineaColaImportacion>>({
      session: c.get("db"),
      primary: async () => ({ disponible: true, items: await repo.listColaImportacion(c.req.param("propertyId"), 200) }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, motivo: MOTIVO_NO_DISPONIBLE, items: [] }),
    });
    return c.json(items, 200);
  });

  app.get(sinMovimientoPath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const periodo = c.req.query("periodo");
    if (!periodo) throw Errors.validation("periodo: formato esperado YYYY-MM.");
    const { desde, hasta } = rangoDePeriodo(periodo);
    const repo = deps.rentasRepo(c.get("db"));
    // Solo lee tablas anteriores a la migracion 035: funciona contra la base sin migrar.
    const r = await repo.listReservasSinMovimiento(c.req.param("propertyId"), desde, hasta, 200);
    return c.json({ periodo, disponible: true, total: r.total, items: r.items }, 200);
  });

  app.get(revisionPath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const repo = deps.rentasRepo(c.get("db"));
    const r = await runWithSavepointFallback<Listado<MovimientoEnRevision>>({
      session: c.get("db"),
      primary: async () => ({ disponible: true, items: await repo.listMovimientosEnRevision(c.req.param("propertyId"), 200) }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, motivo: MOTIVO_NO_DISPONIBLE, items: [] }),
    });
    return c.json(r, 200);
  });

  app.post(revisadoPath, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const ocupacionId = c.req.param("ocupacionId");
    const repo = deps.rentasRepo(c.get("db"));
    const ok = await runWithSavepointFallback({
      session: c.get("db"),
      primary: () => repo.marcarMovimientoRevisado(propertyId, ocupacionId),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: () => {
        throw noDisponible();
      },
    });
    if (!ok) throw Errors.notFound("No hay un movimiento en revision para esta reserva.");
    await repo.registrarAuditoria({
      organizationId: c.get("organizationId"),
      actorUserId: c.get("userId"),
      action: "reserva.movimiento_revisado",
      entityType: "reserva",
      entityId: ocupacionId,
      campo: "requiere_revision",
      antes: "true",
      despues: "false",
    });
    return c.json({ ocupacionId, requiereRevision: false }, 200);
  });

  return app;
}
