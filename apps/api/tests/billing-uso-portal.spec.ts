// PL-16: GET /billing/uso (consumo del mes, tope del plan, fin de prueba y estado del portal) y POST /billing/portal (sesion del
// Billing Portal de Stripe) -- fail-closed sin llave o sin customer (503 honesto con el motivo), solo owner/admin, cross-tenant
// aislado y base sin migrar sin 500. La autoridad real de la lectura (miembro/superadmin) vive en SQL
// (scripts/verify-planes-topes-prueba); aqui el doble de sesion reproduce su contrato: NULL para quien no es miembro.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import type { StripeBillingPortalClient } from "@atiende/billing";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

class FakePortal implements StripeBillingPortalClient {
  calls: Array<{ customerId: string; returnUrl: string }> = [];
  failWith: Error | null = null;
  async crearSesionPortal(opts: { customerId: string; returnUrl: string }) {
    this.calls.push(opts);
    if (this.failWith) throw this.failWith;
    return { url: `https://billing.stripe.com/session/test_${this.calls.length}` };
  }
}

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const USO = (org: string) => ({
  organizationId: org,
  slug: "los-taquitos-de-pm",
  vertical: "restaurantes",
  periodo: "2026-10-01",
  zonaHoraria: "America/Merida",
  mensajes: { usado: 801, limite: 1000, accion: "pausar", excedente: 0, proactivosOmitidos: 2 },
  plan: { id: "restaurantes-estandar", nombre: "Restaurantes Estándar" },
  prueba: { activa: true, terminaEn: "2026-11-10T18:00:00+00:00", diasRestantes: 7 },
});

/** Motor falso: la lectura devuelve el documento solo a los usuarios "miembros" y NULL al resto (contrato de core.message_usage_for_org). */
function motor(opts: { org: string; miembros: ReadonlySet<string>; sinMigrar?: boolean }) {
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const sesion: TenantDbSession = {
    async query(sql: string, params?: unknown[]) {
      llamadas.push({ sql, params: params ?? [] });
      if (/message_usage_for_org/.test(sql)) {
        if (opts.sinMigrar) throw pgError("42883", "function core.message_usage_for_org(uuid, uuid) does not exist");
        const [caller, org] = (params ?? []) as [string, string];
        return { rows: [{ r: opts.miembros.has(caller) && org === opts.org ? USO(org) : null }] } as never;
      }
      return { rows: [] } as never;
    },
    async exec() {
      return undefined;
    },
  } as unknown as TenantDbSession;
  return { engine: { withAppSession: async (_c: unknown, fn: (s: TenantDbSession) => Promise<unknown>) => fn(sesion) }, llamadas };
}

async function tokenFor(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], userId: string, email: string): Promise<string> {
  return signAccessToken({ sub: userId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
}

async function setup(opts: { conStripe?: boolean; conCustomer?: boolean; sinMigrar?: boolean } = {}) {
  const base = await buildTestDeps();
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const ownerId = (await coreRepo.findStaffByEmail(base.ownerEmail))!.id;
  const memberId = randomUUID();
  coreRepo.addStaff({ id: memberId, email: "miembro@lostaquitos.mx", fullName: "Miembro", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
  coreRepo.addMembership({ userId: memberId, organizationId: base.organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });
  const intruderId = randomUUID();
  coreRepo.addStaff({ id: intruderId, email: "intruso@otra-org.mx", fullName: "Intruso", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
  if (opts.conCustomer) {
    await coreRepo.upsertOrganizationBilling({ organizationId: base.organizationId, stripeCustomerId: "cus_real1234567", stripeSubscriptionId: "sub_1", priceId: "price_1", seats: 1, status: "activa", currentPeriodEnd: null });
  }
  const portal = new FakePortal();
  const m = motor({ org: base.organizationId, miembros: new Set([ownerId, memberId]), ...(opts.sinMigrar ? { sinMigrar: true } : {}) });
  const deps = { ...base.deps, engine: m.engine, ...(opts.conStripe === false ? {} : { saasBillingPortalClient: portal }) } as unknown as typeof base.deps;
  const app = buildApp(deps);
  return {
    app,
    portal,
    org: base.organizationId,
    owner: await tokenFor(deps, ownerId, base.ownerEmail),
    member: await tokenFor(deps, memberId, "miembro@lostaquitos.mx"),
    intruder: await tokenFor(deps, intruderId, "intruso@otra-org.mx"),
  };
}

const get = (app: ReturnType<typeof buildApp>, path: string, token?: string) => app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});
const post = (app: ReturnType<typeof buildApp>, path: string, token: string, body: unknown) => app.request(path, jsonRequestInit(body, { authorization: `Bearer ${token}` }));

describe("GET /billing/uso", () => {
  it("el owner ve consumo, tope, prueba y portal disponible (con llave y customer)", async () => {
    const t = await setup({ conCustomer: true });
    const res = await get(t.app, `/billing/uso?organizationId=${t.org}`, t.owner);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      disponible: true,
      periodo: "2026-10-01",
      mensajes: { usado: 801, limite: 1000, accion: "pausar", proactivosOmitidos: 2 },
      plan: { id: "restaurantes-estandar" },
      prueba: { activa: true, diasRestantes: 7 },
      portal: { disponible: true, motivo: null, explicacion: null },
    });
  });

  it("sin STRIPE_SECRET_KEY el portal se reporta no disponible con la explicacion honesta (la UI lo muestra deshabilitado)", async () => {
    const t = await setup({ conStripe: false, conCustomer: true });
    const body = (await (await get(t.app, `/billing/uso?organizationId=${t.org}`, t.owner)).json()) as { portal: { disponible: boolean; motivo: string; explicacion: string } };
    expect(body.portal).toMatchObject({ disponible: false, motivo: "sin_llave_stripe" });
    expect(body.portal.explicacion).toContain("STRIPE_SECRET_KEY");
  });

  it("con llave pero sin customer de Stripe: 'sin_cliente_stripe'", async () => {
    const t = await setup({ conCustomer: false });
    const body = (await (await get(t.app, `/billing/uso?organizationId=${t.org}`, t.owner)).json()) as { portal: { disponible: boolean; motivo: string } };
    expect(body.portal).toMatchObject({ disponible: false, motivo: "sin_cliente_stripe" });
  });

  it("un miembro (no owner/admin) ve el consumo pero el portal queda 'solo_administradores'", async () => {
    const t = await setup({ conCustomer: true });
    const res = await get(t.app, `/billing/uso?organizationId=${t.org}`, t.member);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mensajes: { usado: number }; portal: { disponible: boolean; motivo: string } };
    expect(body.mensajes.usado).toBe(801);
    expect(body.portal).toMatchObject({ disponible: false, motivo: "solo_administradores" });
  });

  it("cross-tenant: un usuario que no es de la organizacion recibe 403 y nada de su consumo", async () => {
    const t = await setup({ conCustomer: true });
    const res = await get(t.app, `/billing/uso?organizationId=${t.org}`, t.intruder);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("801");
  });

  it("sin token 401; organizationId invalido 400; sin organizacion ni en la sesion ni en la query 400", async () => {
    const t = await setup();
    expect((await get(t.app, `/billing/uso?organizationId=${t.org}`)).status).toBe(401);
    expect((await get(t.app, "/billing/uso?organizationId=no-es-uuid", t.owner)).status).toBe(400);
    expect((await get(t.app, "/billing/uso", t.owner)).status).toBe(400);
  });

  it("base sin la migracion 0045: 200 con disponible:false (nunca 500)", async () => {
    const t = await setup({ sinMigrar: true });
    const res = await get(t.app, `/billing/uso?organizationId=${t.org}`, t.owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
  });
});

describe("POST /billing/portal", () => {
  it("el owner obtiene la URL del portal con el customer de SU organizacion y vuelve a Plan y uso", async () => {
    const t = await setup({ conCustomer: true });
    const res = await post(t.app, "/billing/portal", t.owner, { organizationId: t.org });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe("https://billing.stripe.com/session/test_1");
    expect(t.portal.calls).toHaveLength(1);
    expect(t.portal.calls[0]!.customerId).toBe("cus_real1234567");
    expect(t.portal.calls[0]!.returnUrl).toMatch(/\/restaurantes\/los-taquitos-de-pm\/plan$/);
  });

  it("sin STRIPE_SECRET_KEY responde 503 honesto con el motivo y NO inventa una URL", async () => {
    const t = await setup({ conStripe: false, conCustomer: true });
    const res = await post(t.app, "/billing/portal", t.owner, { organizationId: t.org });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("service_unavailable");
    expect(body.message).toContain("STRIPE_SECRET_KEY");
    expect(t.portal.calls).toHaveLength(0);
  });

  it("sin customer de Stripe responde 503 honesto distinto (todavia no hay suscripcion)", async () => {
    const t = await setup({ conCustomer: false });
    const res = await post(t.app, "/billing/portal", t.owner, { organizationId: t.org });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("suscripción");
    expect(t.portal.calls).toHaveLength(0);
  });

  it("un miembro (no owner/admin) y un usuario de otra organizacion reciben 403 y Stripe nunca se llama", async () => {
    const t = await setup({ conCustomer: true });
    expect((await post(t.app, "/billing/portal", t.member, { organizationId: t.org })).status).toBe(403);
    expect((await post(t.app, "/billing/portal", t.intruder, { organizationId: t.org })).status).toBe(403);
    expect(t.portal.calls).toHaveLength(0);
  });

  it("Stripe no puede crear la sesion (portal sin configurar en el dashboard): 502 con explicacion, sin filtrar el error crudo", async () => {
    const t = await setup({ conCustomer: true });
    t.portal.failWith = new Error("Stripe respondió 400: No configuration provided cus_real1234567");
    const err = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post(t.app, "/billing/portal", t.owner, { organizationId: t.org });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("cus_real1234567");
    err.mockRestore();
  });

  it("base sin migrar: el portal sigue funcionando (no depende del medidor) y vuelve al login de la vertical", async () => {
    const t = await setup({ conCustomer: true, sinMigrar: true });
    const res = await post(t.app, "/billing/portal", t.owner, { organizationId: t.org });
    expect(res.status).toBe(200);
    expect(t.portal.calls[0]!.returnUrl).toMatch(/\/restaurantes\/login$/);
  });

  it("sin token 401; organizationId invalido 400", async () => {
    const t = await setup({ conCustomer: true });
    expect((await t.app.request("/billing/portal", jsonRequestInit({ organizationId: t.org }))).status).toBe(401);
    expect((await post(t.app, "/billing/portal", t.owner, { organizationId: "no-es-uuid" })).status).toBe(400);
  });
});
