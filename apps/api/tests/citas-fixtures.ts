// Fixtures reales (no mocks) para los tests de integración de las 3 rutas de citas —
// arma una organización de citas con un staff real (para la ruta de panel) y un
// proveedor/servicio/horario real, exactamente como lo haría un seed contra las
// migraciones SQL reales de packages/domain-citas/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import type { ExchangeAuthorizationCodeInput, ExchangeAuthorizationCodeResult, GoogleCalendarPort } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { FakeIcalFeedPort, InMemoryRentasCalendarStore, InMemoryRentasCalendarSyncRepository, InMemoryRentasMensajeriaRepository, InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository } from "@atiende/domain-rentas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface CitasTestContext {
  readonly deps: AppDeps;
  /** Mismo objeto que resuelve `deps.citasRepo(...)`, tipado concreto -- para que los
   * tests puedan seguir llamando directamente al repo en memoria sin pasar por una
   * ruta HTTP (`deps.citasRepo` ahora es una fábrica `(db) => CitasRepository`). */
  readonly citasRepo: InMemoryCitasRepository;
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

export interface CitasTestContextOptions {
  /**
   * Fase 3 — cuando se pasa, el resolver real de Google Calendar
   * (`createGoogleCalendarPortResolver`, con la MISMA lógica de resolución/rotación
   * de token que producción) devuelve este puerto en vez de un
   * `RealGoogleCalendarPort` real, y el intercambio OAuth devuelve un refresh token
   * fijo sin tocar la red — para exercitar el flujo HTTP completo (conectar ->
   * crear/cancelar/reagendar -> sincroniza de verdad contra el puerto falso) sin
   * credenciales reales.
   */
  readonly googleCalendarPort?: GoogleCalendarPort;
}

export async function buildCitasTestContext(buildApp: BuildAppFn, options: CitasTestContextOptions = {}): Promise<CitasTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const citasRepo = new InMemoryCitasRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  citasRepo.seedOrganization({ id: organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", defaultTimezone: "America/Merida" });
  coreRepo.addOrganization({ id: organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", vertical: "citas" });
  engine.seedProperty({ id: propertyId, organizationId });
  // Fase 5 — panel de administración: `listPropertiesForOrganization` lee de su
  // propio seed en memoria (equivalente a `core.property`), separado del seed de
  // `engine` (que modela la membership/RLS, no el listado de sucursales).
  citasRepo.seedCitasProperty({ id: propertyId, organizationId, name: "Sucursal principal" });

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

  // Fase 3 — `createGoogleCalendarPortResolver` real (resolución de cuenta
  // conectada + rotación de refresh token) con un `createPort` inyectado: si el
  // test pasó un `googleCalendarPort`, se usa ese (nunca red real); si no,
  // `citasGoogleTokenExchange` nunca debería llamarse porque ningún test conectará
  // un proveedor sin pasar `googleCalendarPort` primero.
  const citasGoogleCalendarPortResolver = createGoogleCalendarPortResolver(citasRepo, { clientId: "test-google-client-id", clientSecret: "test-google-client-secret" }, () => options.googleCalendarPort!);
  const citasGoogleTokenExchange = async (_input: ExchangeAuthorizationCodeInput): Promise<ExchangeAuthorizationCodeResult> => {
    if (!options.googleCalendarPort) throw new Error("citasGoogleTokenExchange llamado sin googleCalendarPort configurado en buildCitasTestContext.");
    return { accessToken: "fake-access-token", refreshToken: "fake-refresh-token", expiresIn: 3600 };
  };

  const restaurantesRepoUnused = new InMemoryRestaurantesRepository();
  const hotelesRepoUnused = new InMemoryHotelesRepository();
  const licitacionesRepoUnused = new InMemoryLicitacionesRepository();
  const despachosRepoUnused = new InMemoryDespachosRepository();
  const rentasRepoUnused = new InMemoryRentasRepository();
  const rentasOwnerPortalRepoUnused = new InMemoryRentasOwnerPortalRepository();
  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    coreStaffRepo: (_db) => coreRepo,
    engine,
    restaurantesRepo: (_db) => restaurantesRepoUnused,
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: (_db) => hotelesRepoUnused,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
    citasRepo: (_db) => citasRepo,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver,
    citasGoogleTokenExchange,
    licitacionesRepo: (_db) => licitacionesRepoUnused,
    despachosRepo: (_db) => despachosRepoUnused,
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => rentasRepoUnused,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepoUnused,
    rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
    rentasMensajeriaRepo: (_db) => new InMemoryRentasMensajeriaRepository(),
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    llmGateway: undefined,
  };

  const app = buildApp(deps);
  const ownerToken = await signInAndGetToken(app, ownerEmail, ownerPassword);

  return { deps, citasRepo, organizationId, propertyId, providerId, serviceId, staff: { owner: { id: ownerId, email: ownerEmail, password: ownerPassword, token: ownerToken } } };
}
