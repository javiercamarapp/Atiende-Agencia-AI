// Fase 3 pieza 1 — licitacionesTendersRoutes: `POST base/tenders`, alta/
// actualización MANUAL de una convocatoria (ver diseño Fase 3 §6). Sustituye
// (no complementa) la ingesta automática bloqueada por B-02
// (docs/BLOQUEOS.md: ComprasMX/OCDS-SHCP/PDN-S6/portales estatales
// inalcanzables por reCAPTCHA/bot-detection) -- mientras ese bloqueo externo
// siga abierto, este es el ÚNICO camino de escritura productivo para
// `licitaciones.tender` (antes de esta pieza, `LicitacionesRepository` solo
// exponía `findTender`; `seedTender` es exclusivo del repositorio in-memory
// de pruebas).
//
// `source` SIEMPRE se fija en el servidor como "manual" -- el body NUNCA
// puede declarar un `source` distinto (ver `TenderCreateBody` abajo: ni
// siquiera se declara el campo, así que aunque el cliente lo mande se
// ignora), precisamente para que quede trazable qué convocatorias son
// captura manual (todas, mientras B-02 esté abierto) frente a una futura
// ingesta automática que usaría otros valores de `source`.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, assertExplicitOffset } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

// Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad BAJA:
// "listados sin paginación en 4 verticales") -- GET base devolvía TODAS las
// convocatorias de la organización en un solo array. Una organización activa
// acumula cientos/miles de convocatorias a lo largo de los años.
const DEFAULT_TENDERS_LIMIT = 50;
const MAX_TENDERS_LIMIT = 200;

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

interface TenderUpsertBody {
  readonly title?: unknown;
  readonly submissionDeadline?: unknown;
  readonly externalId?: unknown;
  readonly contractingBody?: unknown;
  readonly cpvCodes?: unknown;
  readonly budgetAmount?: unknown;
  readonly currency?: unknown;
  readonly state?: unknown;
  readonly procedureTypeRaw?: unknown;
}

function parseOptionalString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) throw Errors.validation(`${field}: se esperaba una cadena no vacía o ausente.`);
  return raw;
}

function parseCpvCodes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && c.length > 0)) throw Errors.validation("cpvCodes: se esperaba un arreglo de strings no vacíos.");
  return raw;
}

function parseOptionalNonNegativeNumber(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw Errors.validation(`${field}: se esperaba un número >= 0.`);
  return raw;
}

export function licitacionesTendersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders";
  // Restringido a forma de UUID (regex de Hono en el propio segmento) -- sin esto,
  // esta ruta capturaría también `/tenders/matching` (matching.ts, ruta estática
  // de UN segmento igual que ésta) tratando "matching" como un tenderId literal,
  // ambigüedad real de enrutamiento entre dos sub-apps montadas en "/" (orden de
  // registro, no especificidad, decide qué handler gana en este Hono). El resto
  // de rutas de :tenderId del vertical (go-no-go.ts, checklist.ts) no tienen este
  // problema porque agregan un segmento más después del id.
  const detailBase = "/licitaciones/:propertyId/tenders/:tenderId{[0-9a-fA-F-]{36}}";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(detailBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Fase 7 — GET base/lectura: el panel web (backoffice) necesita el `TenderRecord`
  // completo (título, fecha límite, entidad, etc.) para pintar la lista y el
  // detalle de una convocatoria -- `GET base/tenders/matching` (matching.ts) solo
  // trae `MatchResult` (score/elegibilidad), sin título. Cualquier miembro de la
  // organización puede leer (mismo criterio que matching.ts: ver el listado no es
  // una decisión, decidir go/no-go sí lo es).
  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_TENDERS_LIMIT, MAX_TENDERS_LIMIT);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // Body sigue siendo `{ tenders: [...] }` (compatibilidad con el cliente ya
    // existente) -- lo que cambia de verdad es que la QUERY ahora está acotada por
    // `limit`/`offset` reales (`listTendersPage`, ver
    // @atiende/domain-licitaciones::repository.ts) en vez de traer TODA la tabla;
    // `listTenders` (sin paginar) se queda para `matching.ts`, que necesita el
    // conjunto completo. El total real y el siguiente offset van en headers.
    const page = await repo.listTendersPage(organizationId, { limit, offset });
    c.header("X-Total-Count", String(page.total));
    if (page.nextOffset !== null) c.header("X-Next-Offset", String(page.nextOffset));
    return c.json({ tenders: page.items });
  });

  app.get(detailBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    return c.json(tender);
  });

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const raw = await readJsonCapped<TenderUpsertBody>(c.req.raw, 64 * 1024);

    if (typeof raw.title !== "string" || raw.title.trim().length === 0) throw Errors.validation("title requerido.");

    let submissionDeadline: string | null = null;
    if (raw.submissionDeadline !== undefined && raw.submissionDeadline !== null) {
      if (typeof raw.submissionDeadline !== "string") throw Errors.validation("submissionDeadline: se esperaba una cadena ISO 8601 con offset explícito.");
      try {
        assertExplicitOffset(raw.submissionDeadline, "submissionDeadline");
      } catch (err) {
        throw Errors.validation(err instanceof Error ? err.message : "submissionDeadline inválido.");
      }
      submissionDeadline = raw.submissionDeadline;
    }

    const externalId = parseOptionalString(raw.externalId, "externalId");
    const contractingBody = parseOptionalString(raw.contractingBody, "contractingBody");
    const cpvCodes = parseCpvCodes(raw.cpvCodes);
    const budgetAmount = parseOptionalNonNegativeNumber(raw.budgetAmount, "budgetAmount");
    const currency = raw.currency === undefined || raw.currency === null ? "MXN" : typeof raw.currency === "string" && raw.currency.length === 3 ? raw.currency : (() => { throw Errors.validation("currency: se esperaba un código de 3 letras (p. ej. \"MXN\")."); })();
    const state = parseOptionalString(raw.state, "state");
    const procedureTypeRaw = parseOptionalString(raw.procedureTypeRaw, "procedureTypeRaw");

    const result = await repo.upsertTenderManual(organizationId, {
      title: raw.title,
      submissionDeadline,
      externalId,
      contractingBody,
      cpvCodes,
      budgetAmount,
      currency,
      state,
      procedureTypeRaw,
      actorId,
    });

    // §6 del diseño original (Fase 3): la invalidación de la aprobación
    // "expediente" ante un cambio de fecha límite vivía aquí, disparada a
    // mano solo para `submissionDeadlineChanged`. Fase 5 pieza 2
    // (`repo.upsertTenderManual` -> `recordTenderVersion`, ver
    // domain-licitaciones/src/tender-version-registry.ts) la GENERALIZÓ a
    // cualquier campo de bases o requisito que cambie, versiona la
    // convocatoria (REQ-153) y además notifica (REQ-151/155) -- ya ocurrió
    // dentro de `upsertTenderManual` arriba, en la MISMA operación; esta ruta
    // ya no necesita disparar nada por su cuenta.

    return c.json(result.tender, result.created ? 201 : 200);
  });

  return app;
}
