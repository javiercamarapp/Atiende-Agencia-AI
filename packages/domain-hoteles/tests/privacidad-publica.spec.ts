// H-30 -- utilidades puras de la privacidad publica del huesped: parseo del formulario (honeypot, correo), slug de property,
// CSV con neutralizacion de formulas y las reglas del espejo en memoria (tope por contacto, codigo de un solo uso).
import { describe, expect, it } from "vitest";
import {
  InMemoryPublicPrivacyRepository,
  PrivacyInvalidInputError,
  correoCodigoArco,
  csvCell,
  guestDataToCsv,
  parsePublicArcoForm,
  parseVerificationCode,
  pickProperty,
  propertySlug,
  type GuestDataDocument,
  type PublicNoticeProperty,
} from "../src/index.ts";

describe("parsePublicArcoForm", () => {
  const base = { derecho: "acceso", nombre: "  Ana Torres ", correo: " ANA@Example.com ", descripcion: "  quiero mis datos  " };

  it("normaliza correo y recorta textos", () => {
    expect(parsePublicArcoForm(base)).toMatchObject({ rightType: "acceso", name: "Ana Torres", email: "ana@example.com", description: "quiero mis datos", honeypot: false, propertySlug: null });
  });
  it("el honeypot lleno no valida nada mas (el robot recibe la misma respuesta) y se marca", () => {
    expect(parsePublicArcoForm({ sitioWeb: "http://spam.example", derecho: 7 })).toMatchObject({ honeypot: true });
  });
  it("rechaza derecho fuera de catalogo, correo invalido y telefono en lugar de correo", () => {
    expect(() => parsePublicArcoForm({ ...base, derecho: "borrado" })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePublicArcoForm({ ...base, correo: "no-es-correo" })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePublicArcoForm({ ...base, correo: "+52 999 123 4567" })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePublicArcoForm({ ...base, nombre: "A" })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePublicArcoForm({ ...base, descripcion: "x".repeat(1001) })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePublicArcoForm(null)).toThrow(PrivacyInvalidInputError);
  });
  it("el codigo son exactamente 6 digitos", () => {
    expect(parseVerificationCode(" 012345 ")).toBe("012345");
    for (const bad of ["12345", "1234567", "abcdef", "", 123456, null]) expect(() => parseVerificationCode(bad)).toThrow(PrivacyInvalidInputError);
  });
});

describe("propertySlug / pickProperty", () => {
  const props: PublicNoticeProperty[] = [
    { propertyId: "1", propertyName: "Hotel Mérida — Centro", notice: null },
    { propertyId: "2", propertyName: "Hotel Mérida Playa", notice: null },
  ];
  it("slug sin acentos ni simbolos", () => {
    expect(propertySlug("Hotel Mérida — Centro")).toBe("hotel-merida-centro");
  });
  it("sin slug solo resuelve si hay una unica propiedad; con slug la encuentra; ambiguo o desconocido = null", () => {
    expect(pickProperty(props, null)).toBeNull();
    expect(pickProperty([props[0]!], null)?.propertyId).toBe("1");
    expect(pickProperty(props, "hotel-merida-playa")?.propertyId).toBe("2");
    expect(pickProperty(props, "otro")).toBeNull();
  });
});

describe("CSV de exportacion", () => {
  it("neutraliza formulas de hoja de calculo y escapa comillas, comas y saltos de linea", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+52 999")).toBe("'+52 999");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@usuario")).toBe("'@usuario");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("linea1\nlinea2")).toBe('"linea1\nlinea2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it("una fila por campo con seccion e indice", () => {
    const doc: GuestDataDocument = { perfil: { nombre: "Ana" }, estancias: [{ entrada: "2026-03-01" }, { entrada: "2026-04-01" }], consentimientos: [], identidad: [] };
    const lines = guestDataToCsv(doc).trim().split("\r\n");
    expect(lines[0]).toBe("seccion,indice,campo,valor");
    expect(lines).toContain("perfil,,nombre,Ana");
    expect(lines).toContain("estancias,1,entrada,2026-03-01");
    expect(lines).toContain("estancias,2,entrada,2026-04-01");
  });
});

describe("espejo en memoria (mismas reglas que la migracion 042)", () => {
  const prop = "00000000-0000-4000-8000-0000000000a1";
  const input = (id: string, over: Record<string, unknown> = {}) => ({
    requestId: id,
    propertyId: prop,
    rightType: "acceso" as const,
    name: "Ana Torres",
    contact: "ana@example.com",
    description: null,
    codeHash: "a".repeat(64),
    ttlSeconds: 900,
    email: { to: "ana@example.com", subject: "s", html: "<p>x</p>", text: "x" },
    today: "2026-10-01",
    ...over,
  });
  const repo = (now = () => 1_000_000) => {
    const r = new InMemoryPublicPrivacyRepository(now);
    r.properties = [{ propertyId: prop, propertyName: "Hotel", notice: null }];
    return r;
  };

  it("el codigo es de un solo uso y tras 5 fallos queda agotado aun con el correcto", async () => {
    const r = repo();
    await r.submitArco(input("id-1"));
    expect((await r.verifyArco("id-1", "b".repeat(64), "2026-10-01")).result).toBe("invalido");
    for (let i = 0; i < 4; i += 1) await r.verifyArco("id-1", "b".repeat(64), "2026-10-01");
    expect((await r.verifyArco("id-1", "a".repeat(64), "2026-10-01")).result).toBe("agotado");
    await r.submitArco(input("id-2"));
    expect((await r.verifyArco("id-2", "a".repeat(64), "2026-10-01")).result).toBe("ok");
    expect((await r.verifyArco("id-2", "a".repeat(64), "2026-10-01")).result).toBe("usado");
  });
  it("expira con el reloj y el plazo corre desde la verificacion (20 dias)", async () => {
    let now = 1_000_000;
    const r = repo(() => now);
    await r.submitArco(input("id-3"));
    now += 901_000;
    expect((await r.verifyArco("id-3", "a".repeat(64), "2026-10-01")).result).toBe("expirado");
    await r.submitArco(input("id-4"));
    await r.verifyArco("id-4", "a".repeat(64), "2026-10-05");
    expect(r.requests.get("id-4")).toMatchObject({ status: "recibida", receivedOn: "2026-10-05", responseDueOn: "2026-10-25" });
  });
  it("la cuarta solicitud sin verificar del mismo contacto en 24 h devuelve null y no inserta", async () => {
    const r = repo();
    for (const id of ["a", "b", "c"]) expect(await r.submitArco(input(id))).toBe(id);
    expect(await r.submitArco(input("d", { contact: "ANA@example.com" }))).toBeNull();
    expect(r.requests.size).toBe(3);
  });
  it("el correo del codigo escapa el nombre (HTML) y no filtra el hash", () => {
    const m = correoCodigoArco({ to: "a@b.co", hotelNombre: "Hotel", nombre: "<script>alert(1)</script>", derecho: "acceso", codigo: "123456", minutos: 15 });
    expect(m.html).not.toContain("<script>");
    expect(m.text).toContain("123456");
  });
});
