import { randomUUID } from "node:crypto";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { InMemoryRestaurantesRepository, acknowledgeOnlyTurnHandler } from "@atiende/domain-restaurantes";
import { InMemoryHotelesRepository, InMemoryPaymentsPort, acknowledgeOnlyTurnHandler as hotelesAcknowledgeOnlyTurnHandler } from "@atiende/domain-hoteles";
import { acknowledgeOnlyTurnHandler as acknowledgeOnlyCitasTurnHandler, createDefaultConversationGuard, createGoogleCalendarPortResolver, InMemoryCitasRepository } from "@atiende/domain-citas";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryRentasRepository } from "@atiende/domain-rentas";
import type { AppDeps } from "../src/deps.ts";
import type { ApiEnv } from "../src/env.ts";

export const TEST_ENV: ApiEnv = {
  jwtSecret: "test-jwt-secret",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 60 * 60 * 24 * 30,
  voiceToolSecret: "test-voice-tool-secret",
  whatsappVerifyToken: "test-verify-token",
  whatsappAppSecret: "test-whatsapp-app-secret",
  internalSecret: "test-internal-secret",
  allowedOrigins: ["http://localhost:5173"],
  googleOAuth: { clientId: "test-google-client-id", clientSecret: "test-google-client-secret", redirectBaseUrl: "https://api.test.invalid" },
};

export async function buildTestDeps(): Promise<{ deps: AppDeps; organizationId: string; propertyId: string; products: Record<string, string>; ownerEmail: string; ownerPassword: string }> {
  const coreRepo = new InMemoryCoreRepository();
  const restaurantesRepo = new InMemoryRestaurantesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  restaurantesRepo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  restaurantesRepo.seedBranch({
    propertyId,
    organizationId,
    name: "Francisco de Montejo",
    slug: "fco-montejo",
    status: "active",
    phone: "+529991234567",
    address: "Calle 1 #100, Mérida",
    lat: 21.0186,
    lng: -89.6708,
  });

  const catTacos = randomUUID();
  restaurantesRepo.seedCategory({ id: catTacos, organizationId, name: "Tacos" });
  const tacosPastor = randomUUID();
  restaurantesRepo.seedProduct({ id: tacosPastor, organizationId, categoryId: catTacos, name: "Tacos de Bistec de Res (orden de 3)", description: null, searchKeywords: [] });
  restaurantesRepo.seedBranchProduct({ propertyId, productId: tacosPastor, price: 164, isAvailable: true });

  const catBebidas = randomUUID();
  restaurantesRepo.seedCategory({ id: catBebidas, organizationId, name: "Bebidas" });
  const cocaCola = randomUUID();
  restaurantesRepo.seedProduct({ id: cocaCola, organizationId, categoryId: catBebidas, name: "Coca-Cola", description: null, searchKeywords: [] });
  restaurantesRepo.seedBranchProduct({ propertyId, productId: cocaCola, price: 45, isAvailable: true });

  restaurantesRepo.seedWhatsAppChannel(organizationId, "1234567890");

  const ownerEmail = "dueño@lostaquitos.mx";
  const ownerPassword = "correcto-caballo-batería";
  const ownerId = randomUUID();
  coreRepo.addStaff({
    id: ownerId,
    email: ownerEmail,
    fullName: "Dueño de Los Taquitos",
    passwordHash: await hashPassword(ownerPassword),
    createdVia: "seed",
    emailVerifiedAt: new Date().toISOString(),
  });
  coreRepo.addOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
  coreRepo.addMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const hotelesRepo = new InMemoryHotelesRepository();
  const citasRepo = new InMemoryCitasRepository();
  const deps: AppDeps = {
    env: TEST_ENV,
    coreRepo,
    engine: new InMemoryTenancyEngine(),
    restaurantesRepo,
    turnHandler: acknowledgeOnlyTurnHandler(restaurantesRepo),
    hotelesRepo,
    hotelesPaymentsPort: new InMemoryPaymentsPort(),
    hotelesTurnHandler: hotelesAcknowledgeOnlyTurnHandler(hotelesRepo),
    citasRepo,
    citasTurnHandler: acknowledgeOnlyCitasTurnHandler(),
    citasConversationGuard: createDefaultConversationGuard(),
    // Fase 3 — sin credenciales de Google configuradas en este fixture genérico
    // (no relacionado con citas): el resolver real ya devuelve `null` siempre
    // (config: null), y el exchange nunca debería llamarse aquí.
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(citasRepo, null),
    citasGoogleTokenExchange: async () => {
      throw new Error("citasGoogleTokenExchange no está configurado en este fixture de pruebas genérico.");
    },
    licitacionesRepo: new InMemoryLicitacionesRepository(),
    despachosRepo: new InMemoryDespachosRepository(),
    despachosAuditSink: new InMemoryAuditSink(),
    rentasRepo: new InMemoryRentasRepository(),
  };

  return { deps, organizationId, propertyId, products: { tacosPastor, cocaCola }, ownerEmail, ownerPassword };
}

/** `readJsonCapped` exige un header `content-length` explícito (igual que el origen
 * Deno) — los helpers de test de Hono/undici no siempre lo agregan solos al
 * construir un Request local, así que se calcula y adjunta aquí, como lo haría
 * cualquier cliente HTTP real. */
export function jsonRequestInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  const raw = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(raw).byteLength;
  return {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "content-length": String(byteLength), ...headers },
  };
}
