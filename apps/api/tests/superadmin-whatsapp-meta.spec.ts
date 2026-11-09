// Pantalla del superadmin para las credenciales de Meta de una organizacion (migracion 0090): registrar, rotar y revocar con step-up,
// secretos de solo escritura (llegan cifrados a la base y nunca vuelven en una respuesta) y asignacion de numeros por sucursal.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { superadminWhatsappMetaRoutes } from "../src/routes/superadmin-whatsapp-meta.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { aadCredencialMeta, crearCifradorCredencialesMeta, crearResolutorCredencialesMeta, hashVerifyToken } from "../src/whatsapp-credenciales/index.ts";
import type { AppDeps } from "../src/deps.ts";

const CALLER = "00000000-0000-4000-8000-0000000000aa";
const ORG = "00000000-0000-4000-8000-0000000000b1";
const CRED = "00000000-0000-4000-8000-0000000000c1";
const SUC = "00000000-0000-4000-8000-0000000000d1";
const SECRETO = "abcdef0123456789abcdef0123456789";
const TOKEN = "EAAGtokenDeUsuarioDeSistemaDePrueba0123456789";
const VERIFY = "verify-token-propio-1234";

function pgError(code: string): Error & { code: string } {
  const e = new Error("x") as Error & { code: string };
  e.code = code;
  return e;
}

function montar(handlers: readonly FakeSessionHandler[], conLlave = true) {
  const session = new AbortAwareFakeSession(handlers);
  const cifrador = crearCifradorCredencialesMeta(randomBytes(32), 1);
  const resolutor = crearResolutorCredencialesMeta({ leer: async () => [], cifrador });
  const invalidar = vi.spyOn(resolutor, "invalidar");
  const deps = {
    engine: { withAppSession: async (_c: unknown, fn: (db: AbortAwareFakeSession) => Promise<unknown>) => fn(session) },
    ...(conLlave ? { whatsappMeta: { cifrador, resolutor } } : {}),
  } as unknown as AppDeps;
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", CALLER);
    await next();
  });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ code: err.code, error: err.message }, err.status as 400) : c.json({ error: "interno" }, 500)));
  app.route("/", superadminWhatsappMetaRoutes(deps));
  return { app, session, cifrador, invalidar };
}

const base = `/superadmin/organizaciones/${ORG}/whatsapp-meta`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const registro = { etiqueta: "App de PM", appId: "1234567890", wabaId: "9876543210", appSecret: SECRETO, accessToken: TOKEN, verifyToken: VERIFY };

describe("GET /superadmin/organizaciones/:id/whatsapp-meta", () => {
  it("devuelve credenciales y numeros SOLO con metadatos (nunca sobres, hashes ni secretos)", async () => {
    const { app } = montar([
      {
        match: /whatsapp_meta_listar_credenciales/,
        respond: () => [
          { id: CRED, etiqueta: "App de PM", app_id: "1234567890", waba_id: "9876543210", tiene_verify_token: true, activa: true, creada_en: "2026-11-07T10:00:00Z", secreto_rotado_en: "2026-11-07T10:00:00Z", token_rotado_en: "2026-11-07T10:00:00Z", actualizada_en: "2026-11-07T10:00:00Z", revocada_en: null, numeros: 1 },
        ],
      },
      { match: /whatsapp_meta_listar_numeros/, respond: () => [{ property_id: SUC, property_nombre: "T7", property_estado: "active", phone_number_id: "5550001", credencial_id: CRED, origen: "sucursal" }] },
    ]);
    const res = await app.request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; credenciales: Array<Record<string, unknown>>; numeros: unknown[] };
    expect(body.disponible).toBe(true);
    expect(body.credenciales[0]).toMatchObject({ id: CRED, appId: "1234567890", tieneVerifyToken: true, numeros: 1 });
    expect(body.numeros).toEqual([{ propertyId: SUC, propertyNombre: "T7", propertyEstado: "active", phoneNumberId: "5550001", credencialId: CRED, origen: "sucursal" }]);
    expect(JSON.stringify(body)).not.toMatch(/cifrado|hash|appSecret|accessToken/iu);
  });

  it("sin WHATSAPP_CREDENTIALS_KEY: 200 honesto con disponible=false (motivo sin_llave), sin tocar la base", async () => {
    const { app, session } = montar([], false);
    const spy = vi.spyOn(session, "query");
    const res = await app.request(base);
    expect(await res.json()).toMatchObject({ disponible: false, motivo: "sin_llave" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("base sin migrar (42883): disponible=false (motivo no_migrada) y la sesion sigue sana", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, session } = montar([{ match: /whatsapp_meta_listar_credenciales/, respond: () => pgError("42883") }, { match: /select 1/, respond: () => [] }]);
    const res = await app.request(base);
    expect(await res.json()).toMatchObject({ disponible: false, motivo: "no_migrada" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("id de organizacion invalido: 400", async () => {
    const { app } = montar([]);
    expect((await app.request("/superadmin/organizaciones/no-es-uuid/whatsapp-meta")).status).toBe(400);
  });
});

describe("POST .../credenciales (registrar)", () => {
  it("cifra secreto y token con la AAD de la credencial y guarda SOLO el hash del verify token; responde sin secretos", async () => {
    const { app, session, cifrador, invalidar } = montar([{ match: /whatsapp_meta_registrar_credencial/, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    const res = await app.request(`${base}/credenciales`, json("POST", registro));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { credencial: { id: string } };
    const sql = spy.mock.calls.find((c) => /registrar_credencial/.test(String(c[0])))!;
    const params = sql[1] as unknown[];
    const [caller, credId, org, etiqueta, appId, wabaId, secretoCifrado, tokenCifrado, verifyHash] = params as string[];
    expect([caller, org, etiqueta, appId, wabaId]).toEqual([CALLER, ORG, "App de PM", "1234567890", "9876543210"]);
    expect(credId).toBe(body.credencial.id);
    expect(JSON.stringify(params)).not.toContain(SECRETO);
    expect(JSON.stringify(params)).not.toContain(TOKEN);
    expect(JSON.stringify(params)).not.toContain(VERIFY);
    expect(cifrador.descifrar(secretoCifrado!, aadCredencialMeta(credId!, ORG, "app_secret"))).toBe(SECRETO);
    expect(cifrador.descifrar(tokenCifrado!, aadCredencialMeta(credId!, ORG, "access_token"))).toBe(TOKEN);
    expect(verifyHash).toBe(hashVerifyToken(VERIFY));
    const texto = JSON.stringify(body);
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain(TOKEN);
    expect(invalidar).toHaveBeenCalled();
  });

  it("valida cada campo antes de tocar la base", async () => {
    const { app, session } = montar([]);
    const spy = vi.spyOn(session, "query");
    for (const malo of [{ appId: "abc" }, { wabaId: "12" }, { appSecret: "corto" }, { accessToken: "con espacios no vale nada" }, { verifyToken: "corto" }, { etiqueta: "" }]) {
      const res = await app.request(`${base}/credenciales`, json("POST", { ...registro, ...malo }));
      expect(res.status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("la app ya esta registrada en otra organizacion (23505): 409", async () => {
    const { app } = montar([{ match: /whatsapp_meta_registrar_credencial/, respond: () => pgError("23505") }]);
    expect((await app.request(`${base}/credenciales`, json("POST", registro))).status).toBe(409);
  });

  it("sin WHATSAPP_CREDENTIALS_KEY: 503 (nunca guarda texto claro)", async () => {
    const { app } = montar([], false);
    expect((await app.request(`${base}/credenciales`, json("POST", registro))).status).toBe(503);
  });

  it("base sin migrar: 503 honesto", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montar([{ match: /whatsapp_meta_registrar_credencial/, respond: () => pgError("42883") }]);
    expect((await app.request(`${base}/credenciales`, json("POST", registro))).status).toBe(503);
  });
});

describe("PUT .../credenciales/:cid (rotar) y POST .../revocar", () => {
  it("rota solo lo que llega; lo demas viaja como null (se conserva)", async () => {
    const { app, session, cifrador } = montar([{ match: /whatsapp_meta_rotar_credencial/, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    const res = await app.request(`${base}/credenciales/${CRED}`, json("PUT", { accessToken: TOKEN }));
    expect(res.status).toBe(200);
    const params = spy.mock.calls.find((c) => /rotar_credencial/.test(String(c[0])))![1] as unknown[];
    expect(params[0]).toBe(CALLER);
    expect(params[1]).toBe(CRED);
    expect(params[2]).toBe(ORG);
    expect([params[3], params[4], params[6], params[7]]).toEqual([null, null, null, false]);
    expect(cifrador.descifrar(params[5] as string, aadCredencialMeta(CRED, ORG, "access_token"))).toBe(TOKEN);
  });

  it("sin nada que rotar: 400 sin tocar la base", async () => {
    const { app } = montar([]);
    expect((await app.request(`${base}/credenciales/${CRED}`, json("PUT", {}))).status).toBe(400);
  });

  it("credencial de otra organizacion o revocada (P0002): 404", async () => {
    const { app } = montar([{ match: /whatsapp_meta_rotar_credencial/, respond: () => pgError("P0002") }]);
    expect((await app.request(`${base}/credenciales/${CRED}`, json("PUT", { appSecret: SECRETO }))).status).toBe(404);
  });

  it("revocar exige motivo y devuelve cuantos numeros volvieron a la plataforma", async () => {
    const { app } = montar([{ match: /whatsapp_meta_revocar_credencial/, respond: () => [{ liberados: 2 }] }]);
    expect((await app.request(`${base}/credenciales/${CRED}/revocar`, json("POST", { motivo: "corto" }))).status).toBe(400);
    const res = await app.request(`${base}/credenciales/${CRED}/revocar`, json("POST", { motivo: "Se cambio la app de Meta del negocio" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revocada: true, numerosLiberados: 2 });
  });
});

describe("PUT .../numeros (asignar)", () => {
  it("asigna numero, sucursal y credencial", async () => {
    const { app, session } = montar([{ match: /whatsapp_meta_asignar_numero/, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    const res = await app.request(`${base}/numeros`, json("PUT", { phoneNumberId: "5550001", credencialId: CRED, propertyId: SUC }));
    expect(res.status).toBe(200);
    expect(spy.mock.calls.find((c) => /asignar_numero/.test(String(c[0])))![1]).toEqual([CALLER, ORG, "5550001", CRED, SUC]);
  });

  it("credencialId null devuelve el numero a la plataforma", async () => {
    const { app, session } = montar([{ match: /whatsapp_meta_asignar_numero/, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    await app.request(`${base}/numeros`, json("PUT", { phoneNumberId: "5550001", credencialId: null }));
    expect(spy.mock.calls.find((c) => /asignar_numero/.test(String(c[0])))![1]).toEqual([CALLER, ORG, "5550001", null, null]);
  });

  it("numero de otra organizacion (23505): 409; numero con letras: 400", async () => {
    const { app } = montar([{ match: /whatsapp_meta_asignar_numero/, respond: () => pgError("23505") }]);
    expect((await app.request(`${base}/numeros`, json("PUT", { phoneNumberId: "5550009", credencialId: CRED }))).status).toBe(409);
    expect((await app.request(`${base}/numeros`, json("PUT", { phoneNumberId: "abc", credencialId: CRED }))).status).toBe(400);
  });
});

describe("step-up MFA", () => {
  it("las 4 escrituras son acciones sensibles; la lectura no", () => {
    expect(isSensitiveRoute("POST", `${base}/credenciales`)).toBe(true);
    expect(isSensitiveRoute("PUT", `${base}/credenciales/${CRED}`)).toBe(true);
    expect(isSensitiveRoute("POST", `${base}/credenciales/${CRED}/revocar`)).toBe(true);
    expect(isSensitiveRoute("PUT", `${base}/numeros`)).toBe(true);
    expect(isSensitiveRoute("GET", base)).toBe(false);
  });
});
