// Cierre del dia y resumen semanal por sucursal (R-42, migracion 041). Lado PANEL, solo owner/admin (la policy y la funcion SQL
// exigen lo mismo):
//   GET  /v1/restaurantes/:propertyId/admin/cierres?tipo=dia|semana&limite=N   cierres ya generados + periodos terminados SIN cierre
//   POST /v1/restaurantes/:propertyId/admin/cierres/generar   { tipo, fecha }  genera el cierre de un periodo TERMINADO (idempotente)
//
// Dia = dia calendario en la zona horaria de la SUCURSAL; semana = lunes a domingo. Un cierre ya generado NO se recalcula (devuelve el
// mismo, `estado: "existente"`). Sin PII: todo es agregado. Base SIN migrar: la lectura responde `disponible: false` con listas vacias
// y la escritura 503 (estado honesto, nunca un 500). La automatizacion diaria vive en cierres-interno.ts (endpoint interno idempotente).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  STAFF_INVITE_ROLES,
  CIERRE_TIPOS,
  diaLocalSucursal,
  diaSemanaIso,
  fechaNegocioValida,
  lunesDeSemana,
  notificarCierreCreado,
  sumarDiasFecha,
  variacionPct,
} from "@atiende/domain-restaurantes";
import type { CierreReporte, CierreRepository, CierreTipo } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

export const CIERRES_LIMITE_POR_DEFECTO: Readonly<Record<CierreTipo, number>> = { dia: 14, semana: 8 };
export const CIERRES_LIMITE_MAX = 60;
/** Cuantos periodos terminados hacia atras se ofrecen como "pendientes de generar". */
export const CIERRES_PENDIENTES_VENTANA: Readonly<Record<CierreTipo, number>> = { dia: 7, semana: 4 };

export function serializarCierre(r: CierreReporte) {
  const d = r.datos;
  return {
    id: r.id,
    tipo: r.tipo,
    fechaInicio: r.fechaInicio,
    fechaFin: r.fechaFin,
    zonaHoraria: r.zonaHoraria,
    generadoPor: r.generadoPor,
    generadoAt: r.generadoAt,
    pedidos: d.pedidos,
    ventasCentavos: d.ventasCentavos,
    ticketPromedioCentavos: d.ticketPromedioCentavos,
    conProblema: d.conProblema,
    cancelados: d.cancelados,
    canceladosCentavos: d.canceladosCentavos,
    noRecogidos: d.noRecogidos,
    cancelacionPct: d.cancelacionPct,
    porCanal: d.porCanal,
    tiempos: d.tiempos,
    comparativo: d.comparativo
      ? {
          ...d.comparativo,
          variacionPedidosPct: variacionPct(d.pedidos, d.comparativo.pedidos),
          variacionVentasPct: variacionPct(d.ventasCentavos, d.comparativo.ventasCentavos),
        }
      : null,
    porDia: d.porDia,
  };
}

/** Periodos YA terminados (hoy no) de los ultimos `ventana` que aun no tienen cierre. Del mas reciente al mas viejo. */
export function periodosPendientes(tipo: CierreTipo, hoyLocal: string, existentes: ReadonlySet<string>, ventana: number): string[] {
  const out: string[] = [];
  if (tipo === "dia") {
    for (let k = 1; k <= ventana; k++) {
      const f = sumarDiasFecha(hoyLocal, -k);
      if (!existentes.has(f)) out.push(f);
    }
    return out;
  }
  // semana: la semana cuyo domingo es anterior a hoy. El lunes de esta semana en curso NO termino.
  let lunes = sumarDiasFecha(lunesDeSemana(hoyLocal), -7);
  for (let k = 0; k < ventana; k++) {
    if (!existentes.has(lunes)) out.push(lunes);
    lunes = sumarDiasFecha(lunes, -7);
  }
  return out;
}

export function restaurantesCierresRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/cierres";
  for (const path of [base, `${base}/generar`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repo(c: Context<CoreAuthHonoEnv>): CierreRepository {
    if (!deps.cierreRepo) throw Errors.serviceUnavailable("Los cierres del día no están disponibles en este despliegue.");
    return deps.cierreRepo(c.get("db"));
  }

  async function resolverSucursal(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    const { zonaHoraria } = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId);
    const { fecha: hoy, zonaHoraria: zona } = diaLocalSucursal(new Date(), zonaHoraria);
    return { organizationId, propertyId, hoy, zona };
  }

  function leerTipo(valor: unknown): CierreTipo {
    if (typeof valor !== "string" || !(CIERRE_TIPOS as readonly string[]).includes(valor)) throw Errors.validation("tipo debe ser «dia» o «semana».");
    return valor as CierreTipo;
  }

  app.get(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId, hoy, zona } = await resolverSucursal(c);
    const tipo = leerTipo(c.req.query("tipo") ?? "dia");
    const qLimite = c.req.query("limite");
    let limite = CIERRES_LIMITE_POR_DEFECTO[tipo];
    if (qLimite !== undefined) {
      if (!/^\d{1,3}$/.test(qLimite) || Number(qLimite) < 1 || Number(qLimite) > CIERRES_LIMITE_MAX) throw Errors.validation(`limite debe ser un entero entre 1 y ${CIERRES_LIMITE_MAX}.`);
      limite = Number(qLimite);
    }
    const lectura = await repo(c).listar(organizationId, propertyId, tipo, limite);
    const existentes = new Set(lectura.valor.map((r) => r.fechaInicio));
    return c.json({
      disponible: lectura.disponible,
      tipo,
      zonaHoraria: zona,
      hoy,
      cierres: lectura.valor.map(serializarCierre),
      // Sin la migracion no se sabe que hay generado: no se ofrece generar (el POST respondería 503).
      pendientes: lectura.disponible ? periodosPendientes(tipo, hoy, existentes, CIERRES_PENDIENTES_VENTANA[tipo]) : [],
    });
  });

  app.post(`${base}/generar`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId, hoy } = await resolverSucursal(c);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    const tipo = leerTipo(raw.tipo);
    const fecha = raw.fecha;
    if (typeof fecha !== "string" || !fechaNegocioValida(fecha)) throw Errors.validation("fecha debe ser YYYY-MM-DD.");
    if (tipo === "semana" && diaSemanaIso(fecha) !== 1) throw Errors.validation("La semana empieza en lunes: manda la fecha del lunes.");
    const fin = tipo === "dia" ? fecha : sumarDiasFecha(fecha, 6);
    if (fin >= hoy) throw Errors.validation("Solo se cierra un periodo que ya terminó en la zona horaria de la sucursal.");

    const resultado = await repo(c).generar(organizationId, propertyId, tipo, fecha);
    if (resultado.estado === "no_disponible") throw Errors.serviceUnavailable("Los cierres del día aún no están activos en este negocio (falta la actualización de base de datos).");
    if (resultado.estado === "periodo_abierto") throw Errors.validation("El turno de ese día todavía no termina: el cierre se puede generar cuando cierre la sucursal.");
    if (resultado.estado === "sin_actividad") throw Errors.serviceUnavailable("No se pudo generar el cierre.");

    if (resultado.estado === "creado") {
      logEvent(c, "info", "restaurantes_admin_cierre_generado", { actorUserId: c.get("userId"), organizationId, propertyId, tipo, fecha });
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: tipo === "dia" ? "cierre.dia_generado" : "cierre.semana_generada",
        entityType: "configuracion",
        entityId: propertyId,
        campo: `cierre_${tipo}`,
        antes: null,
        despues: fecha,
      });
      // Aviso in-app solo cuando ESTA llamada creo el cierre (best-effort: SAVEPOINT dentro de emitirNotificacion).
      await notificarCierreCreado(c.get("db"), organizationId, propertyId, resultado.reporte);
    }
    return c.json({ estado: resultado.estado, cierre: serializarCierre(resultado.reporte) }, resultado.estado === "creado" ? 201 : 200);
  });

  return app;
}
