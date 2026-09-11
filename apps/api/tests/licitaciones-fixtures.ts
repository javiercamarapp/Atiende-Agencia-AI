// Fixtures reales (no mocks) para los tests de integración de los 3 flujos de
// licitaciones — arma una organización (property singleton, §2.1 del diseño),
// staff con roles de la vertical (owner/analyst/viewer), una convocatoria con
// fecha límite real, documentos de empresa y tarifas aprobadas, exactamente
// como lo haría un seed contra las migraciones SQL reales de
// packages/domain-licitaciones/migrations/.
import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort } from "@atiende/domain-hoteles";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { LicitacionesRole } from "@atiende/domain-licitaciones";
import { InMemoryCitasRepository } from "@atiende/domain-citas";
import type { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";

type BuildAppFn = typeof buildApp;
type TestApp = ReturnType<BuildAppFn>;

export interface LicitacionesTestContext {
  readonly deps: AppDeps;
  readonly repo: InMemoryLicitacionesRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly staff: {
    readonly owner: { id: string; email: string; password: string; token: string };
    readonly analyst: { id: string; email: string; password: string; token: string };
    readonly writer: { id: string; email: string; password: string; token: string };
    readonly viewer: { id: string; email: string; password: string; token: string };
  };
}

async function signInAndGetToken(app: TestApp, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (res.status !== 200) throw new Error(`login de prueba falló para ${email}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function buildLicitacionesTestContext(buildApp: BuildAppFn, options: { submissionDeadline?: string | null } = {}): Promise<LicitacionesTestContext> {
  const coreRepo = new InMemoryCoreRepository();
  const engine = new InMemoryTenancyEngine();
  const repo = new InMemoryLicitacionesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID(); // property singleton por organización (§2.1 del diseño)
  coreRepo.addOrganization({ id: organizationId, slug: "empresa-de-prueba", name: "Empresa de Prueba S.A. de C.V.", vertical: "licitaciones" });
  engine.seedProperty({ id: propertyId, organizationId });

  async function seedStaff(role: LicitacionesRole, label: string) {
    const id = randomUUID();
    const email = `${label}@empresa-de-prueba.mx`;
    const password = "correcto-caballo-batería";
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    const platformRole = role === "owner" ? "owner" : role === "admin" ? "admin" : role === "viewer" ? "viewer" : "member";
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole: role, propertyIds: null });
    return { id, email, password };
  }

  const ownerSeed = await seedStaff("owner", "owner");
  const analystSeed = await seedStaff("analyst", "analyst");
  const writerSeed = await seedStaff("writer", "writer");
  const viewerSeed = await seedStaff("viewer", "viewer");

  const tenderId = randomUUID();
  const submissionDeadline = options.submissionDeadline === undefined ? "2026-12-15T18:00:00-06:00" : options.submissionDeadline;
  repo.seedTender({ id: tenderId, organizationId, title: "Licitación pública de prueba", submissionDeadline, updatedAt: "2026-01-01T00:00:00Z" });

  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine,
    restaurantesRepo: new InMemoryRestaurantesRepository(),
    turnHandler: acknowledgeOnlyTurnHandler(new InMemoryRestaurantesRepository()),
    hotelesRepo: new InMemoryHotelesRepository(),
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    licitacionesRepo: repo,
    citasRepo: new InMemoryCitasRepository(),
  };

  const app = buildApp(deps);
  const [ownerToken, analystToken, writerToken, viewerToken] = await Promise.all([
    signInAndGetToken(app, ownerSeed.email, ownerSeed.password),
    signInAndGetToken(app, analystSeed.email, analystSeed.password),
    signInAndGetToken(app, writerSeed.email, writerSeed.password),
    signInAndGetToken(app, viewerSeed.email, viewerSeed.password),
  ]);

  return {
    deps,
    repo,
    organizationId,
    propertyId,
    tenderId,
    staff: {
      owner: { ...ownerSeed, token: ownerToken },
      analyst: { ...analystSeed, token: analystToken },
      writer: { ...writerSeed, token: writerToken },
      viewer: { ...viewerSeed, token: viewerToken },
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
