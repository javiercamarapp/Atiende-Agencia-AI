// H4 · POST /hoteles/:propertyId/quotes — REQ-REV-001/REQ-RES-002: motor de
// cotización determinista. El body de entrada NUNCA acepta un campo de precio/total:
// solo identificadores (roomTypeId/checkInDate/checkOutDate) — arquitectónicamente ni
// un LLM ni el propio cliente HTTP puede inyectar un precio final, ver
// @atiende/domain-hoteles::parseQuoteInput (nunca hace spread del body de entrada,
// arma el objeto campo por campo desde las columnas reales de `hoteles.rate_plan`).
// Port ~directo de hoteles/apps/api/src/routes/quotes.ts (ver diseño Fase 1 hoteles
// §4.3 — por qué este flujo y no mensajeria.ts).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import { computeQuote, QuoteError, QuoteInputValidationError, parseQuoteInput } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface QuoteBody {
  readonly roomTypeId?: unknown;
  readonly checkInDate?: unknown;
  readonly checkOutDate?: unknown;
}

// Mapa de códigos de dominio (@atiende/domain-hoteles::QuoteError) -> estatus HTTP.
const CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

export function hotelesQuotesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.hotelesRepo;

  app.use("/hoteles/:propertyId/quotes", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/hoteles/:propertyId/quotes", async (c) => {
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<QuoteBody>(c.req.raw, 2 * 1024);

    if (typeof raw.roomTypeId !== "string" || raw.roomTypeId.length === 0) throw Errors.validation("roomTypeId requerido.");
    if (typeof raw.checkInDate !== "string" || !DATE_RE.test(raw.checkInDate)) throw Errors.validation("checkInDate: formato de fecha esperado YYYY-MM-DD.");
    if (typeof raw.checkOutDate !== "string" || !DATE_RE.test(raw.checkOutDate)) throw Errors.validation("checkOutDate: formato de fecha esperado YYYY-MM-DD.");
    if (raw.checkOutDate <= raw.checkInDate) throw Errors.validation("checkOutDate debe ser posterior a checkInDate.");

    const roomType = await repo.findRoomType(propertyId, raw.roomTypeId);
    if (!roomType) throw Errors.notFound("Tipo de habitación no encontrado en esta property.");

    const taxConfig = await repo.loadTaxConfig(propertyId);
    const nightlyRates = await repo.loadNightlyRates(propertyId, raw.roomTypeId, raw.checkInDate, raw.checkOutDate);

    try {
      const input = parseQuoteInput({
        checkInDate: raw.checkInDate,
        checkOutDate: raw.checkOutDate,
        taxConfig: { ivaRate: taxConfig.ivaRate, ishRate: taxConfig.ishRate },
        nightlyRates,
      });
      const quote = computeQuote(input);
      return c.json({ roomTypeId: raw.roomTypeId, ...quote }, 200);
    } catch (err) {
      if (err instanceof QuoteError) {
        const status = CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      if (err instanceof QuoteInputValidationError) throw Errors.validation(err.message);
      throw err;
    }
  });

  return app;
}
