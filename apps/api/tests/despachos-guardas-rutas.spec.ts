// D-15 -- prueba de guardas que DESCUBRE todas las rutas de staff de despachos (`/despachos/:propertyId/*` y `/v1/despachos/*`)
// desde la app real (no desde una lista escrita a mano) y exige, para cada una:
//   1. sin token -> 401;
//   2. un usuario de OTRA organizacion (cross-tenant) -> nunca 2xx (403/404), sin filtrar datos;
//   3. cada rol FUERA de su acceso declarado en `despachos-guardas-matriz.ts` -> 403;
//   4. cada rol dentro de su acceso declarado -> ni 401 ni 403 (no se le cierra una puerta que le toca);
//   5. un staff de la MISMA organizacion pero acotado a OTRA property -> 403 en toda ruta de property;
//   6. auditor y readonly nunca escriben (todo POST/PUT/PATCH/DELETE los excluye, salvo las calculadoras puras declaradas).
// Una ruta nueva sin declarar en la matriz hace fallar la suite: nadie publica un endpoint de staff sin decidir a proposito que roles
// lo usan. Mismo patron que `hoteles-guardas-rutas.spec.ts` y `app/admin/guardas.test.ts` de Likida. Leccion real del 1-oct: #302 rompio
// main por no declarar sus rutas en la matriz de hoteles.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { DESPACHOS_ROLES, type DespachosRole } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext, type DespachosTestContext } from "./despachos-fixtures.ts";
import { ESCRITURAS_PERSONALES_DEL_CHAT, MATRIZ_GUARDAS, POST_DE_SOLO_CALCULO, RUTAS_CON_STEP_UP } from "./despachos-guardas-matriz.ts";

const PASSWORD = "correcto-caballo-batería";
const UUID_PARAM = "00000000-0000-4000-8000-000000000001";
const PROPERTY_PREFIX = "/despachos/:propertyId";
const ORG_PREFIX = "/v1/despachos/";
const ORG_SLUG = "despacho-de-prueba";

interface Ruta {
  readonly clave: string;
  readonly metodo: string;
  /** Ruta de la app con parametros (`/despachos/:propertyId/cfdi/:invoiceId`). */
  readonly ruta: string;
  readonly deProperty: boolean;
}

/** Rutas de staff registradas en `app` bajo `/despachos/:propertyId/*` y `/v1/despachos/*` (middlewares `ALL` fuera). */
export function descubrirRutas(app: { readonly routes: ReadonlyArray<{ readonly method: string; readonly path: string }> }): Ruta[] {
  const unicas = new Map<string, Ruta>();
  for (const r of app.routes) {
    if (r.method === "ALL") continue;
    const deProperty = r.path.startsWith(`${PROPERTY_PREFIX}/`);
    if (!deProperty && !r.path.startsWith(ORG_PREFIX)) continue;
    const clave = `${r.method} ${deProperty ? r.path.slice(PROPERTY_PREFIX.length) : r.path}`;
    unicas.set(clave, { clave, metodo: r.method, ruta: r.path, deProperty });
  }
  return [...unicas.values()].sort((a, b) => a.clave.localeCompare(b.clave));
}

/** Claves descubiertas que la matriz no declara (lo que hace fallar la suite al agregar una ruta sin decidir sus roles). */
export function rutasSinDeclarar(descubiertas: readonly string[], matriz: Readonly<Record<string, unknown>>): string[] {
  return descubiertas.filter((k) => !(k in matriz));
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

async function sembrarStaff(
  ctx: DespachosTestContext,
  input: { readonly organizationId: string; readonly role: DespachosRole; readonly email: string; readonly propertyIds: string[] | null },
): Promise<void> {
  const id = randomUUID();
  const coreRepo = ctx.deps.coreRepo as unknown as { addStaff(s: object): void; addMembership(m: object): void };
  coreRepo.addStaff({ id, email: input.email, fullName: input.email, passwordHash: await hashPassword(PASSWORD), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  const platformRole = input.role === "admin" ? "owner" : input.role === "contador" ? "admin" : "viewer";
  const membership = { userId: id, organizationId: input.organizationId, platformRole, verticalRole: input.role, propertyIds: input.propertyIds };
  coreRepo.addMembership(membership);
  (ctx.deps.engine as unknown as { seedMembership(m: object): void }).seedMembership(membership);
}

function peticion(r: Ruta, propertyId: string, token: string | null): [string, RequestInit] {
  const concreta = r.ruta.replace(":propertyId", propertyId).replace(":orgSlug", ORG_SLUG).replace(/:[A-Za-z]+/g, UUID_PARAM);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (r.metodo === "GET") return [concreta, { method: "GET", headers }];
  headers["content-type"] = "application/json";
  headers["content-length"] = "2";
  return [concreta, { method: r.metodo, headers, body: "{}" }];
}

async function preparar() {
  const ctx = await buildDespachosTestContext(buildApp);
  const app = buildApp(ctx.deps);
  // Usuario de OTRA organizacion: admin de otro despacho, sin membresia en la property bajo prueba.
  const otraOrganizacion = randomUUID();
  (ctx.deps.coreRepo as unknown as { addOrganization(o: object): void }).addOrganization({ id: otraOrganizacion, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
  await sembrarStaff(ctx, { organizationId: otraOrganizacion, role: "admin", email: "admin@otro-despacho.mx", propertyIds: null });
  // Admin de LA MISMA organizacion pero acotado a OTRA property: no debe cruzar al cliente bajo prueba.
  const otraProperty = randomUUID();
  (ctx.deps.engine as unknown as { seedProperty(p: object): void }).seedProperty({ id: otraProperty, organizationId: ctx.organizationId });
  await sembrarStaff(ctx, { organizationId: ctx.organizationId, role: "admin", email: "acotado@despacho-de-prueba.mx", propertyIds: [otraProperty] });
  const tokens: Record<DespachosRole, string> = {
    admin: ctx.staff.admin.token,
    contador: ctx.staff.contador.token,
    auditor: ctx.staff.auditor.token,
    readonly: ctx.staff.readonly.token,
  };
  return {
    ctx,
    app,
    tokens,
    tokenOtroTenant: await login(app, "admin@otro-despacho.mx"),
    tokenAcotado: await login(app, "acotado@despacho-de-prueba.mx"),
    rutas: descubrirRutas(app),
  };
}

describe("D-15 guardas por rol de las rutas /despachos/:propertyId/* y /v1/despachos/*", () => {
  it("la matriz declara exactamente las rutas que existen (ni una nueva sin decidir, ni una borrada sin limpiar)", async () => {
    const { rutas } = await preparar();
    const descubiertas = rutas.map((r) => r.clave);
    const declaradas = Object.keys(MATRIZ_GUARDAS);
    expect(rutasSinDeclarar(descubiertas, MATRIZ_GUARDAS), "rutas sin declarar en despachos-guardas-matriz.ts").toEqual([]);
    expect(declaradas.filter((k) => !descubiertas.includes(k)), "entradas de la matriz sin ruta").toEqual([]);
    expect(descubiertas.length).toBeGreaterThan(120);
    // Las rutas de nivel organizacion tambien quedan cubiertas.
    expect(descubiertas.filter((k) => k.includes(" /v1/despachos/")).length).toBeGreaterThanOrEqual(5);
  });

  it("sanidad: una ruta nueva sin declarar en la matriz es detectada (la suite fallaria)", async () => {
    const { ctx } = await preparar();
    const app = buildApp(ctx.deps);
    const antes = descubrirRutas(app).map((r) => r.clave);
    expect(rutasSinDeclarar(antes, MATRIZ_GUARDAS)).toEqual([]);

    // Alguien agrega una ruta de despachos (de property y de organizacion) sin tocar la matriz.
    app.get("/despachos/:propertyId/ruta-nueva-sin-declarar", (c) => c.json({ ok: true }));
    app.post("/v1/despachos/:orgSlug/admin/otra-ruta-nueva", (c) => c.json({ ok: true }));
    const despues = descubrirRutas(app).map((r) => r.clave);
    expect(rutasSinDeclarar(despues, MATRIZ_GUARDAS)).toEqual(["GET /ruta-nueva-sin-declarar", "POST /v1/despachos/:orgSlug/admin/otra-ruta-nueva"]);

    // Y una ruta que se BORRA sin limpiar la matriz tambien se detecta (entrada de la matriz sin ruta).
    const borrada = Object.keys(MATRIZ_GUARDAS).filter((k) => !antes.includes(k));
    expect(borrada).toEqual([]);
    expect(Object.keys({ ...MATRIZ_GUARDAS, "GET /ruta-inexistente": MATRIZ_GUARDAS["GET /cfdi"] }).filter((k) => !antes.includes(k))).toEqual(["GET /ruta-inexistente"]);
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

  it("un cross-tenant no recibe datos del despacho ajeno: el cuerpo del rechazo no incluye identificadores del cliente", async () => {
    const { ctx, app, tokenOtroTenant, rutas } = await preparar();
    const fugas: string[] = [];
    for (const r of rutas.filter((x) => x.deProperty && x.metodo === "GET")) {
      const res = await app.request(...peticion(r, ctx.propertyId, tokenOtroTenant));
      const cuerpo = await res.text();
      if (cuerpo.includes(ctx.propertyId) || cuerpo.includes(ctx.organizationId) || cuerpo.includes("Sede principal")) fugas.push(r.clave);
    }
    expect(fugas).toEqual([]);
  }, 120_000);

  it("cada rol fuera de su acceso declarado recibe 403 y cada rol dentro de el no es bloqueado", async () => {
    const { ctx, app, tokens, rutas } = await preparar();
    const fallos: string[] = [];
    for (const r of rutas) {
      const acceso = MATRIZ_GUARDAS[r.clave];
      if (acceso === undefined) continue;
      for (const rol of DESPACHOS_ROLES) {
        const permitido = acceso.includes(rol);
        const res = await app.request(...peticion(r, ctx.propertyId, tokens[rol]));
        if (!permitido && res.status !== 403) fallos.push(`${r.clave} como ${rol} -> ${res.status} (debia ser 403)`);
        if (permitido && (res.status === 403 || res.status === 401)) fallos.push(`${r.clave} como ${rol} -> ${res.status} (el rol tiene acceso declarado)`);
      }
    }
    expect(fallos).toEqual([]);
  }, 300_000);

  it("un staff de la misma organizacion acotado a OTRA property no entra a ninguna ruta de este cliente ni a las de toda la organizacion", async () => {
    const { ctx, app, tokenAcotado, rutas } = await preparar();
    const fallos: string[] = [];
    for (const r of rutas) {
      const res = await app.request(...peticion(r, ctx.propertyId, tokenAcotado));
      if (r.deProperty && res.status !== 403) fallos.push(`${r.clave} acotado a otra property -> ${res.status} (se esperaba 403)`);
    }
    // Las de organizacion que exigen alcance de TODA la organizacion (alta de cartera y bitacora) tambien lo rechazan.
    for (const clave of ["POST /v1/despachos/:orgSlug/admin/cartera", "GET /v1/despachos/:orgSlug/admin/bitacora"]) {
      const r = rutas.find((x) => x.clave === clave)!;
      const res = await app.request(...peticion(r, ctx.propertyId, tokenAcotado));
      if (res.status !== 403) fallos.push(`${clave} acotado -> ${res.status} (se esperaba 403)`);
    }
    expect(fallos).toEqual([]);
  }, 120_000);

  it("auditor y readonly nunca escriben: todo POST/PUT/PATCH/DELETE los excluye, salvo las calculadoras puras declaradas", () => {
    const escrituras = Object.entries(MATRIZ_GUARDAS).filter(([k]) => !k.startsWith("GET "));
    expect(escrituras.length).toBeGreaterThan(80);
    for (const [clave, acceso] of escrituras) {
      if (POST_DE_SOLO_CALCULO.includes(clave) || ESCRITURAS_PERSONALES_DEL_CHAT.includes(clave)) continue;
      expect(acceso, clave).not.toContain("auditor");
      expect(acceso, clave).not.toContain("readonly");
    }
    // Las listas de excepciones solo contienen rutas que existen; las calculadoras son POST y las del chat solo viven bajo /chat-datos.
    for (const clave of POST_DE_SOLO_CALCULO) {
      expect(clave in MATRIZ_GUARDAS, clave).toBe(true);
      expect(clave.startsWith("POST "), clave).toBe(true);
    }
    for (const clave of ESCRITURAS_PERSONALES_DEL_CHAT) {
      expect(clave in MATRIZ_GUARDAS, clave).toBe(true);
      expect(clave.includes(" /chat-datos/"), clave).toBe(true);
    }
  });

  it("las acciones de alto impacto (cerrar periodo, configuracion, staff, bitacora) nunca quedan abiertas a todos los roles", () => {
    const sensibles = Object.entries(MATRIZ_GUARDAS).filter(([k]) => /\/(cierre-mensual\/periodos\/:periodoId\/cerrar|configuracion|admin\/staff|admin\/bitacora)/.test(k) && !k.startsWith("GET /configuracion"));
    expect(sensibles.length).toBeGreaterThanOrEqual(7);
    for (const [clave, acceso] of sensibles) {
      expect(acceso, clave).not.toContain("readonly");
      expect(acceso, clave).not.toContain("contador");
    }
    // Todas las rutas con step-up (D-30) existen; las de escritura no admiten auditor ni readonly.
    for (const clave of RUTAS_CON_STEP_UP) {
      expect(MATRIZ_GUARDAS[clave], clave).toBeDefined();
      if (clave.startsWith("GET ")) continue;
      expect(MATRIZ_GUARDAS[clave], clave).not.toContain("readonly");
      expect(MATRIZ_GUARDAS[clave], clave).not.toContain("auditor");
    }
  });
});
