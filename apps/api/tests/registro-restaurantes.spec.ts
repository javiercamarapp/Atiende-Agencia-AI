// Alta autoservicio de restaurantes (0077) de punta a punta contra el doble en memoria: correo (enlace de un solo uso por POST) y
// Google (servidor OAuth falso local, `state` con purpose 'signup'). La autorizacion real, los topes en SQL y la creacion atomica
// (organizacion en prueba + cuenta verificada + membresia owner + sucursal inactiva) se verifican en scripts/verify-registro-autoservicio/.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";
import { InMemoryRegistroAutoservicioRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { DOMINIOS_DESECHABLES, pareceBot, validarCapturaRegistro } from "../src/routes/registro-restaurantes.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "./support/fakeGoogleOAuth.ts";

const INICIAR = "/auth/registro/restaurantes/iniciar";
const CONFIRMAR = "/auth/registro/restaurantes/confirmar";

function cuerpo(over: Record<string, unknown> = {}) {
  return { metodo: "correo", correo: "dueña@taqueria-lupita.mx", nombreNegocio: "Taquería Lupita", nombreSucursal: "Centro", nombreCompleto: "Lupita Pérez", zonaHoraria: "America/Merida", sitioWeb: "", msLlenado: 12_000, ...over };
}

interface Correo {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

async function setup(opciones: { sinRepo?: boolean; noMigrado?: boolean; google?: FakeGoogleOAuthServer } = {}) {
  const base = await buildTestDeps();
  const repo = new InMemoryRegistroAutoservicioRepository();
  if (opciones.noMigrado) repo.seedNoMigrado();
  const correos: Correo[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (new URL(u).hostname === "api.resend.com") {
        correos.push(JSON.parse(String(init?.body)) as Correo);
        return new Response("{}", { status: 200 });
      }
      return originalFetch(url as never, init);
    }),
  );
  const g = opciones.google;
  const deps = {
    ...base.deps,
    env: {
      ...base.deps.env,
      resend: { apiKey: "re_test_no_real", from: "atiende <notificaciones@atiende.ai>" },
      ...(g
        ? {
            googleOAuth: { clientId: g.clientId, clientSecret: g.clientSecret, redirectBaseUrl: base.deps.env.appBaseUrl.replace("app.test.invalid", "api.test.invalid") },
            googleStaffAuth: { authBaseUrl: g.baseUrl, tokenUrl: g.tokenUrl, jwksUrl: g.jwksUrl, issuer: g.issuer },
          }
        : {}),
    },
    ...(opciones.sinRepo ? {} : { registroAutoservicioRepo: () => repo }),
  };
  return { base, repo, correos, app: buildApp(deps) };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetDefaultRateLimiterForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function tokenDelCorreo(c: Correo): string {
  const m = /registro\/confirmar#token=([A-Za-z0-9_-]+)/.exec(c.text);
  expect(m, "el correo lleva el enlace con el token en el fragmento (#), que el navegador no manda al servidor").not.toBeNull();
  return m![1]!;
}

describe("registro autoservicio de restaurantes: correo", () => {
  it("iniciar -> 202 generico + correo con enlace; confirmar -> 201 con codigo de intercambio; nace en prueba 14 dias con sucursal inactiva", async () => {
    const t = await setup();
    const res = await t.app.request(INICIAR, jsonRequestInit(cuerpo()));
    expect(res.status).toBe(202);
    expect(t.correos).toHaveLength(1);
    expect(t.correos[0]!.to).toEqual(["dueña@taqueria-lupita.mx"]);
    // Ninguna organizacion se crea antes de confirmar el correo.
    expect(t.repo.organizaciones).toHaveLength(0);
    // El token nunca se guarda en claro: solo su hash.
    const token = tokenDelCorreo(t.correos[0]!);
    expect(t.repo.solicitudes[0]!.input.tokenHash).not.toBe(token);
    expect(t.repo.solicitudes[0]!.input.origenHash).toMatch(/^[0-9a-f]{64}$/);

    const conf = await t.app.request(CONFIRMAR, jsonRequestInit({ token }));
    expect(conf.status).toBe(201);
    const body = (await conf.json()) as { code: string; orgSlug: string; trialEndsAt: string; sucursal: { status: string } };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.orgSlug).toBe("taqueria-lupita");
    expect(body.sucursal.status).toBe("inactive");
    const dias = (new Date(body.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(13.9);
    expect(dias).toBeLessThanOrEqual(14);
    expect(t.repo.organizaciones[0]).toMatchObject({ nombre: "Taquería Lupita", status: "trial", ownerCreatedVia: "registro_autoservicio", sucursal: { nombre: "Centro", status: "inactive" } });

    // Un solo uso: el segundo clic no crea otra organizacion.
    const otra = await t.app.request(CONFIRMAR, jsonRequestInit({ token }));
    expect(otra.status).toBe(404);
    expect(t.repo.organizaciones).toHaveLength(1);
  });

  it("correo que ya tiene cuenta: el MISMO 202 (anti-enumeracion), le llega un correo de 'ya tienes cuenta' y no se crea solicitud", async () => {
    const t = await setup();
    const res = await t.app.request(INICIAR, jsonRequestInit(cuerpo({ correo: t.base.ownerEmail })));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, metodo: "correo" });
    expect(t.repo.solicitudes).toHaveLength(0);
    expect(t.correos[0]!.subject).toBe("Ya tienes una cuenta en atiende");
  });

  it("trampa de bots (campo oculto lleno o formulario en < 3 s): 202 identico, sin solicitud ni correo", async () => {
    const t = await setup();
    for (const over of [{ sitioWeb: "http://spam.example" }, { msLlenado: 400 }, { msLlenado: undefined }]) {
      const res = await t.app.request(INICIAR, jsonRequestInit(cuerpo(over)));
      expect(res.status).toBe(202);
    }
    expect(t.repo.solicitudes).toHaveLength(0);
    expect(t.correos).toHaveLength(0);
  });

  it("validacion (cuenta para el tope por IP): correo desechable, enlaces en el nombre, nombre corto, metodo o zona invalidos -> 400", async () => {
    const t = await setup();
    for (const over of [{ correo: "x@mailinator.com" }, { nombreNegocio: "Visita www.spam.example" }, { nombreSucursal: "C" }, { metodo: "fax" }, { zonaHoraria: "Mars/Olympus;drop" }]) {
      expect((await t.app.request(INICIAR, jsonRequestInit(cuerpo(over)))).status, JSON.stringify(over)).toBe(400);
    }
    expect(t.repo.solicitudes).toHaveLength(0);
  });

  it("tope por IP: el sexto registro en una hora desde la misma conexion -> 429", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await t.app.request(INICIAR, jsonRequestInit(cuerpo({ correo: `dueno${i}@restaurante.mx` })))).status).toBe(202);
    }
    expect((await t.app.request(INICIAR, jsonRequestInit(cuerpo({ correo: "dueno9@restaurante.mx" })))).status).toBe(429);
  });

  it("tope en la base (3 enlaces vigentes por correo) se traduce a 429", async () => {
    const t = await setup();
    const correo = "repetido@restaurante.mx";
    for (let i = 0; i < 3; i++) await t.repo.solicitar({ vertical: "restaurantes", metodo: "correo", correo, nombreNegocio: "Resto", nombreSucursal: "Centro", nombreCompleto: "Ana", zonaHoraria: null, tokenHash: `h${i}`.padEnd(64, "0"), origenHash: `o${i}`.padEnd(64, "0"), ttlMinutos: 30 });
    expect((await t.app.request(INICIAR, jsonRequestInit(cuerpo({ correo })))).status).toBe(429);
  });

  it("enlace vencido o inventado -> 404; token mal formado -> 400", async () => {
    const t = await setup();
    await t.app.request(INICIAR, jsonRequestInit(cuerpo()));
    const token = tokenDelCorreo(t.correos[0]!);
    t.repo.ahora = () => Date.now() + 31 * 60_000;
    expect((await t.app.request(CONFIRMAR, jsonRequestInit({ token }))).status).toBe(404);
    expect((await t.app.request(CONFIRMAR, jsonRequestInit({ token: "x".repeat(43) }))).status).toBe(404);
    expect((await t.app.request(CONFIRMAR, jsonRequestInit({ token: "<script>" }))).status).toBe(400);
    expect(t.repo.organizaciones).toHaveLength(0);
  });

  it("sin la migracion 0077 o sin repositorio: 503 honesto (nunca 500)", async () => {
    const noMigrado = await setup({ noMigrado: true });
    expect((await noMigrado.app.request(INICIAR, jsonRequestInit(cuerpo()))).status).toBe(503);
    expect((await noMigrado.app.request(CONFIRMAR, jsonRequestInit({ token: "y".repeat(43) }))).status).toBe(503);
    const sinRepo = await setup({ sinRepo: true });
    expect((await sinRepo.app.request(INICIAR, jsonRequestInit(cuerpo()))).status).toBe(503);
    const estado = (await (await sinRepo.app.request("/auth/registro/restaurantes/estado")).json()) as { disponible: boolean };
    expect(estado.disponible).toBe(false);
  });
});

describe("registro autoservicio de restaurantes: Google", () => {
  let fakeGoogle: FakeGoogleOAuthServer;
  beforeEach(async () => {
    fakeGoogle = await startFakeGoogleOAuthServer();
  });
  afterEach(async () => {
    await fakeGoogle.close();
  });

  async function viajeGoogle(t: Awaited<ReturnType<typeof setup>>, nombreNegocio = "Cocina Doña Mary") {
    const ini = await t.app.request(INICIAR, jsonRequestInit(cuerpo({ metodo: "google", correo: undefined, nombreNegocio })));
    expect(ini.status).toBe(200);
    const { url } = (await ini.json()) as { url: string };
    const autorizado = await originalFetch(url, { redirect: "manual" });
    const cb = new URL(autorizado.headers.get("location")!);
    return t.app.request(`/auth/google/callback?code=${cb.searchParams.get("code")}&state=${cb.searchParams.get("state")}`);
  }

  it("Google con correo verificado y sin cuenta: crea la organizacion y entra con codigo de intercambio (nunca el JWT en la URL)", async () => {
    const t = await setup({ google: fakeGoogle });
    fakeGoogle.setNextUser({ sub: "g-sub-registro", email: "Mary@CocinaMary.mx", emailVerified: true, name: "Mary" });
    const res = await viajeGoogle(t);
    expect(res.status).toBe(302);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.pathname).toBe("/restaurantes/auth/google/callback");
    expect(destino.searchParams.get("code")).toBeTruthy();
    expect(destino.searchParams.get("token")).toBeNull();
    expect(t.repo.organizaciones[0]).toMatchObject({ slug: "cocina-dona-mary", ownerCorreo: "mary@cocinamary.mx", ownerCreatedVia: "google" });
    // La solicitud de Google se guardo SIN correo (lo fija Google al volver).
    expect(t.repo.solicitudes[0]!.input.correo).toBeNull();
  });

  it("Google de alguien que ya tiene cuenta: no crea nada y vuelve al registro con 'cuenta_existente'", async () => {
    const t = await setup({ google: fakeGoogle });
    fakeGoogle.setNextUser({ sub: "g-sub-existente", email: t.base.ownerEmail, emailVerified: true });
    const res = await viajeGoogle(t);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.pathname).toBe("/restaurantes/registro");
    expect(destino.searchParams.get("registro_error")).toBe("cuenta_existente");
    expect(t.repo.organizaciones).toHaveLength(0);
  });

  it("Google no configurado: metodo google -> 503 con mensaje honesto", async () => {
    const t = await setup();
    const deps = { ...t.base.deps, env: { ...t.base.deps.env, googleOAuth: null }, registroAutoservicioRepo: () => t.repo };
    const res = await buildApp(deps).request(INICIAR, jsonRequestInit(cuerpo({ metodo: "google" })));
    expect(res.status).toBe(503);
  });
});

describe("heuristicas puras", () => {
  it("pareceBot y validarCapturaRegistro", () => {
    expect(pareceBot({ sitioWeb: "", msLlenado: 5_000 })).toBe(false);
    expect(pareceBot({ sitioWeb: "x", msLlenado: 5_000 })).toBe(true);
    expect(pareceBot({ msLlenado: Number.NaN })).toBe(true);
    expect(DOMINIOS_DESECHABLES.has("yopmail.com")).toBe(true);
    expect(validarCapturaRegistro({ metodo: "google", nombreNegocio: "  Tacos   El Güero ", nombreSucursal: "Norte", nombreCompleto: "Juan" })).toEqual({
      metodo: "google",
      correo: null,
      nombreNegocio: "Tacos El Güero",
      nombreSucursal: "Norte",
      nombreCompleto: "Juan",
      zonaHoraria: null,
    });
  });
});
