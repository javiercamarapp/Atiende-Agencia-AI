// Fase 11 -- test de integración end-to-end de `POST /rentas/onboarding/registro`
// (onboarding self-serve del tenant, sin sesión previa) contra el adaptador en
// memoria (`InMemoryRentasOnboardingRepository`) -- ejercita la ruta HTTP real
// (validación -> hash de password -> `engine.withAppSession({userId: null}, ...)` ->
// `rentasOnboardingRepo.registrarTenant`), no solo la lógica de dominio (ver además
// packages/domain-rentas/tests/onboarding.spec.ts para la validación/normalización
// pura y el adaptador en memoria probados de forma aislada).
import { describe, expect, it } from "vitest";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildRentasTestContext } from "./rentas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

function cuerpoValido(overrides: Record<string, unknown> = {}) {
  return {
    organizacion: { nombre: "Rentas Riviera Maya", tipoOrganizacion: "empresa_gestora" },
    primeraPropiedad: { nombre: "Depa Playa del Carmen 12B", zonaHoraria: "America/Cancun", moneda: "MXN" },
    primerasUnidades: [{ nombre: "Depa 12B" }],
    admin: { nombreCompleto: "Ana Ramírez", correo: "ana@rentas-riviera.mx", password: "correcto-caballo-batería" },
    ...overrides,
  };
}

describe("POST /rentas/onboarding/registro", () => {
  it("201: crea organización + property + admin + configuración inicial en un solo submit, SIN necesitar ningún header de autenticación", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { organizationId: string; propertyId: string; staffId: string; slug: string; unidadIds: string[]; requiereVerificacionCorreo: true };
    expect(body.slug).toBe("rentas-riviera-maya");
    expect(body.requiereVerificacionCorreo).toBe(true);
    expect(body.unidadIds).toHaveLength(1);

    // Efecto real verificado contra el adaptador (no solo el JSON de respuesta) --
    // mismo criterio de "prueba real de la LÓGICA", ver comentario de cabecera de
    // ../../packages/domain-rentas/src/onboarding/in-memory-repository.ts.
    const org = ctx.rentasOnboardingRepo.findOrganizacionById(body.organizationId);
    expect(org?.name).toBe("Rentas Riviera Maya");
    const staff = ctx.rentasOnboardingRepo.findStaffByEmail("ana@rentas-riviera.mx");
    expect(staff?.id).toBe(body.staffId);
    // La contraseña llegó HASHEADA al puerto de persistencia, nunca en texto plano.
    expect(staff?.passwordHash).not.toBe("correcto-caballo-batería");
    expect(staff?.passwordHash.length ?? 0).toBeGreaterThan(20);
    const unidades = ctx.rentasOnboardingRepo.listUnidadesDePropiedad(body.propertyId);
    expect(unidades).toHaveLength(1);
    expect(unidades[0]!.name).toBe("Depa 12B");
  });

  it("400: primerasUnidades vacío -- una property sin ninguna unidad no se registra", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ primerasUnidades: [] })));
    expect(res.status).toBe(400);
  });

  it("400: dos unidades con el mismo nombre en el mismo submit", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ primerasUnidades: [{ nombre: "Depa 1" }, { nombre: "Depa 1" }] })));
    expect(res.status).toBe(400);
  });

  it("201: registra varias unidades reales, con duracionMinimaNoches explícita", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      "/rentas/onboarding/registro",
      jsonRequestInit(cuerpoValido({ primerasUnidades: [{ nombre: "Depa 1" }, { nombre: "Depa 2", duracionMinimaNoches: 3 }] })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { propertyId: string; unidadIds: string[] };
    expect(body.unidadIds).toHaveLength(2);
    const unidades = ctx.rentasOnboardingRepo.listUnidadesDePropiedad(body.propertyId);
    expect(unidades.map((u) => u.name).sort()).toEqual(["Depa 1", "Depa 2"]);
  });

  it("201: incluye primerOwner cuando configuracionInicial.primerOwner viene presente", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      "/rentas/onboarding/registro",
      jsonRequestInit(cuerpoValido({ configuracionInicial: { primerOwner: { nombre: "Dueño Real", email: "dueno@correo.mx" } } })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { organizationId: string };
    const owners = ctx.rentasOnboardingRepo.listOwnersDeOrganizacion(body.organizationId);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.name).toBe("Dueño Real");
  });

  it("400: organizacion.nombre vacío -- rechazado ANTES de tocar el repositorio", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ organizacion: { nombre: "   ", tipoOrganizacion: "anfitrion" } })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });

  it("400: zona horaria inválida (no IANA real)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "GMT-6", moneda: "MXN" } })));
    expect(res.status).toBe(400);
  });

  it("400: contraseña por debajo del mínimo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ admin: { nombreCompleto: "X", correo: "x@x.mx", password: "corta" } })));
    expect(res.status).toBe(400);
  });

  it("409: un segundo registro con el MISMO correo de admin no crea un tenant duplicado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const primero = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido()));
    expect(primero.status).toBe(201);

    const segundo = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido({ organizacion: { nombre: "Otra Organización", tipoOrganizacion: "anfitrion" } })));
    expect(segundo.status).toBe(409);
  });

  it("dos organizaciones con el mismo nombre (mismo slug candidato) reciben slugs distintos -- nunca falla el registro por colisión", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const primero = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido()));
    const primeroBody = (await primero.json()) as { slug: string };

    const segundo = await app.request(
      "/rentas/onboarding/registro",
      jsonRequestInit(cuerpoValido({ admin: { nombreCompleto: "Otro Admin", correo: "otro-admin@rentas-riviera.mx", password: "correcto-caballo-batería" } })),
    );
    expect(segundo.status).toBe(201);
    const segundoBody = (await segundo.json()) as { slug: string };
    expect(segundoBody.slug).not.toBe(primeroBody.slug);
  });

  it("rechaza un cuerpo que no es JSON válido con un 400, no con un 500", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request("/rentas/onboarding/registro", {
      method: "POST",
      body: "{no-es-json",
      headers: { "content-type": "application/json", "content-length": "11" },
    });
    expect(res.status).toBeLessThan(500);
  });
});

describe("onboarding P0: verificacion de correo y tope del registro", () => {
  async function conSeguridad() {
    const ctx = await buildRentasTestContext(buildApp);
    const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
    const app = buildApp({ ...ctx.deps, staffSecurityRepo: security });
    return { ctx, security, app };
  }

  it("201: encola en el outbox de rentas el correo de verificacion con un enlace /rentas/verificar-correo de un solo uso", async () => {
    const { ctx, app } = await conSeguridad();
    const res = await app.request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { propertyId: string; staffId: string; correoVerificacion: { encolado: boolean } };
    expect(body.correoVerificacion).toEqual({ encolado: true });
    const correos = ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "staff.email_verification");
    expect(correos).toHaveLength(1);
    expect(correos[0]).toMatchObject({ propertyId: body.propertyId, channel: "email", dedupeKey: `email-verification:${body.staffId}` });
    const payload = correos[0]!.payload as { to: string; text: string; html: string };
    expect(payload.to).toBe("ana@rentas-riviera.mx");
    expect(payload.text).toMatch(/\/rentas\/verificar-correo\?token=[A-Za-z0-9_-]+/);
    // El token solo viaja en el correo: la respuesta HTTP del registro nunca lo trae.
    const token = payload.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("sin repositorio de seguridad (base sin migrar) el registro sigue 201 y dice honestamente que no se encolo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const res = await buildApp({ ...ctx.deps, staffSecurityRepo: undefined }).request("/rentas/onboarding/registro", jsonRequestInit(cuerpoValido()));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { correoVerificacion: { encolado: boolean } }).correoVerificacion).toEqual({ encolado: false });
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "staff.email_verification")).toHaveLength(0);
  });

  it("tope por IP: el registro 11 en una hora desde la misma conexion responde 429 sin registrar nada", async () => {
    const { ctx, app } = await conSeguridad();
    for (let i = 0; i < 10; i++) {
      const r = await app.request(
        "/rentas/onboarding/registro",
        jsonRequestInit(cuerpoValido({ organizacion: { nombre: `Rentas ${i}`, tipoOrganizacion: "anfitrion" }, admin: { nombreCompleto: "Ana", correo: `ana${i}@rentas.mx`, password: "correcto-caballo-batería" } })),
      );
      expect(r.status).toBe(201);
    }
    const bloqueado = await app.request(
      "/rentas/onboarding/registro",
      jsonRequestInit(cuerpoValido({ organizacion: { nombre: "Rentas 11", tipoOrganizacion: "anfitrion" }, admin: { nombreCompleto: "Ana", correo: "ana11@rentas.mx", password: "correcto-caballo-batería" } })),
    );
    expect(bloqueado.status).toBe(429);
    expect(ctx.rentasOnboardingRepo.findStaffByEmail("ana11@rentas.mx")).toBeUndefined();
  });
});
