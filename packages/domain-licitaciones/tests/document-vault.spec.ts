import { describe, expect, it } from "vitest";
import { conflictStableKey, requirementStableKey, validateDocumentUpload } from "../src/document-vault.ts";

function pdf(body = "1 0 obj\n<<>>\nendobj\n", tail = "\n%%EOF\n"): Buffer {
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<<>>\nstartxref\n0${tail}`, "latin1");
}

/** Imagen PE minima valida: "MZ", e_lfanew en 0x3c apuntando a "PE\0\0". */
function peImage(): Buffer {
  const b = Buffer.alloc(0x100);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  return b;
}

describe("validateDocumentUpload (AE-03/AE-05)", () => {
  it("acepta un PDF cerrado con %%EOF", () => {
    expect(validateDocumentUpload(pdf())).toEqual({ ok: true, kind: "pdf" });
  });
  it("acepta un PDF con espacio en blanco tras %%EOF", () => {
    expect(validateDocumentUpload(pdf("", "\n%%EOF\r\n\r\n"))).toEqual({ ok: true, kind: "pdf" });
  });
  it("acepta texto plano", () => {
    expect(validateDocumentUpload(Buffer.from("El licitante debera presentar el anexo 3.", "utf8"))).toEqual({ ok: true, kind: "text" });
  });
  it("rechaza un PDF con un ejecutable PE pegado al final (MZ al final)", () => {
    const r = validateDocumentUpload(Buffer.concat([pdf(), peImage()]));
    expect(r).toMatchObject({ ok: false, reason: "ejecutable_rechazado" });
  });
  it("rechaza un PE aunque vaya antes del %%EOF, dentro del cuerpo del PDF", () => {
    const r = validateDocumentUpload(pdf(peImage().toString("latin1")));
    expect(r).toMatchObject({ ok: false, reason: "ejecutable_rechazado" });
  });
  it("no da falso positivo con un MZ casual sin cabecera PE", () => {
    expect(validateDocumentUpload(pdf("MZ casual dentro de un stream\n"))).toEqual({ ok: true, kind: "pdf" });
  });
  it("rechaza ZIP, DOCX y cualquier PK..", () => {
    expect(validateDocumentUpload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toMatchObject({ ok: false, reason: "zip_rechazado" });
    expect(validateDocumentUpload(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]))).toMatchObject({ ok: false, reason: "zip_rechazado" });
  });
  it("rechaza un PDF sin %%EOF (truncado)", () => {
    expect(validateDocumentUpload(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "latin1"))).toMatchObject({ ok: false, reason: "pdf_sin_eof" });
  });
  it("rechaza contenido que no sea espacio tras el ultimo %%EOF", () => {
    expect(validateDocumentUpload(pdf("", "\n%%EOF\nbasura"))).toMatchObject({ ok: false, reason: "pdf_contenido_tras_eof" });
  });
  it("rechaza vacio, binarios con NUL y un ELF", () => {
    expect(validateDocumentUpload(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "vacio" });
    expect(validateDocumentUpload(Buffer.from([1, 2, 0, 3, 4]))).toMatchObject({ ok: false, reason: "formato_no_soportado" });
    expect(validateDocumentUpload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))).toMatchObject({ ok: false, reason: "ejecutable_rechazado" });
  });
});

describe("claves estables", () => {
  const base = { documentRef: "linaje-1", topicKey: "garantia", page: 3, clause: "5.2", text: "El licitante   debera presentar GARANTIA." };
  it("el espacio y las mayusculas del texto no cambian la clave", () => {
    expect(requirementStableKey(base)).toBe(requirementStableKey({ ...base, text: "el licitante debera presentar garantia." }));
  });
  it("cambia con el documento, la pagina o el texto", () => {
    const k = requirementStableKey(base);
    expect(requirementStableKey({ ...base, documentRef: "linaje-2" })).not.toBe(k);
    expect(requirementStableKey({ ...base, page: 4 })).not.toBe(k);
    expect(requirementStableKey({ ...base, text: "Otro requisito distinto." })).not.toBe(k);
  });
  it("la huella del conflicto ignora el orden de las claves", () => {
    expect(conflictStableKey("deadline_mismatch", "plazo", ["b", "a"])).toBe(conflictStableKey("deadline_mismatch", "plazo", ["a", "b"]));
    expect(conflictStableKey("deadline_mismatch", "plazo", ["a", "b"])).not.toBe(conflictStableKey("deadline_mismatch", "plazo", ["a", "c"]));
  });
});
