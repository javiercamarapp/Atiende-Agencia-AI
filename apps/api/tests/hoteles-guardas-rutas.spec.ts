// H-36 -- prueba de guardas que DESCUBRE todas las rutas de staff `/hoteles/:propertyId/*` desde la
// app real (no desde una lista escrita a mano) y exige, para cada una:
//   1. sin token -> 401;
//   2. un usuario de OTRA organizacion (cross-tenant) -> nunca 2xx (403/404);
//   3. cada rol FUERA de su acceso declarado en `hoteles-guardas-matriz.ts` -> 403;
//   4. cada rol dentro de su acceso declarado -> ni 401 ni 403 (no se le cierra una puerta que le toca).
// Una ruta nueva sin declarar en la matriz hace fallar la suite: nadie publica un endpoint de staff
// sin decidir a proposito que roles lo usan. Mismo patron que `app/admin/guardas.test.ts` de Likida.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { HOTEL_ROLES, type HotelRole } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, type HotelesTestContext } from "./hoteles-fixtures.ts";
import { MATRIZ_GUARDAS } from "./hoteles-guardas-matriz.ts";

const PASSWORD = "correcto-caballo-batería";
const UUID_PARAM = "00000000-0000-4000-8000-000000000001";
const STAFF_PREFIX = "/hoteles/:propertyId/";

interface Ruta {
  readonly clave: string;
  readonly metodo: string;
  readonly plantilla: string;
}

function descubrirRutas(app: ReturnType<typeof buildApp>): Ruta[] {
  const unicas = new Map<string, Ruta>();
  for (const r of app.routes) {
    if (r.method === "ALL" || !r.path.startsWith(STAFF_PREFIX)) continue;
    const plantilla = r.path.slice("/hoteles/:propertyId".length);
    unicas.set(`${r.method} ${plantilla}`, { clave: `${r.method} ${plantilla}`, metodo: r.method, plantilla });
  }
  return [...unicas.values()].sort((a, b) => a.clave.localeCompare(b.clave));
}

async function login(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login de prueba fallo para ${email}: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function sembrarStaff(ctx: HotelesTestContext, organizationId: string, role: HotelRole, email: string): Promise<void> {
  const id = randomUUID();
  const coreRepo = ctx.deps.coreRepo as unknown as {
    addStaff(s: object): void;
    addMembership(m: object): void;
  };
  coreRepo.addStaff({ id, email, fullName: email, passwordHash: await hashPassword(PASSWORD), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  const membership = { userId: id, organizationId, platformRole: "member", verticalRole: role, propertyIds: null };
  coreRepo.addMembership(membership);
  (ctx.deps.engine as unknown as { seedMembership(m: object): void }).seedMembership(membership);
}

function peticion(r: Ruta, propertyId: string, token: string | null): [string, RequestInit] {
  const path = `/hoteles/${propertyId}${r.plantilla.replace(/:[A-Za-z]+/g, UUID_PARAM)}`;
  const headers: Record<string, string> = { "idempotency-key": "guardas-k" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (r.metodo === "GET") return [path, { method: "GET", headers }];
  headers["content-type"] = "application/json";
  headers["content-length"] = "2";
  return [path, { method: r.metodo, headers, body: "{}" }];
}

async function preparar() {
  const ctx = await buildHotelesTestContext(buildApp);
  const app = buildApp(ctx.deps);
  await sembrarStaff(ctx, ctx.organizationId, "maintenance", "mantenimiento@hotel-de-prueba.mx");
  // Usuario de OTRA organizacion: owner de otro hotel, sin membresia en la property bajo prueba.
  const otraOrganizacion = randomUUID();
  (ctx.deps.coreRepo as unknown as { addOrganization(o: object): void }).addOrganization({ id: otraOrganizacion, slug: "otro-hotel", name: "Otro Hotel", vertical: "hoteles" });
  await sembrarStaff(ctx, otraOrganizacion, "owner", "owner-otro-hotel@otro-hotel.mx");
  const tokens: Record<HotelRole, string> = {
    owner: ctx.staff.owner.token,
    gm: ctx.staff.gm.token,
    frontdesk: ctx.staff.frontdesk.token,
    reservations: ctx.staff.reservations.token,
    housekeeping: ctx.staff.housekeeping.token,
    fnb: ctx.staff.fnb.token,
    accountant: ctx.staff.accountant.token,
    maintenance: await login(app, "mantenimiento@hotel-de-prueba.mx"),
  };
  const tokenOtroTenant = await login(app, "owner-otro-hotel@otro-hotel.mx");
  return { ctx, app, tokens, tokenOtroTenant, rutas: descubrirRutas(app) };
}

describe("H-36 guardas por rol de las rutas /hoteles/:propertyId/*", () => {
  it("la matriz declara exactamente las rutas que existen (ni una nueva sin decidir, ni una borrada sin limpiar)", async () => {
    const { rutas } = await preparar();
    const descubiertas = rutas.map((r) => r.clave);
    const declaradas = Object.keys(MATRIZ_GUARDAS);
    expect(descubiertas.filter((k) => !(k in MATRIZ_GUARDAS)), "rutas sin declarar en hoteles-guardas-matriz.ts").toEqual([]);
    expect(declaradas.filter((k) => !descubiertas.includes(k)), "entradas de la matriz sin ruta").toEqual([]);
    expect(descubiertas.length).toBeGreaterThan(150);
  });

  it("sin token toda ruta responde 401, y un usuario de otra organizacion nunca obtiene 2xx", async () => {
    const { ctx, app, tokenOtroTenant, rutas } = await preparar();
    const fallos: string[] = [];
    for (const r of rutas) {
      const sin = await app.request(...peticion(r, ctx.propertyId, null));
      if (sin.status !== 401) fallos.push(`${r.clave} sin token -> ${sin.status} (se esperaba 401)`);
      const otro = await app.request(...peticion(r, ctx.propertyId, tokenOtroTenant));
      if (otro.status !== 403 && otro.status !== 404) fallos.push(`${r.clave} cross-tenant -> ${otro.status} (se esperaba 403/404)`);
    }
    expect(fallos).toEqual([]);
  }, 120_000);

  it("cada rol fuera de su acceso declarado recibe 403 y cada rol dentro de el no es bloqueado", async () => {
    const { ctx, app, tokens, rutas } = await preparar();
    const fallos: string[] = [];
    for (const r of rutas) {
      const acceso = MATRIZ_GUARDAS[r.clave];
      if (acceso === undefined || acceso === "por-transicion") continue;
      for (const rol of HOTEL_ROLES) {
        const permitido = acceso === "todos" || acceso.includes(rol);
        const res = await app.request(...peticion(r, ctx.propertyId, tokens[rol]));
        if (!permitido && res.status !== 403) fallos.push(`${r.clave} como ${rol} -> ${res.status} (debia ser 403)`);
        if (permitido && (res.status === 403 || res.status === 401)) fallos.push(`${r.clave} como ${rol} -> ${res.status} (el rol tiene acceso declarado)`);
      }
    }
    expect(fallos).toEqual([]);
  }, 300_000);

  it("las rutas sensibles de dinero, fiscal, identidad y privacidad nunca quedan abiertas a todos los roles", () => {
    const sensibles = Object.entries(MATRIZ_GUARDAS).filter(([k]) => /\/(cfdi|fraude|night-audit|pl|identidad|privacidad|asistencia\/(horarios|cruce|exportar-stps))/.test(k));
    expect(sensibles.length).toBeGreaterThan(30);
    expect(sensibles.filter(([, acceso]) => acceso === "todos").map(([k]) => k)).toEqual([]);
    // housekeeping y mantenimiento jamas tocan dinero.
    for (const [k, acceso] of Object.entries(MATRIZ_GUARDAS)) {
      if (!/\/folios\//.test(k) || acceso === "todos" || acceso === "por-transicion") continue;
      expect(acceso, k).not.toContain("housekeeping");
      expect(acceso, k).not.toContain("maintenance");
    }
  });
});
