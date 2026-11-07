// Ciclo operativo del pedido por la sucursal (F4b; migraciones 170, 171 y 172). Lado PANEL (staff con alcance a la sucursal). Rutas bajo `admin/ciclo` (no bajo
// `admin/orders/*`, para no heredar el middleware de sesion de admin-orders ni chocar con las rutas 501 del andamiaje del panel del operador):
//   POST /v1/restaurantes/:propertyId/admin/ciclo/pedidos/:orderId/aceptar     pending -> preparando con tiempo prometido editable; avisa al cliente
//   POST /v1/restaurantes/:propertyId/admin/ciclo/pedidos/:orderId/rechazar    pending -> cancelado con motivo de lista cerrada; avisa al cliente
//   POST /v1/restaurantes/:propertyId/admin/ciclo/pedidos/:orderId/salida      asigna repartidor y marca la SALIDA con hora real (092; con camino anterior si no esta)
//   POST /v1/restaurantes/:propertyId/admin/ciclo/pedidos/:orderId/entrega     marca la entrega con la hora real en que ocurrio (el chofer sigue usando su propia ruta)
//   GET  /v1/restaurantes/:propertyId/admin/ciclo/ratios?desde=&hasta=         tiempo real vs prometido, aceptacion/rechazo y encuesta (ratios de operacion)
//   GET|PUT /v1/restaurantes/:propertyId/admin/ciclo/encuesta/config           encuesta post-entrega (apagada por omision; PUT solo owner/admin)
//   GET|PUT /v1/restaurantes/:propertyId/admin/ciclo/recordatorios/config      recordatorios de pedidos sin aceptar (PUT solo owner/admin)
// Base SIN migrar: las lecturas responden `disponible: false` y las escrituras 503 (estado honesto, nunca un 500).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CicloAccesoError,
  CicloConflictoError,
  CicloNoDisponibleError,
  CicloNoEncontradoError,
  CicloValidacionError,
  MOTIVOS_RECHAZO,
  STAFF_INVITE_ROLES,
  aceptarPedido,
  esMotivoRechazo,
  obtenerRatiosOperacion,
  rechazarPedido,
  registrarEntrega,
  registrarSalida,
} from "@atiende/domain-restaurantes";
import type { CicloPedidoRepository, CicloServicioDeps, Order } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { dispatchWhatsAppVertical, triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion, assertOperadorPuede } from "./permisos-accion.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_MS = 24 * 60 * 60 * 1000;

function entero(valor: unknown, campo: string, min: number, max: number): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < min || valor > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return valor;
}
function booleano(valor: unknown, campo: string): boolean {
  if (typeof valor !== "boolean") throw Errors.validation(`${campo}: se esperaba true o false.`);
  return valor;
}
function fecha(valor: unknown, campo: string): Date {
  if (typeof valor !== "string" || Number.isNaN(new Date(valor).getTime())) throw Errors.validation(`${campo}: se esperaba una fecha ISO 8601 valida.`);
  return new Date(valor);
}

export function restaurantesAdminCicloPedidoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/ciclo";
  for (const path of [`${base}/pedidos/*`, `${base}/ratios`, `${base}/encuesta/config`, `${base}/recordatorios/config`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repoCiclo(c: Context<CoreAuthHonoEnv>): CicloPedidoRepository {
    if (!deps.cicloPedidoRepo) throw Errors.serviceUnavailable("El ciclo del pedido no está disponible en este despliegue.");
    return deps.cicloPedidoRepo(c.get("db"));
  }
  function servicioDeps(c: Context<CoreAuthHonoEnv>): CicloServicioDeps {
    return { repo: deps.restaurantesRepo(c.get("db")), ciclo: repoCiclo(c), db: c.get("db"), plantillasAprobadas: deps.env.whatsappApprovedTemplates ?? [] };
  }
  const esDuenoOAdmin = (rol: string | undefined): boolean => (STAFF_INVITE_ROLES as readonly string[]).includes(rol ?? "");

  /** Traduce los errores tipados del dominio: 403 sin permiso, 404, 409 el estado cambio, 422 regla de negocio, 503 base sin migrar. */
  function traducir(err: unknown): never {
    if (err instanceof CicloAccesoError) throw Errors.forbidden("No tienes permiso para esta acción en esta sucursal.");
    if (err instanceof CicloNoEncontradoError) throw Errors.notFound("Pedido no encontrado.");
    if (err instanceof CicloConflictoError) throw Errors.conflict("El pedido cambió de estado mientras se procesaba. Actualiza la vista e intenta de nuevo.");
    if (err instanceof CicloValidacionError) throw Errors.validation(err.message);
    if (err instanceof CicloNoDisponibleError) throw Errors.serviceUnavailable(err.message);
    throw err;
  }

  /** El pedido debe existir, ser de la organizacion y de la sucursal de la ruta (un pedido de otra sucursal es 404, igual que uno inexistente). */
  async function pedidoDeLaSucursal(c: Context<CoreAuthHonoEnv>): Promise<Order> {
    const orderId = c.req.param("orderId") ?? "";
    if (!UUID_RE.test(orderId)) throw Errors.validation("orderId: se esperaba un uuid.");
    const order = await deps.restaurantesRepo(c.get("db")).findOrderById(c.get("organizationId"), orderId);
    if (!order || order.propertyId !== c.req.param("propertyId")) throw Errors.notFound("Pedido no encontrado.");
    return order;
  }

  /** Envio inmediato del aviso al cliente (post-commit, en sesion de sistema): sin esto saldria hasta el siguiente barrido del despachador. */
  function despacharAvisos(c: Context<CoreAuthHonoEnv>): Promise<void> {
    return triggerRestaurantesWhatsAppDispatchInline(deps, c.get("db"), deps.restaurantesRepo(c.get("db"))).then(() => {
      c.get("postCommitTasks").push(() => dispatchWhatsAppVertical(deps, "restaurantes", 5).then(() => undefined));
    });
  }

  app.post(`${base}/pedidos/:orderId/aceptar`, async (c) => {
    assertAccion(c, "pedidos.gestionar");
    const order = await pedidoDeLaSucursal(c);
    const raw = await readJsonCapped<{ tiempoPrometidoMin?: unknown }>(c.req.raw, 2 * 1024);
    const tiempo = raw.tiempoPrometidoMin === undefined || raw.tiempoPrometidoMin === null ? undefined : entero(raw.tiempoPrometidoMin, "tiempoPrometidoMin", 5, 240);
    try {
      const r = await aceptarPedido(servicioDeps(c), { organizationId: c.get("organizationId"), orderId: order.id, ...(tiempo !== undefined ? { tiempoPrometidoMin: tiempo } : {}) });
      await despacharAvisos(c);
      logEvent(c, "info", "restaurantes_pedido_aceptado", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), orderId: order.id, tiempoPrometidoMin: r.tiempoPrometidoMin, resultado: r.resultado });
      return c.json(r);
    } catch (err) {
      return traducir(err);
    }
  });

  app.post(`${base}/pedidos/:orderId/rechazar`, async (c) => {
    assertAccion(c, "pedidos.cancelar");
    const order = await pedidoDeLaSucursal(c);
    await assertOperadorPuede(deps, c, order.propertyId, "cancelar");
    const raw = await readJsonCapped<{ motivo?: unknown; nota?: unknown }>(c.req.raw, 2 * 1024);
    if (!esMotivoRechazo(raw.motivo)) throw Errors.validation(`motivo: obligatorio; uno de ${MOTIVOS_RECHAZO.join(", ")}.`);
    if (raw.nota !== undefined && raw.nota !== null && (typeof raw.nota !== "string" || raw.nota.length > 240)) throw Errors.validation("nota: se esperaba un texto de hasta 240 caracteres.");
    try {
      const r = await rechazarPedido(servicioDeps(c), { organizationId: c.get("organizationId"), orderId: order.id, motivo: raw.motivo, nota: (raw.nota as string | null | undefined) ?? null });
      await despacharAvisos(c);
      logEvent(c, "info", "restaurantes_pedido_rechazado", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), orderId: order.id, motivo: r.motivo, resultado: r.resultado });
      return c.json(r);
    } catch (err) {
      return traducir(err);
    }
  });

  app.post(`${base}/pedidos/:orderId/salida`, async (c) => {
    assertAccion(c, "viajes.despachar");
    const order = await pedidoDeLaSucursal(c);
    await assertOperadorPuede(deps, c, order.propertyId, "despachar");
    const raw = await readJsonCapped<{ repartidorId?: unknown; etaMin?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof raw.repartidorId !== "string" || !UUID_RE.test(raw.repartidorId)) throw Errors.validation("repartidorId: se esperaba un uuid.");
    const eta = raw.etaMin === undefined || raw.etaMin === null ? undefined : entero(raw.etaMin, "etaMin", 5, 240);
    // El repartidor debe ser de esta organizacion (misma comprobacion que `assign-repartidor`): la funcion SQL tambien lo exige, pero asi el camino anterior no lo omite.
    const repartidores = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(c.get("organizationId"), "repartidor");
    if (!repartidores.some((m) => m.userId === raw.repartidorId)) throw Errors.validation("repartidorId no corresponde a un repartidor de esta organización.");
    try {
      const r = await registrarSalida(servicioDeps(c), { organizationId: c.get("organizationId"), orderId: order.id, repartidorId: raw.repartidorId, ...(eta !== undefined ? { etaMin: eta } : {}) });
      await despacharAvisos(c);
      logEvent(c, "info", "restaurantes_pedido_salida", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), orderId: order.id, repartidorId: raw.repartidorId, resultado: r.resultado, horaRealRegistrada: r.horaRealRegistrada });
      return c.json(r);
    } catch (err) {
      return traducir(err);
    }
  });

  app.post(`${base}/pedidos/:orderId/entrega`, async (c) => {
    assertAccion(c, "viajes.despachar");
    const order = await pedidoDeLaSucursal(c);
    await assertOperadorPuede(deps, c, order.propertyId, "despachar");
    const raw = await readJsonCapped<{ ocurrioEn?: unknown; cobradoMonto?: unknown }>(c.req.raw, 2 * 1024);
    const ocurrioEn = raw.ocurrioEn === undefined || raw.ocurrioEn === null ? null : fecha(raw.ocurrioEn, "ocurrioEn");
    if (raw.cobradoMonto !== undefined && raw.cobradoMonto !== null && (typeof raw.cobradoMonto !== "number" || !Number.isFinite(raw.cobradoMonto) || raw.cobradoMonto < 0 || raw.cobradoMonto > 100000)) {
      throw Errors.validation("cobradoMonto: se esperaba un numero entre 0 y 100000.");
    }
    try {
      const r = await registrarEntrega(servicioDeps(c), { organizationId: c.get("organizationId"), orderId: order.id, ocurrioEn, cobradoMonto: (raw.cobradoMonto as number | null | undefined) ?? null });
      await despacharAvisos(c);
      logEvent(c, "info", "restaurantes_pedido_entrega_staff", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), orderId: order.id, resultado: r.resultado });
      return c.json(r);
    } catch (err) {
      return traducir(err);
    }
  });

  app.get(`${base}/ratios`, async (c) => {
    assertAccion(c, "turno.ver");
    const hasta = c.req.query("hasta") ? fecha(c.req.query("hasta"), "hasta") : new Date();
    const desde = c.req.query("desde") ? fecha(c.req.query("desde"), "desde") : new Date(hasta.getTime() - 7 * DIA_MS);
    if (desde >= hasta) throw Errors.validation("desde debe ser anterior a hasta.");
    if (hasta.getTime() - desde.getTime() > 63 * DIA_MS) throw Errors.validation("El rango máximo es de 63 días.");
    try {
      return c.json(await obtenerRatiosOperacion({ ciclo: repoCiclo(c) }, c.get("organizationId"), c.req.param("propertyId"), desde, hasta));
    } catch (err) {
      return traducir(err);
    }
  });

  app.get(`${base}/encuesta/config`, async (c) => {
    assertAccion(c, "turno.ver");
    const r = await repoCiclo(c).leerConfigEncuesta(c.get("organizationId"), c.req.param("propertyId"));
    return c.json({ disponible: r.disponible, ...r.valor });
  });
  app.put(`${base}/encuesta/config`, async (c) => {
    if (!esDuenoOAdmin(c.get("verticalRole"))) throw Errors.forbidden("Solo el dueño o un administrador configura la encuesta.");
    // Sin enlace de resena (P1-2 de la revision de #713): la encuesta no ofrece resenas a nadie, asi que ya no hay campo `linkResena`.
    const raw = await readJsonCapped<{ habilitada?: unknown; linkResena?: unknown }>(c.req.raw, 2 * 1024);
    if (raw.linkResena !== undefined) throw Errors.validation("linkResena: la encuesta ya no ofrece enlaces de reseña.");
    const habilitada = booleano(raw.habilitada, "habilitada");
    try {
      await repoCiclo(c).guardarConfigEncuesta(c.get("organizationId"), c.req.param("propertyId"), { habilitada });
    } catch (err) {
      return traducir(err);
    }
    logEvent(c, "info", "restaurantes_encuesta_config_guardada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), propertyId: c.req.param("propertyId"), habilitada });
    return c.json({ ok: true });
  });

  app.get(`${base}/recordatorios/config`, async (c) => {
    assertAccion(c, "turno.ver");
    const r = await repoCiclo(c).leerConfigRecordatorio(c.get("organizationId"), c.req.param("propertyId"));
    return c.json({ disponible: r.disponible, ...r.valor });
  });
  app.put(`${base}/recordatorios/config`, async (c) => {
    if (!esDuenoOAdmin(c.get("verticalRole"))) throw Errors.forbidden("Solo el dueño o un administrador configura los recordatorios.");
    const raw = await readJsonCapped<{ habilitado?: unknown; primeroMin?: unknown; repetirMin?: unknown; maximo?: unknown }>(c.req.raw, 2 * 1024);
    const config = {
      habilitado: booleano(raw.habilitado, "habilitado"),
      primeroMin: entero(raw.primeroMin, "primeroMin", 3, 120),
      repetirMin: entero(raw.repetirMin, "repetirMin", 3, 120),
      maximo: entero(raw.maximo, "maximo", 1, 6),
    };
    try {
      await repoCiclo(c).guardarConfigRecordatorio(c.get("organizationId"), c.req.param("propertyId"), config);
    } catch (err) {
      return traducir(err);
    }
    logEvent(c, "info", "restaurantes_recordatorios_config_guardada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), propertyId: c.req.param("propertyId"), ...config });
    return c.json({ ok: true });
  });

  return app;
}
