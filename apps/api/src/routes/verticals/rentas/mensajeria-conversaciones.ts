// Fase 7 -- /rentas/:propertyId/unidades/:unidadId/conversaciones: abre/lista un hilo
// de mensajería con un huésped para una unidad+canal, y expone sus mensajes. Mismo
// patrón de sesión de staff que reservas.ts/bloqueos.ts (authMiddleware + dbSession +
// requirePropertyMembership), con `assertVerticalRole(MENSAJERIA_ESCRITURA_ROLES)`
// para crear una conversación (leer una ya creada, en cambio, se abre a cualquier
// miembro del staff con acceso a la property -- mismo criterio que
// cotizaciones.ts/GET, la lectura no mueve ninguna cola de aprobación).
//
// Frontera de confianza del contexto congelado en `rentas.conversacion` -- SOLO
// `reservaConfirmada` es sensible (gatea la política de contacto/pago pre-reserva de
// H-058, ver validarMensajeSaliente): se resuelve SIEMPRE server-side desde
// `RentasRepository.findOcupacion` (nunca del cuerpo de la request), exactamente
// igual que `reservaConfirmada || fila.ocupacion_estado === "confirmado"` en el repo
// origen. `propiedadNombre`/`huespedNombre`/`fechaCheckIn`/`fechaCheckOut` son
// cosmético (solo alimentan el texto de las plantillas, ver
// domain-rentas/src/mensajeria/borrador.ts) -- se aceptan directo del staff que abre
// la conversación, mismo criterio ya usado por `huespedNombre`/`huespedContacto` en
// reservas.ts/POST. Si se omite una fecha, `GeneradorBorradorPlantillas` ya declara
// el faltante en vez de inventar un valor (RV18 §5) -- omitir la fecha es un estado
// legítimo, no un atajo inseguro.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership, assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CANALES_MENSAJERIA, MENSAJERIA_ESCRITURA_ROLES } from "@atiende/domain-rentas";
import type { CanalMensajeriaCodigo } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireCanal(value: unknown): CanalMensajeriaCodigo {
  if (typeof value !== "string" || !(CANALES_MENSAJERIA as readonly string[]).includes(value)) {
    throw Errors.validation(`canal: se esperaba uno de ${CANALES_MENSAJERIA.join(", ")}.`);
  }
  return value as CanalMensajeriaCodigo;
}

function requireOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un id.`);
  return value;
}

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

function requireOptionalFecha(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  return value;
}

function requirePropiedadNombre(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw Errors.validation("propiedadNombre: se esperaba un texto de 1-200 caracteres.");
  }
  return value.trim();
}

interface CrearConversacionBody {
  readonly canal?: unknown;
  readonly propiedadNombre?: unknown;
  readonly ocupacionId?: unknown;
  readonly huespedMinimoId?: unknown;
  readonly huespedNombre?: unknown;
  readonly fechaCheckIn?: unknown;
  readonly fechaCheckOut?: unknown;
}

export function rentasMensajeriaConversacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/unidades/:unidadId/conversaciones";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  // Hono empareja `app.use` por FORMA exacta de ruta, no por prefijo -- mismo criterio
  // que reservas.ts/bloqueos.ts: cada sub-path anidado necesita su propio registro de
  // middleware, registrar solo `base` NO cubre `${base}/:conversacionId/mensajes`.
  app.use(`${base}/:conversacionId/mensajes`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const raw = await readJsonCapped<CrearConversacionBody>(c.req.raw, 2 * 1024);
    const canal = requireCanal(raw.canal);
    const propiedadNombre = requirePropiedadNombre(raw.propiedadNombre);
    const ocupacionId = requireOptionalId(raw.ocupacionId, "ocupacionId");
    const huespedMinimoId = requireOptionalId(raw.huespedMinimoId, "huespedMinimoId");
    const huespedNombre = requireOptionalString(raw.huespedNombre, "huespedNombre", 200);
    const fechaCheckIn = requireOptionalFecha(raw.fechaCheckIn, "fechaCheckIn");
    const fechaCheckOut = requireOptionalFecha(raw.fechaCheckOut, "fechaCheckOut");

    // Único dato sensible del contexto: SIEMPRE resuelto server-side desde la
    // ocupación real, nunca del cuerpo de la request (ver cabecera del archivo).
    let reservaConfirmada = false;
    if (ocupacionId) {
      const ocupacion = await repo.findOcupacion(propertyId, unidadId, ocupacionId);
      if (!ocupacion) throw Errors.notFound("Ocupación no encontrada en esta unidad.");
      reservaConfirmada = ocupacion.estado === "confirmado";
    }

    const conversacion = await deps.rentasMensajeriaRepo(db).insertConversacion({
      organizationId,
      propertyId,
      unidadId,
      canal,
      ocupacionId,
      huespedMinimoId,
      propiedadNombre,
      huespedNombre,
      fechaCheckIn,
      fechaCheckOut,
      reservaConfirmada,
    });

    return c.json(conversacion, 201);
  });

  app.get(base, async (c) => {
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const conversaciones = await deps.rentasMensajeriaRepo(db).listConversaciones(propertyId, unidadId);
    return c.json({ conversaciones }, 200);
  });

  app.get(`${base}/:conversacionId/mensajes`, async (c) => {
    const propertyId = c.req.param("propertyId");
    const conversacionId = c.req.param("conversacionId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const conversacion = await mensajeriaRepo.findConversacion(propertyId, conversacionId);
    if (!conversacion) throw Errors.notFound("Conversación no encontrada en esta property.");

    const mensajes = await mensajeriaRepo.listMensajes(conversacionId);
    return c.json({ conversacion, mensajes }, 200);
  });

  // POST .../conversaciones/:conversacionId/mensajes -- registra un mensaje ENTRANTE
  // (origen 'simulador'/'manual'; nunca 'canal', ningún adaptador real está
  // conectado todavía). Es el insumo que POST .../borradores usa para generar un
  // borrador -- separado en su propio endpoint para poder registrar varios mensajes
  // entrantes de una misma conversación antes de generar un borrador para uno de
  // ellos.
  app.post(`${base}/:conversacionId/mensajes`, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const conversacionId = c.req.param("conversacionId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const conversacion = await mensajeriaRepo.findConversacion(propertyId, conversacionId);
    if (!conversacion) throw Errors.notFound("Conversación no encontrada en esta property.");

    const raw = await readJsonCapped<{ texto?: unknown; origen?: unknown }>(c.req.raw, 4 * 1024);
    const texto = typeof raw.texto === "string" ? raw.texto.trim() : "";
    if (!texto) throw Errors.validation("texto: se esperaba un texto no vacío.");
    const origen = raw.origen === "manual" ? "manual" : "simulador";

    const mensaje = await mensajeriaRepo.insertMensaje({ conversacionId, direccion: "entrante", origen, texto });
    return c.json(mensaje, 201);
  });

  return app;
}
