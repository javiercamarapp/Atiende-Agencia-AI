// Fase 6 pieza 5 (REQ-055) — licitacionesRenewalRadarRoutes: radar de
// renovaciones. `POST .../renewals/scan` evalúa TODOS los contratos con
// `endDate` conocida de la organización y persiste una alerta nueva por
// cada (contrato, umbral) recién cruzado -- idempotente (reescanear no
// duplica alertas ya emitidas para el mismo umbral). Sin canal de envío
// real (email/WhatsApp) -- registro consultable, mismo criterio "honesto"
// que `tender_change_notification` (Fase 5).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface RenewalScanBody {
  readonly leadDaysThresholds?: unknown;
}

function parseLeadDaysThresholds(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10 || !raw.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)) {
    throw Errors.validation("leadDaysThresholds: se esperaba un arreglo de hasta 10 enteros positivos.");
  }
  return raw as number[];
}

/** `POST .../renewals/scan` acepta un cuerpo completamente OPCIONAL (todos los umbrales por defecto) -- a diferencia de `readJsonCapped` (que exige JSON válido siempre), un request sin body en absoluto (sin `content-length`) es válido aquí y equivale a `{}`, nunca un 400. */
async function readOptionalJsonBody<T>(req: Request, maxBytes: number): Promise<Partial<T>> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length <= 0) return {};
  return readJsonCapped<T>(req, maxBytes);
}

export function licitacionesRenewalRadarRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const scanBase = "/licitaciones/:propertyId/renewals/scan";
  const alertsBase = "/licitaciones/:propertyId/renewals/alerts";
  const acknowledgeBase = "/licitaciones/:propertyId/renewals/alerts/:alertId/acknowledge";

  app.use(scanBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(alertsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(acknowledgeBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(scanBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readOptionalJsonBody<RenewalScanBody>(c.req.raw, 4 * 1024);
    const leadDaysThresholds = parseLeadDaysThresholds(raw.leadDaysThresholds);

    const result = await repo.scanRenewalAlerts(organizationId, { leadDaysThresholds });
    return c.json(result, 200);
  });

  app.get(alertsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const alerts = await repo.listRenewalAlerts(organizationId);
    return c.json({ alerts });
  });

  app.post(acknowledgeBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const alertId = c.req.param("alertId");
    try {
      const alert = await repo.acknowledgeRenewalAlert(organizationId, alertId, actorId);
      return c.json(alert);
    } catch {
      throw Errors.notFound("Alerta de renovación no encontrada.");
    }
  });

  return app;
}
