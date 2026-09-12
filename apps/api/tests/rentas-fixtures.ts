// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de rentas
// — arma una property con staff de distintos roles finos (admin_gestora/
// operador:acceso_total/operador:solo_calendario/contador), una unidad con tarifa
// real, y comparte el MISMO `InMemoryRentasCalendarStore` entre el
// `InMemoryRentasTenancyEngine` (que resuelve las queries crudas de
// aplicacion/reservas.ts) y el `InMemoryRentasRepository` (que resuelve
// findUnidad/findCanalPorCodigo/etc.) — en Postgres real ambos caminos leen/escriben
// la misma tabla, esta fixture reproduce esa misma propiedad.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { InMemoryRentasCalendarStore, InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository, InMemoryRentasTenancyEngine } from "@atiende/domain-rentas";
import type { RentasVerticalRole } from "@atiende/domain-rentas";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface RentasTestContext {
  readonly deps: AppDeps;
  readonly engine: InMemoryRentasTenancyEngine;
  /** Referencia tipada al adaptador en memoria concreto (a diferencia de
   * `deps.rentasRepo`, tipado como el puerto `RentasRepository`) — para que un test
   * pueda seguir sembrando datos (`seedUnidad`/`seedPricingContext`/etc.) después de
   * construido el contexto, sin depender de un cast. */
  readonly rentasRepo: InMemoryRentasRepository;
  /** Referencia tipada al adaptador en memoria del portal de propietario (Fase 3) --
   * mismo criterio que `rentasRepo` arriba: para que un test pueda seguir sembrando
   * datos (`seedOwner`/`seedUnidad`/`seedOwnerStatement`/`seedCredential`/etc.) después
   * de construido el contexto. */
  readonly rentasOwnerPortalRepo: InMemoryRentasOwnerPortalRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly staff: {
    readonly adminGestora: { id: string; email: string; password: string; token: string };
    readonly operadorAccesoTotal: { id: string; email: string; password: string; token: string };
    readonly operadorSoloCalendario: { id: string; email: string; password: string; token: string };
    readonly contador: { id: string; email: string; password: string; token: string };
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

export async function buildRentasTestContext(buildApp: BuildAppFn): Promise<RentasTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const calendarStore = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(calendarStore);
  const rentasRepo = new InMemoryRentasRepository(calendarStore);
  const rentasOwnerPortalRepo = new InMemoryRentasOwnerPortalRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  coreRepo.addOrganization({ id: organizationId, slug: "rentas-de-prueba", name: "Rentas de Prueba", vertical: "rentas" });
  engine.seedProperty({ id: propertyId, organizationId });
  rentasOwnerPortalRepo.seedOrganization({ id: organizationId, name: "Rentas de Prueba", slug: "rentas-de-prueba" });

  async function seedStaff(role: RentasVerticalRole, label: string, platformRole: "owner" | "admin" | "member" | "viewer") {
    const id = randomUUID();
    const email = `${label}@rentas-de-prueba.mx`;
    const password = "correcto-caballo-batería";
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    return { id, email, password };
  }

  const adminGestoraSeed = await seedStaff("admin_gestora", "admin-gestora", "owner");
  const operadorAccesoTotalSeed = await seedStaff("operador:acceso_total", "operador-acceso-total", "member");
  const operadorSoloCalendarioSeed = await seedStaff("operador:solo_calendario", "operador-solo-calendario", "member");
  const contadorSeed = await seedStaff("contador", "contador", "viewer");

  const unidadId = randomUUID();
  rentasRepo.seedUnidad({ id: unidadId, organizationId, propertyId, duracionMinimaNoches: 1 });
  rentasRepo.seedPricingContext(unidadId, {
    unidadId,
    moneda: "MXN",
    precioBaseNocheCentavos: 150000, // $1,500.00/noche
    temporadas: [],
    descuentosDuracion: [{ nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "Airbnb art. 1344 / Vrbo Manage your rates" }],
    reglasMinStay: [],
  });

  const canalManual = calendarStore.findCanalPorCodigo("manual")!;
  rentasRepo.seedReglaComisionCanal({ propertyId: null, canalId: canalManual.id, config: { yaNetoDeComision: true, comisionBasisPoints: 0, fuente: "Reserva directa: sin comisión de canal" } });

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: (_db) => new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: (_db) => new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
    rentasRepo: (_db) => rentasRepo,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepo,
    llmGateway: undefined,
    citasRepo: (_db) => new InMemoryCitasRepository(),
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(new InMemoryCitasRepository(), null),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture (vertical rentas).");
    },
    licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
    despachosRepo: (_db) => new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
  };

  const app = buildApp(deps);
  const [adminGestoraToken, operadorAccesoTotalToken, operadorSoloCalendarioToken, contadorToken] = await Promise.all([
    signInAndGetToken(app, adminGestoraSeed.email, adminGestoraSeed.password),
    signInAndGetToken(app, operadorAccesoTotalSeed.email, operadorAccesoTotalSeed.password),
    signInAndGetToken(app, operadorSoloCalendarioSeed.email, operadorSoloCalendarioSeed.password),
    signInAndGetToken(app, contadorSeed.email, contadorSeed.password),
  ]);

  return {
    deps,
    engine,
    rentasRepo,
    rentasOwnerPortalRepo,
    organizationId,
    propertyId,
    unidadId,
    staff: {
      adminGestora: { ...adminGestoraSeed, token: adminGestoraToken },
      operadorAccesoTotal: { ...operadorAccesoTotalSeed, token: operadorAccesoTotalToken },
      operadorSoloCalendario: { ...operadorSoloCalendarioSeed, token: operadorSoloCalendarioToken },
      contador: { ...contadorSeed, token: contadorToken },
    },
  };
}

export function authedJson(token: string, body?: unknown, extraHeaders: Record<string, string> = {}, method?: "GET" | "POST" | "PATCH"): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extraHeaders };
  if (body === undefined) return { method: method ?? "GET", headers };
  const raw = JSON.stringify(body);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  return { method: method ?? "POST", body: raw, headers };
}
