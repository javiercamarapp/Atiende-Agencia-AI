// Fixtures reales (no mocks) para los tests de integración de las 3 rutas de citas —
// arma una organización de citas con un staff real (para la ruta de panel) y un
// proveedor/servicio/horario real, exactamente como lo haría un seed contra las
// migraciones SQL reales de packages/domain-citas/migrations/.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { hashPassword, InMemoryCoreRepository, InMemoryLlmUsageRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende/mcp-cfdi";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createCalendarSyncPortResolver, createDefaultConversationGuard, createGoogleCalendarPortResolver, crearValidadorUrlCaldav, InMemoryCitasRepository, RealCalComPort, RealCalDavPort } from "@atiende/domain-citas";
import type { CalendarSyncPort, ExchangeAuthorizationCodeInput, ExchangeAuthorizationCodeResult, GoogleCalendarPort, ResolverDns } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { FakeIcalFeedPort, InMemoryRentasCalendarStore, InMemoryRentasCalendarSyncRepository, InMemoryRentasMensajeriaRepository, InMemoryRentasOnboardingRepository, InMemoryRentasOwnerPortalRepository, InMemoryRentasRepository, SimuladorCanalMensajeria } from "@atiende/domain-rentas";
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
  readonly staff: {
    readonly owner: { readonly id: string; readonly email: string; readonly password: string; readonly token: string };
    /** Fase 12 — verticalRole "staff" (platformRole "member", ver
     * domain-citas/src/roles.ts::PLATFORM_ROLE_BY_VERTICAL_ROLE) -- fuera de
     * STAFF_INVITE_ROLES (owner/admin), para los tests de admin-staff.ts que
     * verifican que "staff" nunca puede invitar. */
    readonly staffMember: { readonly id: string; readonly email: string; readonly password: string; readonly token: string };
  };
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
  /**
   * Fase 6 §2 (seguimiento) — mismo criterio que `googleCalendarPort`: cuando se
   * pasa, `createCalendarSyncPortResolver` real (resolución de cuenta Cal.com
   * conectada + api_key) devuelve este puerto genérico (`CalendarSyncPort`, nunca
   * toca la red) en vez de un `RealCalComPort` real — normalmente un
   * `FakeCalendarSyncPort("calcom")` (ver @atiende/domain-citas).
   */
  readonly calcomPort?: CalendarSyncPort;
  /** Ver `calcomPort` — mismo criterio para CalDAV. */
  readonly caldavPort?: CalendarSyncPort;
  /**
   * Hallazgo de auditoría (ALTO, SSRF) — resolver DNS falso para
   * `citasCaldavUrlValidator` (`crearValidadorUrlCaldav`, ver
   * @atiende/domain-citas/src/net/validar-url-caldav.ts). Por defecto
   * (`resolverDnsFalsoPorDefecto` abajo) un hostname que YA es una IP literal se
   * devuelve tal cual (igual que el `dns.lookup` real, que nunca toca la red para
   * un literal) — así los tests de IPs privadas literales SÍ se rechazan sin
   * configurar nada; cualquier otro hostname "resuelve" a `203.0.113.10` (RFC
   * 5737 TEST-NET-3, documentalmente pública), así los tests existentes que
   * conectan un CalDAV con un hostname real (`caldav.fastmail.com`, etc.) pasan
   * la validación sin tocar la red ni depender de que ese dominio siga
   * resolviendo igual. Los tests de SSRF pasan este `caldavDnsResolver` para
   * simular DNS rebinding: un hostname que no tiene pinta de privado pero
   * resuelve a una IP privada/loopback/metadata.
   */
  readonly caldavDnsResolver?: ResolverDns;
}

const IP_PUBLICA_DE_PRUEBA = "203.0.113.10"; // RFC 5737 TEST-NET-3 -- reservada para documentación, nunca enrutable, pero NO cae en ningún rango que `validarIpPermitida` bloquee (no es privada/loopback/link-local/metadata), así que sirve como "IP pública" determinista de prueba.

/** Mismo criterio que `dns.lookup` real: un hostname que ya es una IP literal
 * (v4 o v6) se devuelve tal cual, sin inventar nada -- necesario para que los
 * tests de IPs privadas LITERALES en la URL (127.0.0.1, 169.254.169.254, etc.)
 * se rechacen incluso con este resolver falso. */
function resolverDnsFalsoPorDefecto(hostname: string): string[] {
  return isIP(hostname) !== 0 ? [hostname] : [IP_PUBLICA_DE_PRUEBA];
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

  const staffMemberId = randomUUID();
  const staffMemberEmail = "staff@clinica-dental-sonrisas.mx";
  const staffMemberPassword = "correcto-caballo-batería";
  coreRepo.addStaff({ id: staffMemberId, email: staffMemberEmail, fullName: "Staff", passwordHash: await hashPassword(staffMemberPassword), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: staffMemberId, organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });
  engine.seedMembership({ userId: staffMemberId, organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });
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

  // Fase 6 §2 (seguimiento) — resolver GENÉRICO multi-proveedor real (misma
  // lógica de resolución de cuenta/despacho por plataforma que producción, ver
  // @atiende/domain-citas::createCalendarSyncPortResolver), con las tres fábricas
  // de puerto inyectadas: Google reusa el mismo `googleCalendarPort` de arriba
  // (comportamiento IDÉNTICO al resolver Google-only para los tests que no tocan
  // Cal.com/CalDAV), Cal.com/CalDAV devuelven `calcomPort`/`caldavPort` si el test
  // los pasó.
  const citasCalendarSyncPortResolver = createCalendarSyncPortResolver(citasRepo, { clientId: "test-google-client-id", clientSecret: "test-google-client-secret" }, {
    createGooglePort: () => options.googleCalendarPort!,
    createCalComPort: () => options.calcomPort!,
    createCalDavPort: () => options.caldavPort!,
  });

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
    citasCalendarSyncPortResolver,
    // Fase 6 §2 (seguimiento) — ver AppDeps.citasCalComPortFactory/citasCalDavPortFactory:
    // usados SOLO por POST .../{calcom,caldav}/test-connection. Cuando el test pasó
    // `calcomPort`/`caldavPort`, se devuelve ESE mismo fake sin importar `cfg` (para
    // poder aserciones sobre `calls`/`events`); si no, construye el puerto real (nunca
    // debería tocar la red porque ningún test llama a test-connection sin pasarlo).
    citasCalComPortFactory: (cfg) => options.calcomPort ?? new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => options.caldavPort ?? new RealCalDavPort(cfg),
    citasGoogleTokenExchange,
    citasCaldavUrlValidator: crearValidadorUrlCaldav({ resolverDns: options.caldavDnsResolver ?? resolverDnsFalsoPorDefecto }),
    licitacionesRepo: (_db) => licitacionesRepoUnused,
    despachosRepo: (_db) => despachosRepoUnused,
    despachosAuditSink: new InMemoryAuditSink(),
    hotelesCfdiPort: new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
    hotelesFraudeAuditSink: new InMemoryAuditSink(),
    rentasRepo: (_db) => rentasRepoUnused,
    rentasOwnerPortalRepo: (_db) => rentasOwnerPortalRepoUnused,
    rentasOnboardingRepo: (_db) => new InMemoryRentasOnboardingRepository(),
    rentasCalendarSyncRepo: (_db) => new InMemoryRentasCalendarSyncRepository(new InMemoryRentasCalendarStore()),
    rentasMensajeriaRepo: (_db) => new InMemoryRentasMensajeriaRepository(),
    rentasCanalMensajeria: (canal) => new SimuladorCanalMensajeria(canal),
    rentasIcalFeedPort: new FakeIcalFeedPort(),
    llmGateway: undefined,
    llmUsageRepo: new InMemoryLlmUsageRepository(),
  };

  const app = buildApp(deps);
  const ownerToken = await signInAndGetToken(app, ownerEmail, ownerPassword);
  const staffMemberToken = await signInAndGetToken(app, staffMemberEmail, staffMemberPassword);

  return {
    deps,
    citasRepo,
    organizationId,
    propertyId,
    providerId,
    serviceId,
    staff: {
      owner: { id: ownerId, email: ownerEmail, password: ownerPassword, token: ownerToken },
      staffMember: { id: staffMemberId, email: staffMemberEmail, password: staffMemberPassword, token: staffMemberToken },
    },
  };
}

export function authedGet(token: string): RequestInit {
  return { method: "GET", headers: { authorization: `Bearer ${token}` } };
}

/** Fase 12 — mismo helper que restaurantes-admin-kpis-fixtures.ts::authedJson,
 * reusado aquí en vez de reinventado. */
export function authedJson(token: string, body?: unknown, method?: "GET" | "POST" | "PATCH" | "DELETE"): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body === undefined) return { method: method ?? "GET", headers };
  const raw = JSON.stringify(body);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  return { method: method ?? "POST", body: raw, headers };
}
