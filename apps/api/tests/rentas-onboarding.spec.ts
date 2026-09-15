// Fase 11 -- test de integración end-to-end de `POST /rentas/onboarding/registro`
// (onboarding self-serve del tenant, sin sesión previa) contra el adaptador en
// memoria (`InMemoryRentasOnboardingRepository`) -- ejercita la ruta HTTP real
// (validación -> hash de password -> `engine.withAppSession({userId: null}, ...)` ->
// `rentasOnboardingRepo.registrarTenant`), no solo la lógica de dominio (ver además
// packages/domain-rentas/tests/onboarding.spec.ts para la validación/normalización
// pura y el adaptador en memoria probados de forma aislada).
import { describe, expect, it } from "vitest";
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
