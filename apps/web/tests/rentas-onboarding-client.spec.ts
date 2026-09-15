// Tests del cliente web del onboarding self-serve de rentas — lib/onboarding-client.ts.
// Hallazgo de auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está
// bloqueado en producción y ni siquiera tiene pantalla").
import { describe, expect, it } from "vitest";
import { OnboardingError, registrarTenant, validateRegistroForm } from "../src/verticals/rentas/lib/onboarding-client.ts";
import type { RegistroTenantInput } from "../src/verticals/rentas/lib/onboarding-client.ts";

function inputValido(overrides: Partial<RegistroTenantInput> = {}): RegistroTenantInput {
  return {
    organizacionNombre: "Rentas Riviera Maya",
    tipoOrganizacion: "empresa_gestora",
    propiedadNombre: "Depa Playa del Carmen 12B",
    zonaHoraria: "America/Cancun",
    moneda: "MXN",
    unidades: [{ nombre: "Depa 12B" }],
    adminNombreCompleto: "Ana Ramírez",
    adminCorreo: "ana@rentas-riviera.mx",
    adminPassword: "correcto-caballo-batería",
    ...overrides,
  };
}

describe("validateRegistroForm", () => {
  it("exige nombre de organización, propiedad, zona horaria, al menos 1 unidad, nombre y correo válido de admin, y contraseña de 10+", () => {
    expect(validateRegistroForm(inputValido({ organizacionNombre: "" }))).toMatch(/organización/i);
    expect(validateRegistroForm(inputValido({ propiedadNombre: "" }))).toMatch(/propiedad/i);
    expect(validateRegistroForm(inputValido({ unidades: [] }))).toMatch(/unidad/i);
    expect(validateRegistroForm(inputValido({ unidades: [{ nombre: "  " }] }))).toMatch(/nombre/i);
    expect(validateRegistroForm(inputValido({ unidades: [{ nombre: "A" }, { nombre: "a" }] }))).toMatch(/mismo nombre/i);
    expect(validateRegistroForm(inputValido({ adminNombreCompleto: "" }))).toMatch(/nombre/i);
    expect(validateRegistroForm(inputValido({ adminCorreo: "no-es-correo" }))).toMatch(/válido/i);
    expect(validateRegistroForm(inputValido({ adminPassword: "corta" }))).toMatch(/contraseña/i);
    expect(validateRegistroForm(inputValido())).toBeNull();
  });
});

describe("registrarTenant", () => {
  it("hace POST real a /rentas/onboarding/registro con el body correcto y devuelve el resultado", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/onboarding/registro");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init!.body as string);
      expect(body.organizacion).toEqual({ nombre: "Rentas Riviera Maya", tipoOrganizacion: "empresa_gestora" });
      expect(body.primeraPropiedad).toEqual({ nombre: "Depa Playa del Carmen 12B", zonaHoraria: "America/Cancun", moneda: "MXN" });
      expect(body.primerasUnidades).toEqual([{ nombre: "Depa 12B" }]);
      expect(body.admin).toEqual({ nombreCompleto: "Ana Ramírez", correo: "ana@rentas-riviera.mx", password: "correcto-caballo-batería" });
      return new Response(
        JSON.stringify({ organizationId: "org-1", propertyId: "prop-1", staffId: "staff-1", slug: "rentas-riviera-maya", unidadIds: ["u-1"], requiereVerificacionCorreo: true }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const resultado = await registrarTenant(fetchImpl, "http://api.local", inputValido());
    expect(resultado.slug).toBe("rentas-riviera-maya");
    expect(resultado.unidadIds).toEqual(["u-1"]);
  });

  it("incluye configuracionInicial.primerOwner solo cuando primerOwnerNombre viene presente", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.configuracionInicial).toEqual({ primerOwner: { nombre: "Juan Dueño", email: "juan@correo.mx" } });
      return new Response(JSON.stringify({ organizationId: "o", propertyId: "p", staffId: "s", slug: "x", unidadIds: [], requiereVerificacionCorreo: true }), { status: 201 });
    }) as unknown as typeof fetch;

    await registrarTenant(fetchImpl, "http://api.local", inputValido({ primerOwnerNombre: "Juan Dueño", primerOwnerEmail: "juan@correo.mx" }));
  });

  it("409: correo/organización duplicada -> mensaje real del servidor", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'Ya existe una cuenta registrada con el correo "ana@rentas-riviera.mx".' }), { status: 409 })) as unknown as typeof fetch;
    await expect(registrarTenant(fetchImpl, "http://api.local", inputValido())).rejects.toThrow(/Ya existe una cuenta/);
  });

  it("formulario inválido -> nunca llega a llamar a fetch", async () => {
    const fetchImpl = (async () => {
      throw new Error("no debería llamarse");
    }) as unknown as typeof fetch;
    await expect(registrarTenant(fetchImpl, "http://api.local", inputValido({ unidades: [] }))).rejects.toThrow(OnboardingError);
  });
});
