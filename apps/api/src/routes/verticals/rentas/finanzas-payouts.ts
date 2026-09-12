// Flujo 6 (Fase 2, alcance recortado) · Payout de canal + conciliación —
// POST/GET /rentas/:propertyId/payouts. Ver diseño Fase 2 rentas §5: el matching en sí
// (`conciliarPayout`, dominio puro) no depende de ningún canal real ni de channel
// manager -- recibe líneas YA NORMALIZADAS por el staff (JSON, nunca un CSV/XLS crudo
// de Vrbo/Airbnb/Booking; eso es trabajo de adaptador que se recorta de esta fase,
// `origen_importacion` queda fijo en 'manual' con un CHECK en el propio esquema).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { conciliarPayout, FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES, sumarCentavos } from "@atiende/domain-rentas";
import type { LineaPayoutEntrada } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEDA_RE = /^[A-Z]{3}$/;

function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, max);
}

function requireMoneda(value: unknown): string {
  const moneda = requireString(value, "moneda", 3);
  if (!MONEDA_RE.test(moneda)) throw Errors.validation("moneda: se esperaba un código ISO 4217 de 3 letras mayúsculas.");
  return moneda;
}

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw Errors.validation(`${field}: se esperaba un entero >= 0 (centavos, nunca decimal).`);
  }
  return value;
}

function requireLineas(raw: unknown): LineaPayoutEntrada[] {
  if (!Array.isArray(raw) || raw.length === 0) throw Errors.validation("lineas: se esperaba un arreglo con al menos 1 elemento.");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw Errors.validation(`lineas[${index}]: se esperaba un objeto.`);
    const l = item as { referenciaExternaReserva?: unknown; montoCentavos?: unknown };
    return {
      referenciaExternaReserva: l.referenciaExternaReserva === undefined || l.referenciaExternaReserva === null ? null : requireString(l.referenciaExternaReserva, `lineas[${index}].referenciaExternaReserva`, 200),
      montoCentavos: requireNonNegativeInteger(l.montoCentavos, `lineas[${index}].montoCentavos`),
    };
  });
}

interface ImportarPayoutBody {
  readonly canalCodigo?: unknown;
  readonly moneda?: unknown;
  readonly fechaPayout?: unknown;
  readonly referenciaExterna?: unknown;
  readonly lineas?: unknown;
}

export function rentasFinanzasPayoutsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/payouts";
  const detallePath = `${base}/:id`;
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(detallePath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));

    const raw = await readJsonCapped<ImportarPayoutBody>(c.req.raw, 16 * 1024);
    const canalCodigo = requireString(raw.canalCodigo, "canalCodigo", 60);
    const moneda = requireMoneda(raw.moneda);
    const fechaPayout = requireFecha(raw.fechaPayout, "fechaPayout");
    const referenciaExterna = requireOptionalString(raw.referenciaExterna, "referenciaExterna", 200);
    const lineas = requireLineas(raw.lineas);

    const canal = await repo.findCanalPorCodigo(canalCodigo);
    if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no existe en el catálogo.`);

    // Candidatas: reservas de esta property con canal de origen = el canal del payout
    // y con `reserva_financiero` ya registrado (Flujo 3, Fase 1) -- ver diseño §5.
    const candidatas = await repo.findCandidatasConciliacion(propertyId, canal.id);
    const resultado = conciliarPayout(lineas, candidatas);

    const montoTotalCentavos = sumarCentavos(...lineas.map((l) => l.montoCentavos));

    const creado = await repo.insertPayout({
      organizationId,
      propertyId,
      canalId: canal.id,
      moneda,
      montoTotalCentavos,
      fechaPayout,
      referenciaExterna,
      createdBy: userId,
      lineas: resultado.lineas,
    });

    return c.json({ id: creado.id, creadoEn: creado.creadoEn, canalCodigo, moneda, montoTotalCentavos, fechaPayout, resumen: resultado.resumen, lineas: resultado.lineas }, 201);
  });

  app.get(detallePath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const repo = deps.rentasRepo(c.get("db"));

    const payout = await repo.findPayoutDetalle(propertyId, id);
    if (!payout) throw Errors.notFound("Payout no encontrado en esta property.");

    return c.json(payout, 200);
  });

  return app;
}
