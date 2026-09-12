// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de hoteles
// — arma un property con staff de distintos roles finos (owner/frontdesk/
// housekeeping/fnb), un huésped+reserva+folio abierto, tax_config y un tipo de
// habitación con tarifas reales, exactamente como lo haría un seed contra las
// migraciones SQL reales de packages/domain-hoteles/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository } from "@atiende/domain-rentas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface HotelesTestContext {
  readonly deps: AppDeps;
  /** Mismo objeto que resuelve `deps.hotelesRepo(...)`, tipado concreto (no la
   * interfaz `HotelesRepository`) para que los tests puedan seguir llamando
   * directamente al repo en memoria (p. ej. `bookAvailability`/`insertCharge`) sin
   * pasar por una ruta HTTP -- ya no se puede hacer `ctx.deps.hotelesRepo.metodo()`
   * porque `deps.hotelesRepo` es ahora una fábrica `(db) => HotelesRepository`. */
  readonly hotelesRepo: InMemoryHotelesRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly folioId: string;
  readonly roomTypeId: string;
  readonly staff: {
    readonly owner: { id: string; email: string; password: string; token: string };
    readonly frontdesk: { id: string; email: string; password: string; token: string };
    readonly housekeeping: { id: string; email: string; password: string; token: string };
    readonly fnb: { id: string; email: string; password: string; token: string };
    readonly reservations: { id: string; email: string; password: string; token: string };
    readonly accountant: { id: string; email: string; password: string; token: string };
  };
}

async function signInAndGetToken(app: TestApp, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login de prueba falló para ${email}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function buildHotelesTestContext(buildApp: BuildAppFn): Promise<HotelesTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const hotelesRepo = new InMemoryHotelesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  coreRepo.addOrganization({ id: organizationId, slug: "hotel-de-prueba", name: "Hotel de Prueba", vertical: "hoteles" });
  engine.seedProperty({ id: propertyId, organizationId });

  async function seedStaff(role: "owner" | "gm" | "frontdesk" | "reservations" | "housekeeping" | "maintenance" | "fnb" | "accountant", label: string) {
    const id = randomUUID();
    const email = `${label}@hotel-de-prueba.mx`;
    const password = "correcto-caballo-batería";
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    const platformRole = role === "owner" ? "owner" : role === "gm" ? "admin" : "member";
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    return { id, email, password };
  }

  const ownerSeed = await seedStaff("owner", "owner");
  const frontdeskSeed = await seedStaff("frontdesk", "frontdesk");
  const housekeepingSeed = await seedStaff("housekeeping", "housekeeping");
  const fnbSeed = await seedStaff("fnb", "fnb");
  const reservationsSeed = await seedStaff("reservations", "reservations");
  const accountantSeed = await seedStaff("accountant", "accountant");

  hotelesRepo.seedTaxConfig(propertyId, { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500 });

  const reservationId = randomUUID();
  hotelesRepo.seedGuestIdentity(reservationId, { lastName: "García", phoneLast4: "1234" });
  hotelesRepo.seedFolio({
    id: randomUUID(),
    organizationId,
    propertyId,
    reservationId,
    status: "abierto",
    label: "Principal",
    isPrimary: true,
    closedAt: null,
    closeReason: null,
    arApprovedBy: null,
  });
  // Solo el folio recién creado importa a partir de aquí — recuperamos su id real vía
  // listFoliosByReservation (mismo camino que usaría la app).
  const [folio] = await hotelesRepo.listFoliosByReservation(propertyId, reservationId);

  hotelesRepo.seedStaff({ propertyId, userId: ownerSeed.id, isAdmin: true });

  const roomTypeId = randomUUID();
  hotelesRepo.seedRoomType(propertyId, roomTypeId);
  hotelesRepo.seedNightlyRates(propertyId, roomTypeId, [
    { date: "2026-12-01", price: 1500, minStay: 1, closedToArrival: false, closedToDeparture: false },
    { date: "2026-12-02", price: 1500, minStay: 1, closedToArrival: false, closedToDeparture: false },
    { date: "2026-12-03", price: 1500, minStay: 1, closedToArrival: false, closedToDeparture: false },
    // OJO: NO agregar 2026-12-04 aquí -- hoteles-quotes.spec.ts depende deliberadamente
    // de que esa noche NO tenga tarifa sembrada (caso real de 409 sin_tarifa).
    // Fecha en el pasado respecto a "hoy" real -- usada por los tests de Fase 3
    // (reservationStateMachine/no-show) que necesitan una reserva cuyo check-in ya
    // pasó sin pasar por reloj real (`asOfDate` explícito en la ruta de no-show).
    { date: "2025-01-10", price: 1500, minStay: 1, closedToArrival: false, closedToDeparture: false },
    { date: "2025-01-11", price: 1500, minStay: 1, closedToArrival: false, closedToDeparture: false },
  ]);
  // Fase 3 (H02) — inventario real por noche, necesario para que
  // POST /hoteles/:propertyId/reservas pueda reservar vía bookAvailability. 2
  // habitaciones libres por noche, sin sobreventa configurada (defaults de
  // migrations/003_availability.sql: max_overbook_rooms=0, threshold=95%).
  for (const date of ["2026-12-01", "2026-12-02", "2026-12-03", "2025-01-10", "2025-01-11"]) {
    hotelesRepo.seedAvailability(propertyId, roomTypeId, date, 2, 0);
  }
  // Política de cancelación real: cancelar con más de 48h de anticipación es libre;
  // menos de eso, penalización del 50% del total.
  hotelesRepo.seedCancellationPolicy(propertyId, { freeUntilHours: 48, penaltyPct: 0.5 });

  const citasRepoForResolver = new InMemoryCitasRepository();
  const restaurantesRepoUnused = new InMemoryRestaurantesRepository();
  const licitacionesRepoUnused = new InMemoryLicitacionesRepository();
  const despachosRepoUnused = new InMemoryDespachosRepository();
  const rentasRepoUnused = new InMemoryRentasRepository();
  const rentasOwnerPortalRepoUnused = new InMemoryRentasOwnerPortalRepository();
  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: (_db) => restaurantesRepoUnused,
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: (_db) => hotelesRepo,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(hotelesRepo),
    citasRepo: (_db) => citasRepoForResolver,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(citasRepoForResolver, null),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture (vertical hoteles).");
    },
    licitacionesRepo: (_db) => licitacionesRepoUnused,
    despachosRepo: (_db) => despachosRepoUnused,
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => rentasRepoUnused,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepoUnused,
    llmGateway: undefined,
  };

  const app = buildApp(deps);
  const [ownerToken, frontdeskToken, housekeepingToken, fnbToken, reservationsToken, accountantToken] = await Promise.all([
    signInAndGetToken(app, ownerSeed.email, ownerSeed.password),
    signInAndGetToken(app, frontdeskSeed.email, frontdeskSeed.password),
    signInAndGetToken(app, housekeepingSeed.email, housekeepingSeed.password),
    signInAndGetToken(app, fnbSeed.email, fnbSeed.password),
    signInAndGetToken(app, reservationsSeed.email, reservationsSeed.password),
    signInAndGetToken(app, accountantSeed.email, accountantSeed.password),
  ]);

  return {
    deps,
    hotelesRepo,
    organizationId,
    propertyId,
    reservationId,
    folioId: folio!.id,
    roomTypeId,
    staff: {
      owner: { ...ownerSeed, token: ownerToken },
      frontdesk: { ...frontdeskSeed, token: frontdeskToken },
      housekeeping: { ...housekeepingSeed, token: housekeepingToken },
      fnb: { ...fnbSeed, token: fnbToken },
      reservations: { ...reservationsSeed, token: reservationsToken },
      accountant: { ...accountantSeed, token: accountantToken },
    },
  };
}

export function authedJson(token: string, body?: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extraHeaders };
  if (body === undefined) return { method: "GET", headers };
  const raw = JSON.stringify(body);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  return { method: "POST", body: raw, headers };
}
