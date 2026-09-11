// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de hoteles
// — arma un property con staff de distintos roles finos (owner/frontdesk/
// housekeeping/fnb), un huésped+reserva+folio abierto, tax_config y un tipo de
// habitación con tarifas reales, exactamente como lo haría un seed contra las
// migraciones SQL reales de packages/domain-hoteles/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort } from "@atiende/domain-hoteles";
import { InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface HotelesTestContext {
  readonly deps: AppDeps;
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
  ]);

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    citasRepo: new InMemoryCitasRepository(),
    licitacionesRepo: new InMemoryLicitacionesRepository(),
    despachosRepo: new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
  };

  const app = buildApp(deps);
  const [ownerToken, frontdeskToken, housekeepingToken, fnbToken] = await Promise.all([
    signInAndGetToken(app, ownerSeed.email, ownerSeed.password),
    signInAndGetToken(app, frontdeskSeed.email, frontdeskSeed.password),
    signInAndGetToken(app, housekeepingSeed.email, housekeepingSeed.password),
    signInAndGetToken(app, fnbSeed.email, fnbSeed.password),
  ]);

  return {
    deps,
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
