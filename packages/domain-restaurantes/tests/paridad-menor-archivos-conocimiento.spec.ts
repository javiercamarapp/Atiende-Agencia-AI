// F4c (3) -- archivos de conocimiento: tipo REAL por firma, tamano, escaneo, extraccion con adaptador FALSO, borradores, listado y borrado.
// Datos sinteticos: los "PDF" y "PNG" son bytes minimos construidos aqui, no documentos reales.
import { describe, expect, it } from "vitest";
import {
  ARCHIVOS_MAX_POR_ORGANIZACION,
  ARCHIVO_MAX_BYTES,
  EscanerFalso,
  EscanerHeuristico,
  ExtractorTextoFalso,
  ExtractorTextoNoConfigurado,
  InMemoryArchivosConocimientoRepository,
  TROZO_MAX_CARACTERES,
  borrarArchivoConocimiento,
  detectarMimeReal,
  nombreArchivoSeguro,
  procesarCargaArchivo,
  trocearTexto,
  validarArchivoEntrante,
} from "../src/index.ts";
import { InMemoryRestaurantesRepository } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTRA = "00000000-0000-4000-8000-000000000002";
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (cuerpo = "1 0 obj << /Type /Catalog >> endobj") => enc(`%PDF-1.4\n${cuerpo}\n%%EOF`);
const png = (extra = "") => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc(`IHDR${extra}`)]);
const jpg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const webp = () => Uint8Array.from([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBPVP8 ")]);

describe("tipo real por firma", () => {
  it("reconoce pdf/png/jpg/webp y nada mas", () => {
    expect(detectarMimeReal(pdf())).toBe("application/pdf");
    expect(detectarMimeReal(png())).toBe("image/png");
    expect(detectarMimeReal(jpg())).toBe("image/jpeg");
    expect(detectarMimeReal(webp())).toBe("image/webp");
    expect(detectarMimeReal(enc("MZ\u0090\u0000 ejecutable"))).toBeNull();
    expect(detectarMimeReal(enc("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectarMimeReal(new Uint8Array(0))).toBeNull();
  });
});

describe("validarArchivoEntrante", () => {
  it("acepta un PDF y calcula su huella", () => {
    const r = validarArchivoEntrante({ nombre: "Carta de eventos.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    expect(r).toMatchObject({ ok: true, mime: "application/pdf", nombre: "Carta de eventos.pdf" });
    expect(r.ok && r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rechaza vacio, tipo falso, extension falsa, Content-Type falso y tamano excedido", () => {
    expect(validarArchivoEntrante({ nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: new Uint8Array(0) })).toMatchObject({ ok: false, motivo: "vacio" });
    // Un ejecutable renombrado a .pdf con Content-Type pdf: el contenido real manda.
    expect(validarArchivoEntrante({ nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: enc("MZ\u0090\u0000programa") })).toMatchObject({ ok: false, motivo: "tipo_no_permitido" });
    expect(validarArchivoEntrante({ nombre: "foto.pdf", mimeDeclarado: "application/pdf", bytes: png() })).toMatchObject({ ok: false, motivo: "tipo_no_coincide" });
    expect(validarArchivoEntrante({ nombre: "foto.png", mimeDeclarado: "application/pdf", bytes: png() })).toMatchObject({ ok: false, motivo: "tipo_no_coincide" });
    expect(validarArchivoEntrante({ nombre: "foto.png", mimeDeclarado: "image/png; charset=binary", bytes: png() }).ok).toBe(true);
    const grande = new Uint8Array(ARCHIVO_MAX_BYTES["image/png"] + 1);
    grande.set(png());
    expect(validarArchivoEntrante({ nombre: "foto.png", mimeDeclarado: "image/png", bytes: grande })).toMatchObject({ ok: false, motivo: "demasiado_grande" });
    expect(validarArchivoEntrante({ nombre: "///", mimeDeclarado: "application/pdf", bytes: pdf() })).toMatchObject({ ok: false, motivo: "nombre_invalido" });
  });
  it("el nombre se sanea: sin ruta, sin controles, acotado", () => {
    expect(nombreArchivoSeguro("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(nombreArchivoSeguro("C:\\Users\\x\\menu.pdf")).toBe("menu.pdf");
    expect(nombreArchivoSeguro("a\nb\u202ec.pdf")).toBe("a b c.pdf");
    expect(nombreArchivoSeguro("x".repeat(300) + ".pdf")!.length).toBeLessThanOrEqual(120);
    expect(nombreArchivoSeguro("..")).toBeNull();
  });
});

describe("EscanerHeuristico", () => {
  const esc = new EscanerHeuristico();
  it("deja pasar archivos normales", async () => {
    expect((await esc.escanear(pdf(), "application/pdf")).limpio).toBe(true);
    expect((await esc.escanear(png(), "image/png")).limpio).toBe(true);
  });
  it("rechaza EICAR, PDF con JavaScript/acciones (incluso ofuscado con #xx), polyglots y ejecutables incrustados", async () => {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    expect((await esc.escanear(png(eicar), "image/png")).limpio).toBe(false);
    expect((await esc.escanear(pdf("<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"), "application/pdf")).limpio).toBe(false);
    expect((await esc.escanear(pdf("<< /J#61vaScript 5 0 R >>"), "application/pdf")).limpio).toBe(false);
    expect((await esc.escanear(pdf("<< /Launch << /F (cmd.exe) >> >>"), "application/pdf")).limpio).toBe(false);
    expect((await esc.escanear(png("<?php system($_GET[0]); ?>"), "image/png")).limpio).toBe(false);
    expect((await esc.escanear(jpg(), "image/jpeg")).limpio).toBe(true);
    expect((await esc.escanear(Uint8Array.from([...png(), ...enc("\u007fELF....")]), "image/png")).limpio).toBe(false);
  });
});

describe("trocearTexto", () => {
  it("respeta el tope por trozo y descarta vacios", () => {
    const parrafo = "palabra ".repeat(120).trim(); // ~960
    const { trozos } = trocearTexto(`${parrafo}\n\n${parrafo}\n\n\n\n${parrafo}\n\n   \n\n${parrafo}`);
    expect(trozos.length).toBeGreaterThan(1);
    for (const t of trozos) expect(t.length).toBeLessThanOrEqual(TROZO_MAX_CARACTERES);
    expect(trozos.join(" ").replace(/\s+/g, " ")).toContain("palabra palabra");
  });
  it("un parrafo gigante se parte; mas de 20 trozos se truncan", () => {
    expect(trocearTexto("x".repeat(5000)).trozos.every((t) => t.length <= TROZO_MAX_CARACTERES)).toBe(true);
    const muchos = Array.from({ length: 60 }, (_, i) => `${"y".repeat(1500)}${i}`).join("\n\n");
    const r = trocearTexto(muchos);
    expect(r.trozos.length).toBe(20);
    expect(r.truncado).toBe(true);
  });
});

function armar(opciones: { texto?: string | null; extractor?: ExtractorTextoFalso | ExtractorTextoNoConfigurado; escaner?: EscanerFalso | EscanerHeuristico } = {}) {
  const restaurantes = new InMemoryRestaurantesRepository();
  restaurantes.seedOrganization({ id: ORG, slug: "taqueria-de-prueba", name: "Taqueria de prueba" });
  const archivos = new InMemoryArchivosConocimientoRepository();
  const extractor = opciones.extractor ?? new ExtractorTextoFalso(opciones.texto === undefined ? "Aceptamos reservaciones para grupos de mas de diez personas con un dia de anticipacion.\n\nEl estacionamiento es gratuito para clientes." : opciones.texto);
  const deps = { escaner: opciones.escaner ?? new EscanerHeuristico(), extractor, archivos, conocimiento: restaurantes, nombresCatalogo: ["Tacos al pastor"] };
  return { restaurantes, archivos, extractor, deps };
}

describe("procesarCargaArchivo", () => {
  it("camino feliz: crea BORRADORES importados (no publicados) y registra el archivo", async () => {
    const { restaurantes, deps } = armar();
    const r = await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "politicas.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    expect(r.estado).toBe("procesado");
    if (r.estado !== "procesado") return;
    expect(r.borradores).toBe(1);
    expect(r.archivo.entradasIds).toHaveLength(1);
    const lectura = await restaurantes.listarConocimiento(ORG);
    expect(lectura.entradas).toHaveLength(1);
    expect(lectura.entradas[0]).toMatchObject({ estado: "borrador", origen: "importado", tipo: "faq" });
    // Un borrador NO llega al prompt: solo lo publicado.
    expect(await restaurantes.listarConocimientoPublicado(ORG, null)).toHaveLength(0);
  });

  it("sin extractor configurado: 'no disponible aun' y NO guarda nada (no hay maqueta)", async () => {
    const { archivos, deps } = armar({ extractor: new ExtractorTextoNoConfigurado() });
    const r = await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    expect(r.estado).toBe("no_disponible");
    expect((await archivos.listar(ORG)).archivos).toHaveLength(0);
  });

  it("archivo infectado: rechazado ANTES de extraer texto", async () => {
    const { deps, extractor } = armar();
    const r = await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf("<< /JS (x) >>") });
    expect(r).toMatchObject({ estado: "rechazado", motivo: "infectado" });
    expect((extractor as ExtractorTextoFalso).llamadas).toHaveLength(0);
  });

  it("tipo falso: ni escanea ni extrae", async () => {
    const escaner = new EscanerFalso();
    const { deps, extractor } = armar({ escaner });
    const r = await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: enc("MZ\u0090\u0000programa") });
    expect(r).toMatchObject({ estado: "rechazado", motivo: "tipo_no_permitido" });
    expect(escaner.escaneados).toHaveLength(0);
    expect((extractor as ExtractorTextoFalso).llamadas).toHaveLength(0);
  });

  it("el mismo archivo dos veces: duplicado", async () => {
    const { deps } = armar();
    const e = { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf() };
    expect((await procesarCargaArchivo(deps, e)).estado).toBe("procesado");
    expect(await procesarCargaArchivo(deps, e)).toMatchObject({ estado: "rechazado", motivo: "duplicado" });
  });

  it("limite de archivos por organizacion", async () => {
    const { archivos, deps } = armar();
    for (let i = 0; i < ARCHIVOS_MAX_POR_ORGANIZACION; i++) await archivos.crear(ORG, { nombre: `f${i}.pdf`, mime: "application/pdf", tamanoBytes: 10, sha256: String(i).padStart(64, "0"), caracteresTexto: 1, entradasIds: [], subidoPor: "u1" });
    expect(await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "nuevo.pdf", mimeDeclarado: "application/pdf", bytes: pdf("otro") })).toMatchObject({ estado: "rechazado", motivo: "limite_de_archivos" });
  });

  it("los trozos con precios o nombres del menu se omiten y se reportan; si todo se omite, rechazado", async () => {
    const mixto = armar({ texto: "Politica de reservaciones para grupos grandes.\n\nLos Tacos al pastor cuestan $35 cada uno." });
    const r = await procesarCargaArchivo(mixto.deps, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    // Ambos parrafos caben en un solo trozo (< 1800): el trozo completo trae precio, asi que se omite.
    expect(r).toMatchObject({ estado: "rechazado", motivo: "sin_contenido_utilizable" });
    const largo = armar({ texto: `${"Politica general de la casa. ".repeat(60)}\n\n${"Los Tacos al pastor cuestan $35. ".repeat(60)}` });
    const r2 = await procesarCargaArchivo(largo.deps, { organizationId: ORG, actorId: "u1", nombre: "b.pdf", mimeDeclarado: "application/pdf", bytes: pdf("b") });
    expect(r2.estado).toBe("procesado");
    if (r2.estado === "procesado") expect(r2.omitidos.length).toBeGreaterThan(0);
  });

  it("sin texto extraible: rechazado", async () => {
    const { deps } = armar({ texto: null });
    expect(await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "a.png", mimeDeclarado: "image/png", bytes: png() })).toMatchObject({ estado: "rechazado", motivo: "sin_texto" });
  });
});

describe("listado y borrado", () => {
  it("el listado es por organizacion y el borrado quita registro Y borradores; otra organizacion no puede borrar", async () => {
    const { restaurantes, archivos, deps } = armar();
    const r = await procesarCargaArchivo(deps, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    if (r.estado !== "procesado") throw new Error("esperaba procesado");
    expect((await archivos.listar(ORG)).archivos).toHaveLength(1);
    expect((await archivos.listar(OTRA)).archivos).toHaveLength(0);
    expect(await borrarArchivoConocimiento(deps, OTRA, r.archivo.id)).toBeNull();
    expect((await restaurantes.listarConocimiento(ORG)).entradas).toHaveLength(1);
    const b = await borrarArchivoConocimiento(deps, ORG, r.archivo.id);
    expect(b).toMatchObject({ entradasBorradas: 1 });
    expect((await archivos.listar(ORG)).archivos).toHaveLength(0);
    expect((await restaurantes.listarConocimiento(ORG)).entradas).toHaveLength(0);
    expect(await borrarArchivoConocimiento(deps, ORG, r.archivo.id)).toBeNull();
  });
});
