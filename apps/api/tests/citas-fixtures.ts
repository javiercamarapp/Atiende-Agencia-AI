// Fixtures reales (no mocks) para los tests de integración de las 3 rutas de citas —
// arma una organización de citas con un staff real (para la ruta de panel) y un
// proveedor/servicio/horario real, exactamente como lo haría un seed contra las
// migraciones SQL reales de packages/domain-citas/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort } from "@atiende/domain-hoteles";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryRentasRepository } from "@atiende/domain-rentas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface CitasTestContext {
  readonly deps: AppDeps;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly staff: { readonly owner: { readonly id: string; readonly email: string; readonly password: string; readonly token: string } };
}

async function signInAndGetToken(app: TestApp, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (res.status !== 200) throw new Error(`login de prueba falló para ${email}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function buildCitasTestContext(buildApp: BuildAppFn): Promise<CitasTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const citasRepo = new InMemoryCitasRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  citasRepo.seedOrganization({ id: organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", defaultTimezone: "America/Merida" });
  coreRepo.addOrganization({ id: organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", vertical: "citas" });
  engine.seedProperty({ id: propertyId, organizationId });

  const providerId = randomUUID();
  citasRepo.seedProvider({ id: providerId, organizationId, propertyId: null, displayName: "Dra. Fernanda López", roleLabel: "Dentista", isActive: true });

  const serviceId = randomUUID();
  citasRepo.seedService({ id: serviceId, organizationId, name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true });
  citasRepo.seedProviderService(providerId, serviceId);
  for (const dayOfWeek of [1, 2, 3, 4, 5]) {
    citasRepo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  }
  citasRepo.seedWhatsAppConfig(organizationId, "1234567890");

  const ownerId = randomUUID();
  const ownerEmail = "dueña@clinica-dental-sonrisas.mx";
  const ownerPassword = "correcto-caballo-batería";
  coreRepo.addStaff({ id: ownerId, email: ownerEmail, fullName: "Dueña", passwordHash: await hashPassword(ownerPassword), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  engine.seedMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    citasRepo,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    licitacionesRepo: new InMemoryLicitacionesRepository(),
    despachosRepo: new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: new InMemoryRentasRepository(),
  };

  const app = buildApp(deps);
  const ownerToken = await signInAndGetToken(app, ownerEmail, ownerPassword);

  return { deps, organizationId, propertyId, providerId, serviceId, staff: { owner: { id: ownerId, email: ownerEmail, password: ownerPassword, token: ownerToken } } };
}
