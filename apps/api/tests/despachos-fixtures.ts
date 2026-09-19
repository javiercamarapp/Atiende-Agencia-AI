// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de
// despachos — arma una organización con staff de distintos roles finos
// (admin/contador/auditor/readonly) y una property singleton (ver diseño Fase 1
// despachos §1: un despacho no tiene "propiedades" físicas relevantes al dominio),
// exactamente como lo haría un seed contra las migraciones SQL reales de
// packages/domain-despachos/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryLlmUsageRepository, InMemoryResumenDiarioRepository, InMemorySaludRepository, InMemorySuperadminAccionesRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import type { DespachosRole } from "@atiende/domain-despachos";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createCalendarSyncPortResolver, RealCalComPort, RealCalDavPort, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import {
  FakeIcalFeedPort,
  InMemoryBreakGlassAuditRepository,
  InMemoryBreakGlassRentasDataRepository,
  InMemoryBreakGlassSessionRepository,
  InMemoryRentasCalendarStore,
  InMemoryRentasCalendarSyncRepository,
  InMemoryRentasMensajeriaRepository,
  InMemoryRentasOnboardingRepository,
  InMemoryRentasOwnerPortalRepository,
  InMemoryRentasRepository,
  SimuladorCanalMensajeria,
} from "@atiende/domain-rentas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface DespachosTestContext {
  readonly deps: AppDeps;
  /** Mismo objeto que resuelve `deps.despachosRepo(...)`, tipado concreto -- para que
   * los tests puedan seguir llamando directamente al repo en memoria sin pasar por
   * una ruta HTTP (`deps.despachosRepo` ahora es una fábrica `(db) =>
   * DespachosRepository`). */
  readonly despachosRepo: InMemoryDespachosRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staff: {
    readonly admin: { id: string; email: string; password: string; token: string };
    readonly contador: { id: string; email: string; password: string; token: string };
    readonly auditor: { id: string; email: string; password: string; token: string };
    readonly readonly: { id: string; email: string; password: string; token: string };
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

export async function buildDespachosTestContext(buildApp: BuildAppFn): Promise<DespachosTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const despachosRepo = new InMemoryDespachosRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  coreRepo.addOrganization({ id: organizationId, slug: "despacho-de-prueba", name: "Despacho de Prueba SC", vertical: "despachos" });
  engine.seedProperty({ id: propertyId, organizationId });
  // Fase 9 — mismo doble-seed que licitaciones-fixtures.ts/citas-fixtures.ts:
  // coreRepo/engine PARA auth/RLS + despachosRepo PARA que
  // `GET /v1/despachos/:orgSlug/admin/branches` resuelva algo real (ver
  // InMemoryDespachosRepository.findOrganizationBySlug).
  despachosRepo.seedOrganization({ id: organizationId, slug: "despacho-de-prueba", name: "Despacho de Prueba SC" });
  despachosRepo.seedDespachosProperty({ id: propertyId, organizationId, name: "Sede principal" });

  async function seedStaff(role: DespachosRole, label: string) {
    const id = randomUUID();
    const email = `${label}@despacho-de-prueba.mx`;
    const password = "correcto-caballo-batería";
    const platformRole = role === "admin" ? "owner" : role === "contador" ? "admin" : "viewer";
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    return { id, email, password };
  }

  const adminSeed = await seedStaff("admin", "admin");
  const contadorSeed = await seedStaff("contador", "contador");
  const auditorSeed = await seedStaff("auditor", "auditor");
  const readonlySeed = await seedStaff("readonly", "readonly");

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    coreStaffRepo: (_db) => coreRepo,
    engine,
    restaurantesRepo: (_db) => new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: (_db) => new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(new InMemoryHotelesRepository()),
    despachosRepo: (_db) => despachosRepo,
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    citasRepo: (_db) => new InMemoryCitasRepository(),
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    // Fase 3 — no relevante para este fixture (vertical despachos); sin
    // credenciales configuradas, el resolver real siempre devuelve null.
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(new InMemoryCitasRepository(), null),
    citasCalendarSyncPortResolver: createCalendarSyncPortResolver(new InMemoryCitasRepository(), null),
    citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture (vertical despachos).");
    },
    citasCaldavUrlValidator: async () => {
      throw new Error("citasCaldavUrlValidator no está configurado en este fixture (vertical despachos).");
    },
    licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
    rentasRepo: (_db) => new InMemoryRentasRepository(),
    rentasOwnerPortalRepo: (_db) => new InMemoryRentasOwnerPortalRepository(),
    rentasOnboardingRepo: (_db) => new InMemoryRentasOnboardingRepository(),
    rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
    rentasMensajeriaRepo: (_db) => new InMemoryRentasMensajeriaRepository(),
    rentasCanalMensajeria: (canal) => new SimuladorCanalMensajeria(canal),
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    // Fase 10b -- "romper cristal", ver apps/api/tests/fixtures.ts para el criterio completo.
    rentasBreakGlassSessionRepo: (_db) => new InMemoryBreakGlassSessionRepository(),
    rentasBreakGlassAuditRepo: (_db) => new InMemoryBreakGlassAuditRepository(),
    rentasBreakGlassDataRepo: (_db) => new InMemoryBreakGlassRentasDataRepository(new Map()),
    llmGateway: undefined,
    llmUsageRepo: new InMemoryLlmUsageRepository(),
    saludRepo: new InMemorySaludRepository(),
    resumenDiarioRepo: new InMemoryResumenDiarioRepository(),
    accionesRepo: new InMemorySuperadminAccionesRepository(),
    resumenDiarioLlmGateway: undefined,
  };

  const app = buildApp(deps);
  const [adminToken, contadorToken, auditorToken, readonlyToken] = await Promise.all([
    signInAndGetToken(app, adminSeed.email, adminSeed.password),
    signInAndGetToken(app, contadorSeed.email, contadorSeed.password),
    signInAndGetToken(app, auditorSeed.email, auditorSeed.password),
    signInAndGetToken(app, readonlySeed.email, readonlySeed.password),
  ]);

  return {
    deps,
    despachosRepo,
    organizationId,
    propertyId,
    staff: {
      admin: { ...adminSeed, token: adminToken },
      contador: { ...contadorSeed, token: contadorToken },
      auditor: { ...auditorSeed, token: auditorToken },
      readonly: { ...readonlySeed, token: readonlyToken },
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
