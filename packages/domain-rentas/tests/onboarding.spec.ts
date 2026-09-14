import { describe, expect, it } from "vitest";
import { RentasDomainError } from "../src/errors.ts";
import { slugificarNombreOrganizacion, validarCapturaOnboardingRentas } from "../src/onboarding/captura.ts";
import { InMemoryRentasOnboardingRepository } from "../src/onboarding/in-memory-repository.ts";

function cuerpoValido(overrides: Record<string, unknown> = {}) {
  return {
    organizacion: { nombre: "Rentas Cancún Élite", tipoOrganizacion: "empresa_gestora" },
    primeraPropiedad: { nombre: "Depa Zona Hotelera", zonaHoraria: "America/Cancun", moneda: "MXN" },
    admin: { nombreCompleto: "María Torres", correo: "maria@rentas-cancun.mx", password: "correcto-caballo-batería" },
    ...overrides,
  };
}

describe("slugificarNombreOrganizacion", () => {
  it("deriva un slug url-safe con acentos/espacios/puntuación normalizados", () => {
    expect(slugificarNombreOrganizacion("Rentas Cancún Élite S.A. de C.V.")).toBe("rentas-cancun-elite-s-a-de-c-v");
  });

  it("nunca produce un slug con guion al inicio/fin ni guiones repetidos", () => {
    expect(slugificarNombreOrganizacion("  --Renta$$ Múltiples---Espacios  ")).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("rechaza un nombre sin ningún carácter alfanumérico (ej. solo emoji/símbolos)", () => {
    expect(() => slugificarNombreOrganizacion("🏖️🏖️🏖️")).toThrow(RentasDomainError);
  });
});

describe("validarCapturaOnboardingRentas", () => {
  it("acepta un cuerpo completo y normaliza correo (minúsculas) + calcula slugPropuesto", () => {
    const resultado = validarCapturaOnboardingRentas(cuerpoValido({ admin: { nombreCompleto: "María Torres", correo: "MARIA@Rentas-Cancun.MX", password: "correcto-caballo-batería" } }));
    expect(resultado.admin.correo).toBe("maria@rentas-cancun.mx");
    expect(resultado.slugPropuesto).toBe("rentas-cancun-elite");
    expect(resultado.organizacion.tipoOrganizacion).toBe("empresa_gestora");
    expect(resultado.primeraPropiedad.moneda).toBe("MXN");
    expect(resultado.primerOwner).toBeNull();
  });

  it("aplica los DEFAULT documentados cuando tipoOrganizacion/moneda se omiten", () => {
    const cuerpo = cuerpoValido();
    delete (cuerpo.organizacion as Record<string, unknown>).tipoOrganizacion;
    delete (cuerpo.primeraPropiedad as Record<string, unknown>).moneda;
    const resultado = validarCapturaOnboardingRentas(cuerpo);
    expect(resultado.organizacion.tipoOrganizacion).toBe("anfitrion");
    expect(resultado.primeraPropiedad.moneda).toBe("MXN");
  });

  it("captura primerOwner cuando viene en configuracionInicial", () => {
    const resultado = validarCapturaOnboardingRentas(cuerpoValido({ configuracionInicial: { primerOwner: { nombre: "Juan Dueño", email: "juan@correo.mx" } } }));
    expect(resultado.primerOwner).toEqual({ nombre: "Juan Dueño", email: "juan@correo.mx" });
  });

  it("primerOwner sin email es válido (email es opcional)", () => {
    const resultado = validarCapturaOnboardingRentas(cuerpoValido({ configuracionInicial: { primerOwner: { nombre: "Juan Dueño" } } }));
    expect(resultado.primerOwner).toEqual({ nombre: "Juan Dueño" });
  });

  it("rechaza un cuerpo que no es un objeto", () => {
    expect(() => validarCapturaOnboardingRentas(null)).toThrow(RentasDomainError);
    expect(() => validarCapturaOnboardingRentas("hola")).toThrow(RentasDomainError);
    expect(() => validarCapturaOnboardingRentas(42)).toThrow(RentasDomainError);
  });

  it("rechaza organizacion.nombre vacío/ausente", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ organizacion: { nombre: "   " } }))).toThrow(RentasDomainError);
  });

  it("rechaza organizacion.tipoOrganizacion fuera del enum", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ organizacion: { nombre: "X", tipoOrganizacion: "superadmin" } }))).toThrow(RentasDomainError);
  });

  it("rechaza una zona horaria que no es IANA real (offset fijo, inventada, o vacía)", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "GMT-6", moneda: "MXN" } }))).toThrow(RentasDomainError);
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "Narnia/CAS", moneda: "MXN" } }))).toThrow(RentasDomainError);
  });

  it("acepta zonas horarias IANA reales y también 'UTC'", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "America/Mexico_City", moneda: "MXN" } }))).not.toThrow();
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "UTC", moneda: "MXN" } }))).not.toThrow();
  });

  it("rechaza una moneda que no es un código ISO 4217 de 3 letras mayúsculas", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "UTC", moneda: "mxn" } }))).toThrow(RentasDomainError);
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ primeraPropiedad: { nombre: "X", zonaHoraria: "UTC", moneda: "PESOS" } }))).toThrow(RentasDomainError);
  });

  it("rechaza un correo de admin con formato inválido", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ admin: { nombreCompleto: "X", correo: "no-es-correo", password: "correcto-caballo-batería" } }))).toThrow(RentasDomainError);
  });

  it("rechaza una contraseña por debajo del mínimo (10 caracteres)", () => {
    expect(() => validarCapturaOnboardingRentas(cuerpoValido({ admin: { nombreCompleto: "X", correo: "x@x.mx", password: "corta" } }))).toThrow(RentasDomainError);
  });

  it("nunca incluye la contraseña en el objeto normalizado devuelto (defensa en profundidad contra logging accidental)", () => {
    const resultado = validarCapturaOnboardingRentas(cuerpoValido()) as unknown as Record<string, unknown>;
    expect(JSON.stringify(resultado)).not.toContain("correcto-caballo-batería");
    expect((resultado.admin as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("InMemoryRentasOnboardingRepository", () => {
  function entradaValida(overrides: Record<string, unknown> = {}) {
    const captura = validarCapturaOnboardingRentas(cuerpoValido());
    return {
      organizacion: { nombre: captura.organizacion.nombre, slugPropuesto: captura.slugPropuesto, tipoOrganizacion: captura.organizacion.tipoOrganizacion },
      primeraPropiedad: captura.primeraPropiedad,
      admin: { nombreCompleto: captura.admin.nombreCompleto, correo: captura.admin.correo, passwordHash: "hash-de-prueba" },
      primerOwner: null,
      ...overrides,
    };
  }

  it("crea organización + property + staff admin + configuración inicial, todo enlazado", async () => {
    const repo = new InMemoryRentasOnboardingRepository();
    const resultado = await repo.registrarTenant(entradaValida());

    expect(resultado.requiereVerificacionCorreo).toBe(true);
    expect(resultado.slug).toBe("rentas-cancun-elite");

    const org = repo.findOrganizacionById(resultado.organizationId);
    expect(org?.name).toBe("Rentas Cancún Élite");
    expect(org?.tipoOrganizacion).toBe("empresa_gestora");

    const property = repo.findPropiedadById(resultado.propertyId);
    expect(property?.organizationId).toBe(resultado.organizationId);
    expect(property?.zonaHoraria).toBe("America/Cancun");

    const staff = repo.findStaffByEmail("maria@rentas-cancun.mx");
    expect(staff?.id).toBe(resultado.staffId);
    expect(staff?.organizationId).toBe(resultado.organizationId);
  });

  it("resuelve una colisión de slug con un sufijo numérico incremental, sin fallar el registro", async () => {
    const repo = new InMemoryRentasOnboardingRepository();
    const primero = await repo.registrarTenant(entradaValida());
    const segundo = await repo.registrarTenant(
      entradaValida({
        admin: { nombreCompleto: "Otro Admin", correo: "otro@correo.mx", passwordHash: "hash-otro" },
      }),
    );
    expect(primero.slug).toBe("rentas-cancun-elite");
    expect(segundo.slug).toBe("rentas-cancun-elite-2");
    expect(segundo.organizationId).not.toBe(primero.organizationId);
  });

  it("rechaza un segundo registro con el MISMO correo de admin (unique real, no solo defensa en profundidad)", async () => {
    const repo = new InMemoryRentasOnboardingRepository();
    await repo.registrarTenant(entradaValida());
    await expect(repo.registrarTenant(entradaValida())).rejects.toThrow(RentasDomainError);
  });

  it("da de alta rentas.owner + rentas.owner_organization cuando primerOwner viene presente", async () => {
    const repo = new InMemoryRentasOnboardingRepository();
    const resultado = await repo.registrarTenant(entradaValida({ primerOwner: { nombre: "Juan Dueño", email: "juan@correo.mx" } }));
    const owners = repo.listOwnersDeOrganizacion(resultado.organizationId);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.name).toBe("Juan Dueño");
  });

  it("NO da de alta ningún owner cuando primerOwner es null (anfitrión auto-gestionado)", async () => {
    const repo = new InMemoryRentasOnboardingRepository();
    const resultado = await repo.registrarTenant(entradaValida());
    expect(repo.listOwnersDeOrganizacion(resultado.organizationId)).toHaveLength(0);
  });
});
