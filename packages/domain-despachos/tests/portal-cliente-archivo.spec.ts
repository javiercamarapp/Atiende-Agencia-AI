// D-08: validacion estricta de lo que sube el cliente final (tamano, tipo, firma, XXE/entidades).
import { describe, expect, it } from "vitest";
import { PORTAL_MAX_ARCHIVO_BYTES, sanitizarNombreArchivo, validarArchivoPortal } from "../src/portal-cliente/archivo.ts";
import { esTokenPortalValido, generarTokenPortal, hashTokenPortal } from "../src/portal-cliente/token.ts";
import { cfdiXmlPortal } from "./support/portal-cfdi-xml.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe("token del portal", () => {
  it("genera 43 caracteres base64url distintos cada vez y su hash es SHA-256 hex determinista", () => {
    const a = generarTokenPortal();
    const b = generarTokenPortal();
    expect(a).not.toBe(b);
    expect(esTokenPortalValido(a)).toBe(true);
    expect(hashTokenPortal(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTokenPortal(a)).toBe(hashTokenPortal(a));
    expect(hashTokenPortal(a)).not.toBe(hashTokenPortal(b));
    expect(hashTokenPortal(a)).not.toContain(a);
  });

  it("rechaza formas que no son un token (vacio, corto, caracteres raros, no-string)", () => {
    for (const malo of ["", "abc", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, `${"a".repeat(42)} `, null, undefined, 42]) {
      expect(esTokenPortalValido(malo)).toBe(false);
    }
  });
});

describe("validarArchivoPortal", () => {
  it("CFDI XML valido: tipo cfdi_xml y resumen minimo (nunca el XML completo)", () => {
    const r = validarArchivoPortal({ nombre: "factura julio.xml", contentType: "application/xml; charset=utf-8", bytes: enc(cfdiXmlPortal()) });
    expect(r).toMatchObject({ ok: true, tipo: "cfdi_xml", mimeType: "application/xml", nombreArchivo: "factura julio.xml" });
    if (!r.ok) throw new Error("inesperado");
    expect(r.resumen).toEqual({ folio_fiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", total: "1160.00", fecha: "2026-07-01", rfc_emisor: "CON950820K12", rfc_receptor: "XAXX010101000" });
  });

  it("acepta PDF, PNG y JPEG con firma correcta", () => {
    expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: PDF })).toMatchObject({ ok: true, tipo: "pdf" });
    expect(validarArchivoPortal({ nombre: "a.png", contentType: "image/png", bytes: PNG })).toMatchObject({ ok: true, tipo: "imagen" });
    expect(validarArchivoPortal({ nombre: "a.jpg", contentType: "image/jpeg", bytes: JPEG })).toMatchObject({ ok: true, tipo: "imagen" });
  });

  it("XXE: DOCTYPE con entidad externa se rechaza ANTES del parser", () => {
    const xxe = cfdiXmlPortal({ prologo: '<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x SYSTEM "file:///etc/passwd">]>' });
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc(xxe) })).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
  });

  it("billion laughs: entidades internas anidadas se rechazan", () => {
    const bomba = cfdiXmlPortal({ prologo: '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>' });
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc(bomba) })).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
  });

  it("<!ENTITY suelto, <!ELEMENT y hojas de estilo tambien se rechazan", () => {
    for (const extra of ['<!ENTITY y "z">', "<!ELEMENT a ANY>", '<?xml-stylesheet type="text/xsl" href="http://evil.example/x.xsl"?>']) {
      const r = validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc(cfdiXmlPortal({ extra })) });
      expect(r).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
    }
  });

  it("comentarios y CDATA siguen permitidos (no son DTD)", () => {
    const r = validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc(cfdiXmlPortal({ extra: "<!-- nota -->" })) });
    expect(r.ok).toBe(true);
  });

  it("XML mal formado o que no es CFDI 4.0 -> cfdi_invalido con el motivo del parser", () => {
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc("<a><b></a>") })).toMatchObject({ ok: false, codigo: "cfdi_invalido" });
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc("<a/>") })).toMatchObject({ ok: false, codigo: "cfdi_invalido" });
  });

  it("XML con codificacion declarada distinta de UTF-8, o bytes no UTF-8, se rechaza", () => {
    const l1 = cfdiXmlPortal({ prologo: '<?xml version="1.0" encoding="ISO-8859-1"?>' });
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: enc(l1) })).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
    expect(validarArchivoPortal({ nombre: "x.xml", contentType: "text/xml", bytes: new Uint8Array([0x3c, 0x61, 0xff, 0xfe, 0x3e]) })).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
  });

  it("firmas falsas: PDF/imagen/XML que no lo son", () => {
    expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: enc("<script>alert(1)</script>") })).toMatchObject({ ok: false, codigo: "firma_invalida" });
    expect(validarArchivoPortal({ nombre: "a.png", contentType: "image/png", bytes: JPEG })).toMatchObject({ ok: false, codigo: "firma_invalida" });
    expect(validarArchivoPortal({ nombre: "a.jpg", contentType: "image/jpeg", bytes: PNG })).toMatchObject({ ok: false, codigo: "firma_invalida" });
    expect(validarArchivoPortal({ nombre: "a.xml", contentType: "text/xml", bytes: PDF })).toMatchObject({ ok: false });
  });

  it("PDF con contenido activo (JavaScript, Launch, adjuntos) se rechaza", () => {
    for (const marca of ["/JavaScript", "/JS (app.alert(1))", "/Launch", "/EmbeddedFile"]) {
      const pdf = enc(`%PDF-1.4\n1 0 obj<</S /Action ${marca}>>endobj`);
      expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: pdf })).toMatchObject({ ok: false, codigo: "contenido_no_permitido" });
    }
  });

  it("tamano: vacio y mayor a 2 MiB se rechazan; exactamente 2 MiB de PDF se acepta", () => {
    expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array(0) })).toMatchObject({ ok: false, codigo: "vacio" });
    const grande = new Uint8Array(PORTAL_MAX_ARCHIVO_BYTES + 1);
    grande.set(PDF);
    expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: grande })).toMatchObject({ ok: false, codigo: "demasiado_grande" });
    const justo = new Uint8Array(PORTAL_MAX_ARCHIVO_BYTES);
    justo.set(PDF);
    expect(validarArchivoPortal({ nombre: "a.pdf", contentType: "application/pdf", bytes: justo }).ok).toBe(true);
  });

  it("tipos no permitidos: ejecutables, html, svg, zip, octet-stream, sin content-type", () => {
    for (const ct of ["application/x-msdownload", "text/html", "image/svg+xml", "application/zip", "application/octet-stream", "", null, undefined]) {
      expect(validarArchivoPortal({ nombre: "a.bin", contentType: ct, bytes: PDF })).toMatchObject({ ok: false, codigo: "tipo_no_permitido" });
    }
  });

  it("extension que contradice el tipo declarado (doble extension tipica) se rechaza", () => {
    expect(validarArchivoPortal({ nombre: "factura.exe", contentType: "application/pdf", bytes: PDF })).toMatchObject({ ok: false, codigo: "tipo_no_permitido" });
    expect(validarArchivoPortal({ nombre: "foto.pdf", contentType: "image/png", bytes: PNG })).toMatchObject({ ok: false, codigo: "tipo_no_permitido" });
  });
});

describe("sanitizarNombreArchivo", () => {
  it("quita rutas, caracteres de control y simbolos peligrosos; nunca vacio; tope 120", () => {
    expect(sanitizarNombreArchivo("../../etc/passwd.pdf", "pdf")).toBe("passwd.pdf");
    expect(sanitizarNombreArchivo("C:\\Users\\x\\factura.xml", "cfdi_xml")).toBe("factura.xml");
    expect(sanitizarNombreArchivo('a<b>:"c|d?e*.pdf', "pdf")).toBe("abcde.pdf");
    expect(sanitizarNombreArchivo("  .oculto.pdf", "pdf")).toBe("oculto.pdf");
    expect(sanitizarNombreArchivo("", "pdf")).toBe("archivo.pdf");
    expect(sanitizarNombreArchivo(null, "imagen")).toBe("archivo.png");
    const largo = sanitizarNombreArchivo(`${"a".repeat(300)}.pdf`, "pdf");
    expect(largo.length).toBe(120);
    expect(largo.endsWith(".pdf")).toBe(true);
  });
});
