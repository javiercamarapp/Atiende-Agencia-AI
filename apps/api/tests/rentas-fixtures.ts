// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de rentas
// — arma una property con staff de distintos roles finos (admin_gestora/
// operador:acceso_total/operador:solo_calendario/contador), una unidad con tarifa
// real, y comparte el MISMO `InMemoryRentasCalendarStore` entre el
// `InMemoryRentasTenancyEngine` (que resuelve las queries crudas de
// aplicacion/reservas.ts) y el `InMemoryRentasRepository` (que resuelve
// findUnidad/findCanalPorCodigo/etc.) — en Postgres real ambos caminos leen/escriben
// la misma tabla, esta fixture reproduce esa misma propiedad.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryAuthzAuditRepository, InMemoryImpersonationRepository, InMemoryLlmUsageRepository, InMemoryResumenDiarioRepository, InMemorySaludRepository, InMemorySuperadminAccionesRepository } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
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
  InMemoryRentasTenancyEngine,
  SimuladorCanalMensajeria,
} from "@atiende/domain-rentas";
import type { RentasVerticalRole } from "@atiende/domain-rentas";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createCalendarSyncPortResolver, RealCalComPort, RealCalDavPort, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import type { LlmGateway } from "@atiende/agent-core";
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
  /** Fase 5 -- referencia tipada al bookkeeping de sincronización de calendario
   * (feeds/versión/anti-eco), mismo criterio que `rentasRepo` arriba. */
  readonly rentasCalendarSyncRepo: InMemoryRentasCalendarSyncRepository;
  /** Fase 5 -- doble en memoria del canal externo (Airbnb/Booking/...), para que un
   * test configure escenarios (`definirEscenario`) sin tocar la red. */
  readonly rentasIcalFeedPort: FakeIcalFeedPort;
  /** Fase 7 -- referencia tipada al repositorio de mensajería (conversaciones/
   * mensajes/borradores/plantillas), mismo criterio que `rentasRepo` arriba. */
  readonly rentasMensajeriaRepo: InMemoryRentasMensajeriaRepository;
  /** Fase 11 -- referencia tipada al adaptador en memoria de onboarding self-serve,
   * mismo criterio que `rentasRepo` arriba (para que un test pueda seguir
   * inspeccionando lo que quedó registrado -- `findOrganizacionById`/
   * `findStaffByEmail`/etc. -- después de un `POST /rentas/onboarding/registro`). */
  readonly rentasOnboardingRepo: InMemoryRentasOnboardingRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly staff: {
    readonly adminGestora: { id: string; email: string; password: string; token: string };
    readonly operadorAccesoTotal: { id: string; email: string; password: string; token: string };
    readonly operadorSoloCalendario: { id: string; email: string; password: string; token: string };
    readonly contador: { id: string; email: string; password: string; token: string };
    /** Fase 17 -- panel operativo del rol `limpieza` (ver
     *  apps/api/tests/rentas-limpieza.spec.ts). Mismo criterio de seed que el resto
     *  del staff de este fixture. */
    readonly limpieza: { id: string; email: string; password: string; token: string };
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

export async function buildRentasTestContext(buildApp: BuildAppFn, options: { llmGateway?: LlmGateway } = {}): Promise<RentasTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const calendarStore = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(calendarStore);
  const rentasRepo = new InMemoryRentasRepository(calendarStore);
  const rentasOwnerPortalRepo = new InMemoryRentasOwnerPortalRepository();
  const rentasCalendarSyncRepo = new InMemoryRentasCalendarSyncRepository(calendarStore);
  const rentasIcalFeedPort = new FakeIcalFeedPort();
  const rentasMensajeriaRepo = new InMemoryRentasMensajeriaRepository();
  const rentasOnboardingRepo = new InMemoryRentasOnboardingRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  coreRepo.addOrganization({ id: organizationId, slug: "rentas-de-prueba", name: "Rentas de Prueba", vertical: "rentas" });
  engine.seedProperty({ id: propertyId, organizationId });
  rentasOwnerPortalRepo.seedOrganization({ id: organizationId, name: "Rentas de Prueba", slug: "rentas-de-prueba" });
  // Fase 9 -- nombre del tenant para el correo transaccional al huésped (ver
  // findOcupacionParaCorreo/InMemoryRentasRepository.seedOrganizacion).
  rentasRepo.seedOrganizacion(organizationId, "Rentas de Prueba");
  // Fase 12 -- espejo de solo-lectura para GET /v1/rentas/:orgSlug/admin/propiedades
  // (ver domain-rentas/src/in-memory-repository.ts, comentario de cabecera de
  // `organizationsDiscovery`/`propertiesDiscovery`: no comparte almacenamiento con
  // `coreRepo`/`engine`).
  rentasRepo.seedOrganization({ id: organizationId, slug: "rentas-de-prueba", name: "Rentas de Prueba" });
  rentasRepo.seedPropertySummary(organizationId, { propertyId, name: "Rentas de Prueba — Matriz" });

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
  // Fase 17 -- panel operativo de limpieza/mantenimiento (LIMPIEZA_OPERACION_ROLES).
  const limpiezaSeed = await seedStaff("limpieza", "limpieza", "member");

  const unidadId = randomUUID();
  rentasRepo.seedUnidad({ id: unidadId, organizationId, propertyId, duracionMinimaNoches: 1, name: "Depa de Prueba" });
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
  rentasCalendarSyncRepo.seedZonaHoraria(propertyId, "America/Cancun");

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
    rentasRepo: (_db) => rentasRepo,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepo,
    rentasCalendarSyncRepo: (_db) => rentasCalendarSyncRepo,
    rentasIcalFeedPort: rentasIcalFeedPort,
    rentasMensajeriaRepo: (_db) => rentasMensajeriaRepo,
    // Test double real (no un mock) -- SÍ completa la transición 'aprobado' ->
    // 'enviado' para poder probar el resto del flujo de aprobación sin depender de
    // un canal real (ver CanalMensajeriaPartnerPendiente para el adaptador honesto
    // de producción, que SIEMPRE lanza sin credenciales de partner).
    rentasCanalMensajeria: (canal) => new SimuladorCanalMensajeria(canal),
    rentasOnboardingRepo: (_db) => rentasOnboardingRepo,
    // Fase 10b -- "romper cristal": fuera del alcance de estos fixtures (staff con
    // membership real, nunca superadmin) -- solo para satisfacer AppDeps. Los tests
    // dedicados de break-glass usan apps/api/tests/fixtures.ts::buildTestDeps.
    rentasBreakGlassSessionRepo: (_db) => new InMemoryBreakGlassSessionRepository(),
    rentasBreakGlassAuditRepo: (_db) => new InMemoryBreakGlassAuditRepository(),
    rentasBreakGlassDataRepo: (_db) => new InMemoryBreakGlassRentasDataRepository(new Map()),
    // Bloque C -- impersonación de superadmin con bitácora: campo requerido de
    // AppDeps que este fixture (independiente del de fixtures.ts) todavía no
    // tenía cableado -- instancia en memoria vacía, nada de esta suite ejercita
    // impersonación.
    impersonationRepo: (_db) => new InMemoryImpersonationRepository(),
    authzAuditSink: new InMemoryAuditSink(),
    authzAuditRepo: (_db) => new InMemoryAuthzAuditRepository(),
    llmGateway: options.llmGateway,
    llmUsageRepo: new InMemoryLlmUsageRepository(),
    saludRepo: new InMemorySaludRepository(),
    resumenDiarioRepo: new InMemoryResumenDiarioRepository(),
    accionesRepo: new InMemorySuperadminAccionesRepository(),
    resumenDiarioLlmGateway: undefined,
    citasRepo: (_db) => new InMemoryCitasRepository(),
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(new InMemoryCitasRepository(), null),
    citasCalendarSyncPortResolver: createCalendarSyncPortResolver(new InMemoryCitasRepository(), null),
    citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture (vertical rentas).");
    },
    citasCaldavUrlValidator: async () => {
      throw new Error("citasCaldavUrlValidator no está configurado en este fixture (vertical rentas).");
    },
    licitacionesRepo: (_db) => new InMemoryLicitacionesRepository(),
    despachosRepo: (_db) => new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
  };

  const app = buildApp(deps);
  const [adminGestoraToken, operadorAccesoTotalToken, operadorSoloCalendarioToken, contadorToken, limpiezaToken] = await Promise.all([
    signInAndGetToken(app, adminGestoraSeed.email, adminGestoraSeed.password),
    signInAndGetToken(app, operadorAccesoTotalSeed.email, operadorAccesoTotalSeed.password),
    signInAndGetToken(app, operadorSoloCalendarioSeed.email, operadorSoloCalendarioSeed.password),
    signInAndGetToken(app, contadorSeed.email, contadorSeed.password),
    signInAndGetToken(app, limpiezaSeed.email, limpiezaSeed.password),
  ]);

  return {
    deps,
    engine,
    rentasRepo,
    rentasOwnerPortalRepo,
    rentasCalendarSyncRepo,
    rentasIcalFeedPort,
    rentasMensajeriaRepo,
    rentasOnboardingRepo,
    organizationId,
    propertyId,
    unidadId,
    staff: {
      adminGestora: { ...adminGestoraSeed, token: adminGestoraToken },
      operadorAccesoTotal: { ...operadorAccesoTotalSeed, token: operadorAccesoTotalToken },
      operadorSoloCalendario: { ...operadorSoloCalendarioSeed, token: operadorSoloCalendarioToken },
      contador: { ...contadorSeed, token: contadorToken },
      limpieza: { ...limpiezaSeed, token: limpiezaToken },
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
