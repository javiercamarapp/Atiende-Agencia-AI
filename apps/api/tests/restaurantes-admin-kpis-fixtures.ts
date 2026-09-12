// Fixtures reales (no mocks) para los tests HTTP de Fase 3 restaurantes — admin-kpis.
// Primeras rutas de STAFF AUTENTICADO de este vertical (ver diseño Fase 3 §0), así que
// a diferencia de apps/api/tests/fixtures.ts (usado por public-orders/voice-tools/
// whatsapp, todas rutas SIN authMiddleware) este fixture sí siembra membership en
// AMBOS lados: `coreRepo.addMembership` (login real + resolución de alcance por
// `deps.coreRepo.findMembershipsByUserId` dentro de admin-kpis.ts) y
// `engine.seedMembership`/`seedProperty` (lo que `requirePropertyMembership` de
// @atiende/core-auth consulta vía `c.get("db")` — ver InMemoryTenancyEngine, que solo
// reconoce esa forma exacta de query). Dos organizaciones sembradas para poder probar
// aislamiento cross-tenant real de las rutas de KPIs.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import type { Order, PersistedOrderItem } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { FakeIcalFeedPort, InMemoryRentasCalendarStore, InMemoryRentasCalendarSyncRepository, InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository } from "@atiende/domain-rentas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface RestaurantesKpiStaff {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly token: string;
}

export interface RestaurantesKpiTestContext {
  readonly deps: AppDeps;
  /** Mismo objeto que `deps.restaurantesRepo`, tipado concreto (no la interfaz
   * `RestaurantesRepository`) para poder llamar los `seed*` de fixture desde los
   * tests sin castear. */
  readonly restaurantesRepo: InMemoryRestaurantesRepository;
  readonly organizationId: string;
  readonly propertyIdA: string;
  readonly propertyIdB: string;
  readonly otherOrganizationId: string;
  readonly otherPropertyId: string;
  readonly staff: {
    /** owner, membership org-wide (propertyIds: null) — ve ambas sucursales. */
    readonly owner: RestaurantesKpiStaff;
    /** verticalRole "staff" (SÍ pasa MANAGER_ROLES), membership acotada SOLO a
     * propertyIdA — nunca debe ver datos de propertyIdB en un KPI org-wide. */
    readonly staffSucursalA: RestaurantesKpiStaff;
    /** verticalRole "repartidor" — excluido por MANAGER_ROLES pase lo que pase. */
    readonly repartidor: RestaurantesKpiStaff;
    /** Staff de la OTRA organización — nunca debe poder leer KPIs de esta. */
    readonly otroOrgOwner: RestaurantesKpiStaff;
  };
}

function makeOrder(overrides: Partial<Order> & { organizationId: string; propertyId: string }): Order {
  const items: readonly PersistedOrderItem[] = overrides.items ?? [{ id: randomUUID(), name: "Tacos de Bistec de Res (orden de 3)", price: 164, quantity: 1 }];
  return {
    id: randomUUID(),
    customerId: null,
    customerName: "Cliente de prueba",
    customerPhone: "9990000000",
    customerAddress: null,
    branch: null,
    total: 164,
    status: "completado",
    items,
    source: "web",
    notes: null,
    paymentMethod: null,
    callTranscript: null,
    callRecordingUrl: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    createdAt: new Date().toISOString(),
    ...overrides,
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

export async function buildRestaurantesKpiTestContext(buildApp: BuildAppFn): Promise<RestaurantesKpiTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const restaurantesRepo = new InMemoryRestaurantesRepository();

  const organizationId = randomUUID();
  const propertyIdA = randomUUID();
  const propertyIdB = randomUUID();
  restaurantesRepo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  restaurantesRepo.seedBranch({ propertyId: propertyIdA, organizationId, name: "Francisco de Montejo", slug: "fco-montejo", status: "active", phone: null, address: null, lat: null, lng: null });
  restaurantesRepo.seedBranch({ propertyId: propertyIdB, organizationId, name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null });
  coreRepo.addOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
  engine.seedProperty({ id: propertyIdA, organizationId });
  engine.seedProperty({ id: propertyIdB, organizationId });

  const otherOrganizationId = randomUUID();
  const otherPropertyId = randomUUID();
  restaurantesRepo.seedOrganization({ id: otherOrganizationId, slug: "otro-restaurante", name: "Otro Restaurante" });
  restaurantesRepo.seedBranch({ propertyId: otherPropertyId, organizationId: otherOrganizationId, name: "Única sucursal", slug: "unica", status: "active", phone: null, address: null, lat: null, lng: null });
  coreRepo.addOrganization({ id: otherOrganizationId, slug: "otro-restaurante", name: "Otro Restaurante", vertical: "restaurantes" });
  engine.seedProperty({ id: otherPropertyId, organizationId: otherOrganizationId });

  async function seedStaff(orgId: string, role: "owner" | "staff" | "repartidor", label: string, propertyIds: readonly string[] | null): Promise<RestaurantesKpiStaff> {
    const id = randomUUID();
    const email = `${label}@${orgId.slice(0, 8)}.mx`;
    const password = "correcto-caballo-batería";
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    const platformRole = role === "owner" ? "owner" : "member";
    coreRepo.addMembership({ userId: id, organizationId: orgId, platformRole, verticalRole: role, propertyIds });
    engine.seedMembership({ userId: id, organizationId: orgId, platformRole, verticalRole: role, propertyIds });
    return { id, email, password, token: "" };
  }

  const ownerSeed = await seedStaff(organizationId, "owner", "owner", null);
  const staffASeed = await seedStaff(organizationId, "staff", "staff-sucursal-a", [propertyIdA]);
  const repartidorSeed = await seedStaff(organizationId, "repartidor", "repartidor", null);
  const otroOrgOwnerSeed = await seedStaff(otherOrganizationId, "owner", "owner-otro", null);

  const kpiFixtureCitasRepo = new InMemoryCitasRepository();
  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: (_db) => restaurantesRepo,
    turnHandler: acknowledgeOnlyTurnHandler(restaurantesRepo),
    hotelesRepo: (_db) => new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
    citasRepo: (_db) => kpiFixtureCitasRepo,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    // Fase 3 citas — sin credenciales de Google configuradas en este fixture de
    // KPIs de restaurantes (no relacionado): el resolver siempre devuelve `null`.
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(kpiFixtureCitasRepo, null),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture de pruebas de KPIs de restaurantes.");
    },
    licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
    despachosRepo: (_db) => new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => new InMemoryRentasRepository(),
    rentasOwnerPortalRepo: (_db) => new InMemoryRentasOwnerPortalRepository(),
    rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    llmGateway: undefined,
  };

  const app = buildApp(deps);
  const [ownerToken, staffAToken, repartidorToken, otroOrgOwnerToken] = await Promise.all([
    signInAndGetToken(app, ownerSeed.email, ownerSeed.password),
    signInAndGetToken(app, staffASeed.email, staffASeed.password),
    signInAndGetToken(app, repartidorSeed.email, repartidorSeed.password),
    signInAndGetToken(app, otroOrgOwnerSeed.email, otroOrgOwnerSeed.password),
  ]);

  return {
    deps,
    restaurantesRepo,
    organizationId,
    propertyIdA,
    propertyIdB,
    otherOrganizationId,
    otherPropertyId,
    staff: {
      owner: { ...ownerSeed, token: ownerToken },
      staffSucursalA: { ...staffASeed, token: staffAToken },
      repartidor: { ...repartidorSeed, token: repartidorToken },
      otroOrgOwner: { ...otroOrgOwnerSeed, token: otroOrgOwnerToken },
    },
  };
}

export function authedGet(token: string): RequestInit {
  return { method: "GET", headers: { authorization: `Bearer ${token}` } };
}

export { makeOrder };
