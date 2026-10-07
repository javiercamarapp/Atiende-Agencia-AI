// Autopiloto del ciclo del pedido (migracion 050). Lado PANEL (staff con alcance a la sucursal):
//   GET  /v1/restaurantes/:propertyId/admin/autopiloto/solicitudes?estado=pendiente|resuelta   aprobaciones "Por aprobar" (pedido grande, cancelacion, compensacion)
//   POST /v1/restaurantes/:propertyId/admin/autopiloto/solicitudes/:id/resolver                aprobar/rechazar/cancelar/mantener/compensar con UN clic (idempotente)
//   GET  /v1/restaurantes/:propertyId/admin/autopiloto/config                                 reglas por sucursal (valores por omision seguros) y estado honesto de plantillas/POS
//   PUT  /v1/restaurantes/:propertyId/admin/autopiloto/config                                 solo owner/admin
//   POST /v1/restaurantes/:propertyId/admin/autopiloto/agotado                                "Agotado hasta manana" (se repone al cambiar el dia de la sucursal)
//   GET  /v1/restaurantes/:propertyId/admin/autopiloto/tiempo?canal=                          tiempo prometido hoy (aprendido o texto fijo del dueno)
//   GET  /v1/restaurantes/:propertyId/admin/autopiloto/pedidos/:orderId/historial             historial de transiciones del pedido (order_status_events)
// Base SIN migrar: las lecturas responden `disponible: false` con listas vacias y las escrituras 503 (estado honesto, nunca un 500).
// Las comandas al POS de lo recien aprobado se encolan DESPUES del commit, en sesion de sistema (la funcion SQL es solo-sistema).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AutopilotoAccesoError,
  AutopilotoValidacionError,
  DECISIONES_POR_TIPO,
  MANAGER_ROLES,
  PLANTILLAS_AUTOPILOTO,
  STAFF_INVITE_ROLES,
  diaDeNegocio,
  estimarTiempoSucursal,
  resolverSolicitudAprobacion,
  sumarDiasFecha,
} from "@atiende/domain-restaurantes";
import type { AutopilotoRepository, SolicitudDecision, SolicitudTipo } from "@atiende/domain-restaurantes";
import { encolarComandasDePromovidos } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { dispatchWhatsAppVertical } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { softRestaurantComandaDeps, softRestaurantPortFor } from "./softrestaurant-wiring.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolverBody {
  readonly decision?: unknown;
  readonly motivo?: unknown;
  readonly valor?: unknown;
  readonly indices?: unknown;
}

interface ConfigBody {
  readonly cancelacionAuto?: unknown;
  readonly aceptacionAuto?: unknown;
  readonly aprobacionMinutos?: unknown;
  readonly handoffRegresoMinutos?: unknown;
  readonly noRecogidoMinutos?: unknown;
  readonly completadoHoras?: unknown;
  readonly compensacionTopePct?: unknown;
  readonly saturacionUmbral1?: unknown;
  readonly saturacionUmbral2?: unknown;
  readonly saturacionExtraMinutos?: unknown;
  /** Regla de TODA la organizacion (no de la sucursal): el agente de WhatsApp gestiona las cancelaciones. Ausente = no se toca. */
  readonly cancelacionAgente?: unknown;
}

function entero(valor: unknown, campo: string, min: number, max: number): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < min || valor > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return valor;
}

function enteroONulo(valor: unknown, campo: string, min: number, max: number): number | null {
  if (valor === null || valor === undefined) return null;
  return entero(valor, campo, min, max);
}

function booleano(valor: unknown, campo: string): boolean {
  if (typeof valor !== "boolean") throw Errors.validation(`${campo}: se esperaba true o false.`);
  return valor;
}

export function restaurantesAutopilotoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/autopiloto";
  for (const path of [`${base}/solicitudes`, `${base}/solicitudes/*`, `${base}/config`, `${base}/agotado`, `${base}/tiempo`, `${base}/pedidos/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repoAuto(c: Context<CoreAuthHonoEnv>): AutopilotoRepository {
    if (!deps.autopilotoRepo) throw Errors.serviceUnavailable("El autopiloto no está disponible en este despliegue.");
    return deps.autopilotoRepo(c.get("db"));
  }

  /** Traduce los errores de regla de la base: 403 sin acceso, 422 regla de negocio. */
  // QA R2 seguridad-03: reponer producto (pedido de $0 a cocina) y emitir un codigo de descuento mueven dinero: solo owner/admin. La base
  // (solicitud_resolver, 075) lo exige tambien; aqui se rechaza antes con un mensaje claro y la lista de decisiones se acota al rol para
  // que el panel no ofrezca botones que el servidor negaria.
  const DECISIONES_DE_DINERO: readonly SolicitudDecision[] = ["reponer_producto", "descuento_proximo"];
  const esDuenoOAdmin = (rol: string | undefined): boolean => (STAFF_INVITE_ROLES as readonly string[]).includes(rol ?? "");
  const decisionesParaRol = (tipo: SolicitudTipo, rol: string | undefined): readonly SolicitudDecision[] =>
    esDuenoOAdmin(rol) ? DECISIONES_POR_TIPO[tipo] : DECISIONES_POR_TIPO[tipo].filter((d) => !DECISIONES_DE_DINERO.includes(d));

  function traducir(err: unknown): never {
    if (err instanceof AutopilotoAccesoError) throw Errors.forbidden("No tienes acceso a esta solicitud.");
    if (err instanceof AutopilotoValidacionError) throw Errors.validation(err.message);
    throw err;
  }

  app.get(`${base}/solicitudes`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const estado = c.req.query("estado") ?? "pendiente";
    if (estado !== "pendiente" && estado !== "resuelta") throw Errors.validation("estado debe ser «pendiente» o «resuelta».");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const r = await repoAuto(c).listarSolicitudes(organizationId, { propertyIds: scope, estado, limite: estado === "pendiente" ? 100 : 50 });
    return c.json({
      disponible: r.disponible,
      solicitudes: r.valor.map((s) => ({ ...s, decisionesPosibles: decisionesParaRol(s.tipo, c.get("verticalRole")) })),
    });
  });

  app.post(`${base}/solicitudes/:id/resolver`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const solicitudId = c.req.param("id") ?? "";
    if (!UUID_RE.test(solicitudId)) throw Errors.validation("id de solicitud inválido.");
    const raw = await readJsonCapped<ResolverBody>(c.req.raw, 4 * 1024);
    if (typeof raw.decision !== "string" || !Object.values(DECISIONES_POR_TIPO).some((l) => (l as readonly string[]).includes(raw.decision as string))) throw Errors.validation("decision: valor desconocido.");
    if (raw.motivo !== undefined && raw.motivo !== null && (typeof raw.motivo !== "string" || raw.motivo.length > 200)) throw Errors.validation("motivo: texto de hasta 200 caracteres.");
    if (DECISIONES_DE_DINERO.includes(raw.decision as SolicitudDecision) && !esDuenoOAdmin(c.get("verticalRole"))) {
      throw Errors.forbidden("Reponer producto o dar un descuento lo decide un dueño o administrador.");
    }
    const valor = raw.valor === undefined || raw.valor === null ? null : entero(raw.valor, "valor", 1, 100);
    let indices: number[] | null = null;
    if (raw.indices !== undefined && raw.indices !== null) {
      if (!Array.isArray(raw.indices) || raw.indices.length === 0 || raw.indices.length > 20 || !raw.indices.every((i) => Number.isInteger(i) && i >= 0 && i < 1000)) throw Errors.validation("indices: lista de 1 a 20 enteros.");
      indices = raw.indices as number[];
    }
    const repo = deps.restaurantesRepo(c.get("db"));
    const auto = repoAuto(c);
    // Estado previo (solo para la bitacora). El alcance real lo exige la base (42501 -> 403): una solicitud ajena o ya resuelta no aparece aqui y la
    // base decide (ajena = 403, ya resuelta = respuesta idempotente `aplicado: false`).
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const visibles = await auto.listarSolicitudes(organizationId, { propertyIds: scope, estado: "pendiente", limite: 200 });
    const previa = visibles.valor.find((s) => s.id === solicitudId);
    try {
      const r = await resolverSolicitudAprobacion(
        {
          auto,
          repo,
          db: c.get("db"),
          // La comanda al POS solo la puede encolar la sesion de sistema: se hace DESPUES del commit y es idempotente por pedido.
          encolarComandas: async (orders) => {
            c.get("postCommitTasks").push(async () => {
              await deps.engine.withAppSession({ userId: null }, (db) => encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, deps.restaurantesRepo(db)), orders));
            });
          },
        },
        { organizationId, solicitudId, decision: raw.decision as SolicitudDecision, motivo: (raw.motivo as string | null | undefined) ?? null, valor, indices },
      );
      if (!r) throw Errors.serviceUnavailable("Las aprobaciones todavía no están disponibles en esta base de datos (falta aplicar la migración 050).");
      if (r.resultado.aplicado) {
        // Los WhatsApp encolados salen DESPUES del commit, en sesion de sistema (mismo patron que el cambio de estado).
        c.get("postCommitTasks").push(() => dispatchWhatsAppVertical(deps, "restaurantes", 5).then(() => undefined));
        if (r.resultado.orderId) {
          await repo.registrarAuditoria({
            organizationId,
            actorUserId: c.get("userId"),
            action: `autopiloto.${r.resultado.tipo}.${r.resultado.decision ?? raw.decision}`,
            entityType: "pedido",
            entityId: r.resultado.orderId,
            campo: "decision",
            antes: previa?.pedido?.status ?? null,
            despues: r.resultado.estadoPedido ?? String(r.resultado.decision),
          });
        }
      }
      logEvent(c, "info", "restaurantes_autopiloto_solicitud_resuelta", {
        actorUserId: c.get("userId"), organizationId, solicitudId, tipo: r.resultado.tipo, decision: r.resultado.decision, aplicado: r.resultado.aplicado, efectos: r.efectos,
      });
      return c.json({ aplicado: r.resultado.aplicado, tipo: r.resultado.tipo, decision: r.resultado.decision, estadoPedido: r.resultado.estadoPedido, codigoDescuento: r.resultado.codigoDescuento, reposicionOrderId: r.resultado.reposicionOrderId, efectos: r.efectos });
    } catch (err) {
      return traducir(err);
    }
  });

  app.get(`${base}/config`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    const r = await repoAuto(c).leerConfig(organizationId, propertyId);
    const org = await repoAuto(c).leerConfigOrg(organizationId);
    const aprobadas = new Set(deps.env.whatsappApprovedTemplates ?? []);
    const plantillas = Object.values(PLANTILLAS_AUTOPILOTO).map((p) => ({ nombre: p.name, aprobada: aprobadas.has(p.name) }));
    return c.json({
      disponible: r.disponible,
      config: r.valor,
      org: org.valor,
      // Estados honestos: sin plantilla aprobada el aviso solo sale dentro de la ventana de 24 h; sin POS real no hay avance desde el POS.
      plantillas,
      posReal: softRestaurantPortFor(deps).esReal,
    });
  });

  app.put(`${base}/config`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    const raw = await readJsonCapped<ConfigBody>(c.req.raw, 4 * 1024);
    const config = {
      cancelacionAuto: booleano(raw.cancelacionAuto, "cancelacionAuto"),
      aceptacionAuto: booleano(raw.aceptacionAuto, "aceptacionAuto"),
      aprobacionMinutos: entero(raw.aprobacionMinutos, "aprobacionMinutos", 1, 240),
      handoffRegresoMinutos: entero(raw.handoffRegresoMinutos, "handoffRegresoMinutos", 1, 240),
      noRecogidoMinutos: entero(raw.noRecogidoMinutos, "noRecogidoMinutos", 5, 720),
      completadoHoras: entero(raw.completadoHoras, "completadoHoras", 1, 72),
      compensacionTopePct: entero(raw.compensacionTopePct, "compensacionTopePct", 1, 100),
      saturacionUmbral1: enteroONulo(raw.saturacionUmbral1, "saturacionUmbral1", 1, 500),
      saturacionUmbral2: enteroONulo(raw.saturacionUmbral2, "saturacionUmbral2", 1, 500),
      saturacionExtraMinutos: entero(raw.saturacionExtraMinutos, "saturacionExtraMinutos", 5, 120),
    };
    if (config.saturacionUmbral2 !== null && (config.saturacionUmbral1 === null || config.saturacionUmbral2 <= config.saturacionUmbral1)) {
      throw Errors.validation("saturacionUmbral2 debe ser mayor que saturacionUmbral1.");
    }
    try {
      const antes = await repoAuto(c).leerConfig(organizationId, propertyId);
      const r = await repoAuto(c).guardarConfig(organizationId, propertyId, config);
      if (!r.disponible) throw Errors.serviceUnavailable("El autopiloto todavía no está disponible en esta base de datos (falta aplicar la migración 050).");
      let org = (await repoAuto(c).leerConfigOrg(organizationId)).valor;
      if (raw.cancelacionAgente !== undefined) {
        const cancelacionAgente = booleano(raw.cancelacionAgente, "cancelacionAgente");
        if (cancelacionAgente !== org.cancelacionAgente) {
          // Regla de toda la organizacion: la base exige owner/admin sin restriccion de sucursales (42501 -> 403).
          const g = await repoAuto(c).guardarConfigOrg(organizationId, { cancelacionAgente });
          if (!g.disponible) throw Errors.serviceUnavailable("El autopiloto todavía no está disponible en esta base de datos (falta aplicar la migración 050).");
          await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
            organizationId, actorUserId: c.get("userId"), action: "autopiloto.cancelacion_agente_actualizada", entityType: "configuracion", entityId: organizationId,
            campo: "cancelacion_agente", antes: String(org.cancelacionAgente), despues: String(cancelacionAgente),
          });
          org = { cancelacionAgente };
        }
      }
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId, actorUserId: c.get("userId"), action: "autopiloto.config_actualizada", entityType: "configuracion", entityId: propertyId,
        campo: "autopiloto", antes: JSON.stringify(antes.valor).slice(0, 480), despues: JSON.stringify(config).slice(0, 480),
      });
      logEvent(c, "info", "restaurantes_autopiloto_config_guardada", { actorUserId: c.get("userId"), organizationId, propertyId });
      return c.json({ ok: true, config: { ...config, configurada: true }, org });
    } catch (err) {
      return traducir(err);
    }
  });

  app.post(`${base}/agotado`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    const raw = await readJsonCapped<{ productId?: unknown }>(c.req.raw, 1024);
    if (typeof raw.productId !== "string" || !UUID_RE.test(raw.productId)) throw Errors.validation("productId inválido.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const { zonaHoraria } = await repo.findBranchZonaHoraria(propertyId);
    // QA R2 automatizacion-02: "hasta manana" es el dia de NEGOCIO + 1, no el calendario: PM cierra a la 01:00, asi que a las 00:30 del domingo
    // todavia es el turno del sabado y el producto debe volver el domingo (no el lunes). Sin horario (o sin turnos que cruzan) el dia de negocio
    // es el calendario, como siempre.
    const policy = await repo.findBranchPolicy(propertyId);
    const hoy = diaDeNegocio(new Date(), zonaHoraria, policy.horario);
    const hasta = sumarDiasFecha(hoy, 1);
    // Respaldo para la base sin la 076: la funcion de la 050 exige `hasta` > fecha calendario de hoy.
    const hastaCalendario = sumarDiasFecha(diaDeNegocio(new Date(), zonaHoraria, null), 1);
    try {
      const r = await repoAuto(c).marcarAgotado(organizationId, propertyId, raw.productId, hasta, hastaCalendario);
      if (!r.disponible) throw Errors.serviceUnavailable("«Agotado hasta mañana» todavía no está disponible en esta base de datos (falta aplicar la migración 050).");
      if (!r.aplicado) throw Errors.notFound("El producto no está dado de alta en esta sucursal.");
      await repo.registrarAuditoria({
        organizationId, actorUserId: c.get("userId"), action: "producto.agotado_hasta_manana", entityType: "producto", entityId: raw.productId,
        campo: "agotado_hasta", antes: null, despues: hasta,
      });
      return c.json({ ok: true, agotadoHasta: hasta, zonaHoraria: zonaHoraria ?? "America/Mexico_City" });
    } catch (err) {
      return traducir(err);
    }
  });

  app.get(`${base}/tiempo`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    const canal = c.req.query("canal") ?? "domicilio";
    if (canal !== "domicilio" && canal !== "recoger") throw Errors.validation("canal debe ser «domicilio» o «recoger».");
    const t = await estimarTiempoSucursal({ auto: repoAuto(c), repo: deps.restaurantesRepo(c.get("db")) }, { organizationId, propertyId, canal, ahora: new Date() });
    return c.json({ tiempo: t });
  });

  app.get(`${base}/pedidos/:orderId/historial`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const orderId = c.req.param("orderId") ?? "";
    if (!UUID_RE.test(orderId)) throw Errors.validation("orderId inválido.");
    const order = await deps.restaurantesRepo(c.get("db")).findOrderById(organizationId, orderId);
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(order.propertyId)) throw Errors.forbidden("No tienes acceso a este pedido.");
    const r = await repoAuto(c).historialEstados(organizationId, orderId);
    return c.json({ disponible: r.disponible, eventos: r.valor });
  });

  return app;
}
