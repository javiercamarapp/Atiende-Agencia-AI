// D-27: "Verificar en el SAT" -- consulta el estatus de UN CFDI ante el servicio PUBLICO ConsultaCFDIService y lo registra.
//
//  POST /despachos/:propertyId/cfdi/:invoiceId/verificar-estatus-sat   (rol de escritura de cartera + limite de frecuencia)
//
// Fail-safe: si el SAT no responde (timeout, red, HTTP, XML ilegible) la ruta contesta 200 con `consultado: false` y el CFDI conserva
// su estado (jamas pasa a 'vigente' por error). Un CFDI que pasa de otro estado a 'cancelado' emite UNA vez
// `despachos.cfdi.cancelado` (clave = id del CFDI, la misma que usa el cron semanal: no se avisa dos veces). Un CFDI ya cancelado no
// se consulta de nuevo (el estado es terminal). Compatible con la base sin migrar: la escritura usa la funcion de la migracion 018
// con SAVEPOINT; sin ella responde 503 honesto.
import { Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { ConsultaCfdiSatSoap, EstadoSatInvalidoError, EstadoSatNoDisponibleError, GESTIONAR_CARTERA_ROLES, InvoiceNoEncontradoError } from "@atiende/domain-despachos";
import { emitirNotificacion } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

/** Por usuario: 20 verificaciones por 5 minutos (cada una es una llamada al SAT). */
const VERIFICAR_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;

export function despachosCfdiEstatusSatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const sat = deps.consultaCfdiSat ?? new ConsultaCfdiSatSoap();

  // SIN `app.use` propio a proposito: `despachosCfdiRoutes` (cfdi.ts, montado ANTES en despachos.ts) ya registra
  // `authMiddleware + dbSession + requirePropertyMembership` sobre `/despachos/:propertyId/cfdi/*`, que cubre esta ruta; repetirlo
  // abriria una segunda transaccion por request. Cubierto por la prueba de 401 sin token y de property ajena.

  app.post("/despachos/:propertyId/cfdi/:invoiceId/verificar-estatus-sat", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const db = c.get("db");
    const repo = deps.despachosRepo(db);
    const propertyId = c.req.param("propertyId");
    const invoiceId = c.req.param("invoiceId");

    const invoice = await repo.findInvoice(propertyId, invoiceId);
    if (!invoice) throw Errors.notFound("CFDI no encontrado.");
    const estadoAnterior = invoice.estadoSat ?? "pendiente";
    if (estadoAnterior === "cancelado") {
      return c.json({ consultado: false, motivo: "ya_cancelado", estadoSat: estadoAnterior, estadoSatVerificadoEn: invoice.estadoSatVerificadoEn ?? null, esCancelable: null, estatusCancelacion: null });
    }

    if (!(await rateLimit(`despachos:cfdi-estatus-sat:${c.get("userId")}`, VERIFICAR_RATE_LIMIT.max, VERIFICAR_RATE_LIMIT.windowMs, { category: "despachos:cfdi-estatus-sat" }))) throw Errors.tooManyRequests("Demasiadas verificaciones en el SAT. Intenta de nuevo en unos minutos.");

    const consulta = await sat.consultar({ rfcEmisor: invoice.rfcEmisor, rfcReceptor: invoice.rfcReceptor, total: invoice.total, folioFiscal: invoice.folioFiscal });
    if (!consulta.consultado) {
      return c.json({ consultado: false, motivo: consulta.motivo ?? "respuesta_invalida", estadoSat: estadoAnterior, estadoSatVerificadoEn: invoice.estadoSatVerificadoEn ?? null, esCancelable: null, estatusCancelacion: null });
    }

    let cancelacionEnProcesoNueva = false;
    try {
      ({ cancelacionEnProcesoNueva } = await repo.registrarDetalleSatInvoice(propertyId, invoiceId, consulta.estado, {
        esCancelable: consulta.esCancelable,
        estatusCancelacion: consulta.estatusCancelacion,
        codigoEstatus: consulta.codigoEstatus,
        validacionEfos: consulta.validacionEfos,
      }));
    } catch (err) {
      if (err instanceof InvoiceNoEncontradoError) throw Errors.notFound("CFDI no encontrado.");
      if (err instanceof EstadoSatInvalidoError) throw Errors.conflict(err.message);
      if (err instanceof EstadoSatNoDisponibleError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
    if (consulta.estado === "cancelado") {
      await emitirNotificacion(db, { evento: "despachos.cfdi.cancelado", organizationId: invoice.organizationId, propertyId, clave: invoice.id, entidadTipo: "invoice", entidadId: invoice.id });
    }
    if (consulta.estado !== "cancelado" && cancelacionEnProcesoNueva) {
      await emitirNotificacion(db, { evento: "despachos.cfdi.cancelacion_en_proceso", organizationId: invoice.organizationId, propertyId, clave: invoice.id, entidadTipo: "invoice", entidadId: invoice.id });
    }
    const actualizado = await repo.findInvoice(propertyId, invoiceId);
    return c.json({ consultado: true, estadoSat: consulta.estado, estadoSatVerificadoEn: actualizado?.estadoSatVerificadoEn ?? null, esCancelable: consulta.esCancelable, estatusCancelacion: consulta.estatusCancelacion, codigoEstatus: consulta.codigoEstatus, validacionEfos: consulta.validacionEfos });
  });

  return app;
}
