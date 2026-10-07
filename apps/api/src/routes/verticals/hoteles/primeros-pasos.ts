// H-P3-06 (P1) -- "Primeros pasos" del hotel con gate (patron R-33 de restaurantes). El checklist se calcula en el servidor con datos reales
// (tipos, habitaciones, tarifas de los proximos 30 dias, impuestos y politica guardados, zona horaria, aviso de privacidad, WhatsApp, voz,
// equipo y reservas); nunca un estado guardado a mano. owner/gm. Cada paso lleva responsable y pantalla.
//   GET  /hoteles/:propertyId/primeros-pasos          checklist + gate
//   POST /hoteles/:propertyId/primeros-pasos/omitir   omite el gate: deja la omision en la bitacora (owner/gm)
//
// Base sin migrar: cada lectura degrada (SAVEPOINT) a "sin configurar"/0 y ningun punto se da por hecho por falta de tabla; la omision responde
// `registrada:false` (sin migracion 047 no hay bitacora) pero el panel igual la respeta en el navegador.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { resolverZonaHorariaNegocio, hoyFechaNegocio } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  ADMIN_ROLES,
  NOCHES_TARIFA_REQUERIDAS,
  PostgresMensajeriaConfigRepository,
  PostgresPrivacyRepository,
  buildHotelOnboardingChecklist,
  type MensajeriaConfigRepository,
  type OnboardingSnapshot,
  type PrivacyRepository,
} from "@atiende/domain-hoteles";
import type { AppDeps } from "../../../deps.ts";

/** Lectura con SAVEPOINT: una migracion pendiente (42883/42P01/42703) en una pieza ajena degrada a `fallback`, nunca aborta el request. */
function leer<T>(c: Context<CoreAuthHonoEnv>, primary: () => Promise<T>, fallback: T): Promise<T> {
  return runWithSavepointFallback({ session: c.get("db"), primary, isRecoverable: isMigrationPendingError, fallback: () => Promise.resolve(fallback) });
}

export function hotelesPrimerosPasosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/hoteles/:propertyId/primeros-pasos";
  for (const p of [path, `${path}/omitir`]) app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function medir(c: Context<CoreAuthHonoEnv>) {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const repo = deps.hotelesRepo(db);
    const mensajeria: MensajeriaConfigRepository = deps.hotelesMensajeriaConfigRepo ? deps.hotelesMensajeriaConfigRepo(db) : new PostgresMensajeriaConfigRepository(db);
    const privacidad: PrivacyRepository = deps.hotelesPrivacidadRepo ? deps.hotelesPrivacidadRepo(db) : new PostgresPrivacyRepository(db);

    // En SECUENCIA: cada lectura abre su SAVEPOINT sobre la misma transaccion del request (en paralelo se destruyen entre si).
    const timezone = await repo.findPropertyTimezone(propertyId);
    const hoy = hoyFechaNegocio(resolverZonaHorariaNegocio(timezone));
    const hasta = new Date(Date.parse(`${hoy}T00:00:00Z`) + (NOCHES_TARIFA_REQUERIDAS - 1) * 86_400_000).toISOString().slice(0, 10);
    const tipos = await repo.listRoomTypes(propertyId);
    const habitaciones = await repo.listRooms(propertyId, null);
    const tarifas = await repo.listRatePlans({ propertyId, from: hoy, to: hasta, roomTypeId: null, limit: 5000 });
    const impuestos = await repo.loadTaxSettings(propertyId);
    const politica = await repo.loadCancellationPolicySettings(propertyId);
    const reservas = (await repo.listReservationsPage(propertyId, { limit: 1, offset: 0 })).total;
    const whatsapp = await leer(c, () => mensajeria.getWhatsAppChannel(propertyId), { configurado: false, phoneNumberId: null, enabled: false, updatedAt: null });
    const voz = await leer(c, () => mensajeria.getVoiceAgent(propertyId), { configurado: false, enabled: false, secretoConfigurado: false, updatedAt: null });
    const avisos = await leer(c, async () => (await privacidad.listNotices(propertyId, { limit: 20 })), null);
    const miembros = await leer(c, async () => (await deps.coreStaffRepo(db).listOrgMembers(organizationId)).length, 1);
    const pendientes = await leer(c, async () => (await deps.coreStaffRepo(db).listPendingStaffInvites(organizationId)).length, 0);

    const noches = new Map<string, Set<string>>();
    for (const t of tarifas) {
      const set = noches.get(t.roomTypeId) ?? new Set<string>();
      set.add(t.date);
      noches.set(t.roomTypeId, set);
    }
    const snapshot: OnboardingSnapshot = {
      tipos: tipos.map((t) => ({ id: t.id, nombre: t.name, nochesConTarifa: noches.get(t.id)?.size ?? 0 })),
      habitaciones: habitaciones.length,
      nochesRequeridas: NOCHES_TARIFA_REQUERIDAS,
      impuestosConfigurados: impuestos.configurado,
      politicaConfigurada: politica.configurado,
      zonaHorariaConfigurada: timezone !== null,
      avisoPublicado: avisos === null || !avisos.available ? null : avisos.items.some((n) => n.isCurrent),
      whatsapp: { configurado: whatsapp.configurado, habilitado: whatsapp.enabled },
      voz: { configurado: voz.configurado, habilitado: voz.enabled, secretoConfigurado: voz.secretoConfigurado },
      miembros,
      invitacionesPendientes: pendientes,
      reservas,
    };
    return { checklist: buildHotelOnboardingChecklist(snapshot), propertyId, organizationId };
  }

  app.get(path, async (c) => {
    const { checklist, propertyId, organizationId } = await medir(c);
    c.header("Cache-Control", "no-store");
    // Cierre del ciclo: la primera vez que no queda ningun obligatorio pendiente se avisa en la campana (una sola vez por property: dedupe).
    if (checklist.listoParaOperar) {
      try {
        await emitirNotificacion(c.get("db"), { evento: "hoteles.onboarding.listo", organizationId, propertyId, clave: propertyId });
      } catch (err) {
        console.error("hoteles/primeros-pasos: aviso de listo no emitido:", err);
      }
    }
    return c.json({ ...checklist.gate, listoParaOperar: checklist.listoParaOperar, resumen: checklist.resumen, items: checklist.items, nochesRequeridas: checklist.nochesRequeridas });
  });

  app.post(`${path}/omitir`, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const registrada = await deps.hotelesRepo(c.get("db")).recordOnboardingSkip(c.req.param("propertyId") ?? "", c.get("organizationId"), c.get("userId"));
    return c.json({ omitido: true, registrada });
  });

  return app;
}
