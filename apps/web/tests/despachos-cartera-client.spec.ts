// D-21 -- cliente de la cartera: helpers puros (RFC, formulario, resumen) y las llamadas HTTP (URL, metodo, cuerpo).
import { describe, expect, it, vi } from "vitest";
import {
  REGIMENES_FISCALES,
  crearCliente,
  cuerpoFicha,
  erroresFormulario,
  etiquetaTipoPersona,
  fetchCartera,
  FORMULARIO_VACIO,
  formularioDesdeCliente,
  guardarFicha,
  mensajeCp,
  mensajeRfc,
  resumenCartera,
  tipoPersonaDeRfc,
} from "../src/verticals/despachos/lib/cartera-client.ts";
import type { CarteraRespuesta, ClienteCartera, FichaFormulario } from "../src/verticals/despachos/lib/cartera-client.ts";

const FICHA = { propertyId: "p1", rfc: "ABC010101AB1", tipoPersona: "moral", razonSocial: "Uno SA", regimenesFiscales: [{ clave: "601", nombre: "General de Ley Personas Morales" }], cpFiscal: "06600", periodicidad: "bimestral", responsableId: "u-1", creadoEn: "2026-09-01", actualizadoEn: "2026-09-02" } as const;
const FORM: FichaFormulario = { nombre: " Cliente Uno ", rfc: " abc010101ab1 ", razonSocial: " Uno SA ", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual", responsableId: "" };

describe("mensajeRfc / tipoPersonaDeRfc", () => {
  it("acepta moral (12) y fisica (13) y deriva el tipo", () => {
    expect(mensajeRfc("ABC010101AB1")).toBeNull();
    expect(mensajeRfc(" pepj800101ab1 ")).toBeNull();
    expect(tipoPersonaDeRfc("ABC010101AB1")).toBe("moral");
    expect(tipoPersonaDeRfc("PEPJ800101AB1")).toBe("fisica");
    expect(etiquetaTipoPersona("moral")).toBe("Persona moral");
    expect(etiquetaTipoPersona("fisica")).toBe("Persona física");
  });
  it.each([["", /obligatorio/], ["XAXX010101000", /genérico/], ["ABC", /12/], ["AB!010101AB1", /estructura/], ["ABC011301AB1", /fecha/], ["ABC010132AB1", /fecha/], ["ABC010230AB1", /fecha/]])("rechaza %j", (rfc, patron) => {
    expect(mensajeRfc(rfc)).toMatch(patron);
    expect(tipoPersonaDeRfc(rfc)).toBeNull();
  });
});

describe("mensajeCp", () => {
  it("5 digitos exactos", () => {
    expect(mensajeCp("06600")).toBeNull();
    expect(mensajeCp("6600")).toMatch(/5 dígitos/);
    expect(mensajeCp("abcde")).not.toBeNull();
  });
});

describe("erroresFormulario / cuerpoFicha", () => {
  it("formulario valido -> sin errores; el alta exige nombre y la edicion no", () => {
    expect(erroresFormulario(FORM, { alta: true })).toEqual({});
    expect(erroresFormulario({ ...FORM, nombre: "" }, { alta: true })).toEqual({ nombre: expect.any(String) });
    expect(erroresFormulario({ ...FORM, nombre: "" }, { alta: false })).toEqual({});
  });
  it("acumula errores por campo", () => {
    const e = erroresFormulario({ ...FORMULARIO_VACIO }, { alta: true });
    expect(Object.keys(e).sort()).toEqual(["cpFiscal", "nombre", "razonSocial", "regimenesFiscales", "rfc"]);
  });
  it("cuerpo normalizado: RFC mayuscula, textos recortados, responsable vacio se omite, nombre solo en el alta", () => {
    expect(cuerpoFicha(FORM, { alta: true })).toEqual({ nombre: "Cliente Uno", rfc: "ABC010101AB1", razonSocial: "Uno SA", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual" });
    expect(cuerpoFicha({ ...FORM, responsableId: "u-1" }, { alta: false })).toEqual({ rfc: "ABC010101AB1", razonSocial: "Uno SA", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual", responsableId: "u-1" });
  });
  it("el catalogo de regimenes trae claves de 3 digitos sin repetidas", () => {
    const claves = REGIMENES_FISCALES.map((r) => r.clave);
    expect(new Set(claves).size).toBe(claves.length);
    expect(claves.every((c) => /^\d{3}$/.test(c))).toBe(true);
    expect(claves).toEqual(expect.arrayContaining(["601", "612", "626"]));
  });
});

describe("formularioDesdeCliente", () => {
  it("precarga la ficha existente y deja vacio un cliente sin ficha", () => {
    const con: ClienteCartera = { propertyId: "p1", nombre: "Cliente Uno", ficha: FICHA };
    expect(formularioDesdeCliente(con)).toEqual({ nombre: "Cliente Uno", rfc: "ABC010101AB1", razonSocial: "Uno SA", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "bimestral", responsableId: "u-1" });
    expect(formularioDesdeCliente({ propertyId: "p2", nombre: "Sin ficha", ficha: null })).toEqual({ ...FORMULARIO_VACIO, nombre: "Sin ficha" });
  });
});

describe("resumenCartera", () => {
  const cli = (ficha: boolean): ClienteCartera => ({ propertyId: String(Math.random()), nombre: "c", ficha: ficha ? FICHA : null });
  it("distingue con ficha, sin ficha, vacio y base sin migrar (nunca presenta no_disponible como completa)", () => {
    expect(resumenCartera({ estado: "disponible", puedeDarDeAlta: true, clientes: [cli(true), cli(true)] }).mensaje).toBe("2 clientes con ficha fiscal completa.");
    expect(resumenCartera({ estado: "disponible", puedeDarDeAlta: true, clientes: [cli(true)] }).mensaje).toBe("1 cliente con ficha fiscal completa.");
    const r = resumenCartera({ estado: "disponible", puedeDarDeAlta: true, clientes: [cli(true), cli(false), cli(false)] });
    expect(r).toMatchObject({ total: 3, conFicha: 1, sinFicha: 2 });
    expect(r.mensaje).toContain("2 de 3 clientes sin ficha fiscal");
    expect(resumenCartera({ estado: "disponible", puedeDarDeAlta: true, clientes: [] }).mensaje).toMatch(/Todavía no hay/);
    const sinMigrar = resumenCartera({ estado: "no_disponible", puedeDarDeAlta: true, clientes: [cli(false)] });
    expect(sinMigrar).toMatchObject({ conFicha: 0, sinFicha: 1 });
    expect(sinMigrar.mensaje).toMatch(/aún no está habilitada/);
  });
});

describe("llamadas HTTP", () => {
  it("fetchCartera: GET /v1/despachos/:orgSlug/admin/cartera", async () => {
    const body: CarteraRespuesta = { estado: "disponible", puedeDarDeAlta: true, clientes: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/despachos/mi-despacho/admin/cartera");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchCartera(fetchImpl, "http://api.local", "tok", "mi-despacho")).toEqual(body);
  });
  it("crearCliente: POST con el cuerpo normalizado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/despachos/mi-despacho/admin/cartera");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ nombre: "Cliente Uno", rfc: "ABC010101AB1", razonSocial: "Uno SA", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual" });
      return new Response(JSON.stringify({ propertyId: "p9", nombre: "Cliente Uno" }), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await crearCliente(fetchImpl, "http://api.local", "tok", "mi-despacho", FORM)).toEqual({ propertyId: "p9", nombre: "Cliente Uno" });
  });
  it("guardarFicha: PUT .../cartera/ficha sin el nombre y devuelve la ficha", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/p1/cartera/ficha");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("nombre");
      return new Response(JSON.stringify({ ficha: FICHA }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await guardarFicha(fetchImpl, "http://api.local", "tok", "p1", FORM)).toEqual(FICHA);
  });
  it("un error del servidor (409 RFC duplicado) sube con su mensaje", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "conflict", message: "Ya existe un cliente con ese RFC en tu despacho." }), { status: 409 })) as unknown as typeof fetch;
    await expect(crearCliente(fetchImpl, "http://api.local", "tok", "mi-despacho", FORM)).rejects.toThrow(/Ya existe un cliente con ese RFC/);
  });
});
