// H-27 -- /hoteles/:propertyId/huespedes/:guestId/...: FICHA DE HUESPED (CRM). Perfil, historial de estancias, notas y
// preferencias, solicitudes de contacto, consentimientos y estado de identidad/ARCO. Complementa (no duplica) el catalogo
// `GET|POST /huespedes` de reservas.ts.
//
// Privacidad (H-02, LFPDPPP) y minimizacion de PII: la ficha NUNCA devuelve el documento de identidad (solo si hay una
// identidad activa en la boveda, un booleano); las notas rechazan numeros de tarjeta/documento (13 a 19 digitos); con una
// solicitud ARCO de cancelacion u oposicion en curso no se agregan datos nuevos (la base lo exige y la ficha avisa); el
// detalle de ARCO sigue siendo solo de owner/gm en /privacidad/arco. Solo roles que ya gestionan reservas (GUEST_CRM_ROLES).
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: contra una base anterior a la migracion 038 la ficha responde con el
// perfil y el historial y marca `notas.disponible: false` / `arco: null`; agregar o archivar notas responde 503 honesto.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  GUEST_CRM_ROLES,
  GUEST_NOTE_KINDS,
  GUEST_NOTE_MAX_LENGTH,
  HuespedesAccessDeniedError,
  HuespedesArcoRestrictionError,
  HuespedesInvalidInputError,
  HuespedesNotFoundError,
  HuespedesUnavailableError,
  PostgresHuespedesRepository,
  claveTelefono,
  resumirEstancias,
  type GuestNoteKind,
  type GuestNoteRecord,
  type HuespedesRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAYS_LIMIT = 50;
const CONTACTS_LIMIT = 10;
const MESSAGE_PREVIEW = 200;

function toApiError(err: unknown): unknown {
  if (err instanceof HuespedesUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof HuespedesNotFoundError) return Errors.notFound(err.message);
  if (err instanceof HuespedesInvalidInputError) return Errors.validation(err.message);
  if (err instanceof HuespedesAccessDeniedError) return Errors.forbidden(err.message);
  if (err instanceof HuespedesArcoRestrictionError) return new ApiError(409, "arco_en_curso", err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function serializeNote(n: GuestNoteRecord) {
  return { id: n.id, tipo: n.kind, texto: n.body, creadaPor: n.createdBy, creadaEn: n.createdAt };
}

export function hotelesHuespedesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/huespedes/:guestId/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const repoOf = (c: Context<CoreAuthHonoEnv>): HuespedesRepository =>
    deps.hotelesHuespedesRepo ? deps.hotelesHuespedesRepo(c.get("db")) : new PostgresHuespedesRepository(c.get("db"));

  function guestIdOf(c: Context<CoreAuthHonoEnv>): string {
    const id = c.req.param("guestId") ?? "";
    if (!UUID_RE.test(id)) throw Errors.validation("guestId: se esperaba un UUID.");
    return id;
  }

  // ---- Ficha ----------------------------------------------------------------------------------------------------------
  app.get("/hoteles/:propertyId/huespedes/:guestId/ficha", async (c) => {
    assertVerticalRole(c, GUEST_CRM_ROLES);
    const propertyId = c.req.param("propertyId");
    const guestId = guestIdOf(c);
    const hoteles = deps.hotelesRepo(c.get("db"));
    const guest = await hoteles.findGuestById(propertyId, guestId);
    if (!guest) throw Errors.notFound("Huesped no encontrado.");

    const repo = repoOf(c);
    const hoy = hoyFechaNegocio(resolverZonaHorariaNegocio(await hoteles.findPropertyTimezone(propertyId)));
    const estancias = await guarded(() => repo.listarEstancias(propertyId, guestId, STAYS_LIMIT));
    const [contactos, consentimientos, identidad, restriccionArco, notas] = await Promise.all([
      guarded(() => repo.listarContactos(propertyId, claveTelefono(guest.phone), CONTACTS_LIMIT)),
      guarded(() => repo.listarConsentimientos(propertyId, guestId)),
      guarded(() => repo.tieneIdentidadActiva(propertyId, guestId)),
      guarded(() => repo.tieneRestriccionArco(guestId)),
      guarded(() => repo.listarNotas(propertyId, guestId)),
    ]);
    const resumen = resumirEstancias(estancias, hoy);

    return c.json({
      huesped: { id: guest.id, nombreCompleto: guest.fullName, email: guest.email, telefono: guest.phone },
      resumen: { estancias: resumen.stays, noches: resumen.nights, ultimaEstancia: resumen.lastStay, proximaLlegada: resumen.nextArrival },
      estancias: estancias.map((s) => ({
        reservaId: s.reservationId,
        estado: s.status,
        entrada: s.checkInDate,
        salida: s.checkOutDate,
        tipoHabitacion: s.roomTypeName,
        habitacion: s.roomCode,
        montoNetoCentavos: s.netAmountCents,
      })),
      notas: { disponible: notas.available, items: notas.items.map(serializeNote) },
      contactos: contactos.map((x) => ({
        id: x.id,
        motivo: x.reason,
        canal: x.source === "voice" ? "voz" : "whatsapp",
        mensaje: x.message === null ? null : x.message.slice(0, MESSAGE_PREVIEW),
        creadoEn: x.createdAt,
      })),
      // null = la base aun no tiene la migracion 032: no se afirma "sin consentimientos".
      consentimientos:
        consentimientos === null
          ? null
          : consentimientos.map((x) => ({ id: x.id, aviso: x.noticeVersion, finalidadesOpcionales: x.optionalPurposes, canal: x.channel, fecha: x.consentedAt, revocado: x.revoked })),
      identidad: identidad === null ? null : { registrada: identidad },
      // restriccion = ARCO de cancelacion u oposicion en curso: bloquea notas nuevas. null = sin la migracion 038.
      arco: restriccionArco === null ? null : { restriccion: restriccionArco },
    });
  });

  // ---- Notas y preferencias -------------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/huespedes/:guestId/notas", async (c) => {
    assertVerticalRole(c, GUEST_CRM_ROLES);
    const propertyId = c.req.param("propertyId");
    const guestId = guestIdOf(c);
    const raw = await readJsonCapped<{ tipo?: unknown; texto?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof raw.tipo !== "string" || !(GUEST_NOTE_KINDS as readonly string[]).includes(raw.tipo)) throw Errors.validation(`tipo: se esperaba ${GUEST_NOTE_KINDS.join("|")}.`);
    if (typeof raw.texto !== "string" || raw.texto.trim().length === 0) throw Errors.validation("texto requerido.");
    const texto = raw.texto.trim();
    if (texto.length > GUEST_NOTE_MAX_LENGTH) throw Errors.validation(`texto: maximo ${GUEST_NOTE_MAX_LENGTH} caracteres.`);

    const guest = await deps.hotelesRepo(c.get("db")).findGuestById(propertyId, guestId);
    if (!guest) throw Errors.notFound("Huesped no encontrado.");
    const note = await guarded(() => repoOf(c).agregarNota({ propertyId, guestId, kind: raw.tipo as GuestNoteKind, body: texto }));
    return c.json(serializeNote(note), 201);
  });

  app.post("/hoteles/:propertyId/huespedes/:guestId/notas/:noteId/archivar", async (c) => {
    assertVerticalRole(c, GUEST_CRM_ROLES);
    const propertyId = c.req.param("propertyId");
    guestIdOf(c);
    const noteId = c.req.param("noteId") ?? "";
    if (!UUID_RE.test(noteId)) throw Errors.validation("noteId: se esperaba un UUID.");
    const archived = await guarded(() => repoOf(c).archivarNota(propertyId, noteId));
    if (!archived) throw Errors.notFound("Nota no encontrada o ya archivada.");
    return c.json(serializeNote(archived));
  });

  return app;
}
