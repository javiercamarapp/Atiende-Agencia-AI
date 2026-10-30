// paridad3 D-31 / D-P3-15 / D-P3-21 -- cliente del piloto (automatizacion, solicitudes), cierre con validaciones y portal con solicitudes/reportes:
// helpers puros y las llamadas HTTP reales (URL, metodo, cuerpo y cabeceras).
import { describe, expect, it, vi } from "vitest";
import {
  erroresAutomatizacion,
  fetchAutomatizacion,
  fetchSolicitudes,
  guardarAutomatizacion,
  marcarNoAplica,
  pedirDocumentos,
  periodoAnterior,
  reabrirRenglon,
  resumenRenglones,
  textoACuentas,
  ETIQUETA_SEMAFORO,
  TONO_SEMAFORO,
} from "../src/verticals/despachos/lib/piloto-client.ts";
import type { AutomatizacionCliente, SolicitudDocumentos } from "../src/verticals/despachos/lib/piloto-client.ts";
import { cerrarPeriodoCierre, descargarArtefactoCierre, motivoForzadoValido, textoPosCierre } from "../src/verticals/despachos/lib/cierre-mensual-client.ts";
import { descargarReportePortal, fetchPortalReportes, fetchPortalSolicitudes, PortalClienteError, renglonAdmiteArchivo, subirDocumentoPortal } from "../src/verticals/despachos/lib/portal-cliente-client.ts";
import { formatEstatusCancelacion, formatValidacionEfos } from "../src/verticals/despachos/lib/format.ts";

const AUTO: AutomatizacionCliente = { contactoCorreo: "a@b.mx", envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(respuesta: () => Response) {
  const llamadas: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    return respuesta();
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

describe("helpers puros del piloto", () => {
  it("periodoAnterior: el mes previo al de hoy, con salto de ejercicio en enero", () => {
    expect(periodoAnterior("2026-07-15")).toBe("2026-06");
    expect(periodoAnterior("2027-01-01")).toBe("2026-12");
  });

  it("erroresAutomatizacion: correo, dia, cuentas y el envio que exige correo", () => {
    expect(erroresAutomatizacion(AUTO)).toEqual({});
    expect(erroresAutomatizacion({ ...AUTO, contactoCorreo: "no-es-correo" }).contactoCorreo).toBeDefined();
    expect(erroresAutomatizacion({ ...AUTO, contactoCorreo: null, envioReportesCierre: true }).envioReportesCierre).toBeDefined();
    expect(erroresAutomatizacion({ ...AUTO, contactoCorreo: null }).contactoCorreo).toBeUndefined();
    expect(erroresAutomatizacion({ ...AUTO, solicitudDia: 29 }).solicitudDia).toBeDefined();
    expect(erroresAutomatizacion({ ...AUTO, solicitudDia: 0 }).solicitudDia).toBeDefined();
    expect(erroresAutomatizacion({ ...AUTO, plantilla: { estadosCuenta: Array.from({ length: 11 }, (_, i) => `c${i}`) } }).estadosCuenta).toBeDefined();
  });

  it("textoACuentas separa por linea o coma y descarta vacios", () => {
    expect(textoACuentas(" 111\n222, 333 \n\n")).toEqual(["111", "222", "333"]);
    expect(textoACuentas("")).toEqual([]);
  });

  it("resumenRenglones cuenta por estado", () => {
    const s: SolicitudDocumentos = {
      id: "s1", ejercicio: 2026, mes: 6, estado: "abierta", creadaEn: "x", completadaEn: null, ultimoRecordatorioNivel: 0,
      renglones: [
        { id: "1", tipo: "xml_emitidos", etiqueta: "a", estado: "recibido", motivoNoAplica: null, documentoId: null, resueltoEn: null },
        { id: "2", tipo: "xml_recibidos", etiqueta: "b", estado: "en_revision", motivoNoAplica: null, documentoId: null, resueltoEn: null },
        { id: "3", tipo: "otros", etiqueta: "c", estado: "pendiente", motivoNoAplica: null, documentoId: null, resueltoEn: null },
        { id: "4", tipo: "nomina", etiqueta: "d", estado: "no_aplica", motivoNoAplica: "x", documentoId: null, resueltoEn: null },
      ],
    };
    expect(resumenRenglones(s)).toBe("1 recibido(s) · 1 en revisión · 1 pendiente(s) · 1 no aplica");
  });

  it("el semaforo tiene etiqueta y tono para sus cuatro estados", () => {
    for (const k of ["verde", "amarillo", "rojo", "sin_solicitud"] as const) {
      expect(ETIQUETA_SEMAFORO[k]).toBeTruthy();
      expect(TONO_SEMAFORO[k]).toBeTruthy();
    }
    expect(TONO_SEMAFORO.rojo).toBe("danger");
  });

  it("motivoForzadoValido: 10 a 500 caracteres recortados", () => {
    expect(motivoForzadoValido("corto")).toBe(false);
    expect(motivoForzadoValido("   diez chars ")).toBe(true);
    expect(motivoForzadoValido("x".repeat(501))).toBe(false);
  });

  it("textoPosCierre traduce cada resultado y calla lo que no aplica", () => {
    expect(textoPosCierre({ papelPagos: "no_aplica", contabilidadElectronica: "no_generada", entrega: "no_activada" })).toEqual([]);
    const t = textoPosCierre({ papelPagos: "generado", contabilidadElectronica: "generada", entrega: "enviada" });
    expect(t).toHaveLength(3);
    expect(t.join(" ")).toMatch(/no se presentó/);
    expect(textoPosCierre({ papelPagos: "no_generado: Captura la ficha", contabilidadElectronica: "sin_libro_en_el_periodo", entrega: "no_enviada: tope" })).toEqual([
      "No se pudo generar el papel de pagos provisionales: Captura la ficha",
      "El libro no tiene movimientos en el periodo: no se generó contabilidad electrónica.",
      "No se pudo entregar los reportes al cliente: tope",
    ]);
  });

  it("formatEstatusCancelacion y formatValidacionEfos", () => {
    expect(formatEstatusCancelacion(null)).toBeNull();
    expect(formatEstatusCancelacion("En proceso")).toEqual({ texto: "Cancelación en proceso", tono: "warning" });
    expect(formatEstatusCancelacion("Plazo vencido")?.texto).toBe("Plazo vencido");
    expect(formatEstatusCancelacion("Solicitud rechazada")?.tono).toBe("success");
    expect(formatEstatusCancelacion("Cancelado sin aceptación")?.tono).toBe("danger");
    expect(formatValidacionEfos("200")).toBe("El emisor no figura en la lista 69-B");
    expect(formatValidacionEfos("100")).toBe("El emisor figura en la lista 69-B");
    expect(formatValidacionEfos("500")).toBe("Código 500");
    expect(formatValidacionEfos(null)).toBeNull();
  });

  it("renglonAdmiteArchivo: solo lo que falta o esta en revision", () => {
    expect(renglonAdmiteArchivo("pendiente")).toBe(true);
    expect(renglonAdmiteArchivo("en_revision")).toBe(true);
    expect(renglonAdmiteArchivo("recibido")).toBe(false);
    expect(renglonAdmiteArchivo("no_aplica")).toBe(false);
  });
});

describe("llamadas HTTP del piloto (staff)", () => {
  it("fetchAutomatizacion / guardarAutomatizacion: GET y PUT a /automatizacion con el cuerpo tal cual", async () => {
    const { f, llamadas } = fakeFetch(() => json({ disponible: true, automatizacion: AUTO }));
    expect((await fetchAutomatizacion(f, "https://api.test", "tok", "p1")).automatizacion).toEqual(AUTO);
    await guardarAutomatizacion(f, "https://api.test", "tok", "p1", AUTO);
    expect(llamadas[0]).toMatchObject({ url: "https://api.test/despachos/p1/automatizacion", method: "GET" });
    expect(llamadas[1]).toMatchObject({ url: "https://api.test/despachos/p1/automatizacion", method: "PUT", body: AUTO });
  });

  it("fetchSolicitudes, pedirDocumentos, marcarNoAplica y reabrirRenglon pegan a las rutas reales", async () => {
    const { f, llamadas } = fakeFetch(() => json({ disponible: true, solicitudes: [], id: "s1", creada: true, correo: "enviado", ok: true }));
    await fetchSolicitudes(f, "https://api.test", "tok", "p1");
    expect((await pedirDocumentos(f, "https://api.test", "tok", "p1", "2026-06")).correo).toBe("enviado");
    await marcarNoAplica(f, "https://api.test", "tok", "p1", "r1", "No facturó");
    await reabrirRenglon(f, "https://api.test", "tok", "p1", "r1");
    expect(llamadas.map((l) => `${l.method} ${l.url.replace("https://api.test/despachos/p1", "")}`)).toEqual([
      "GET /solicitudes-documentos",
      "POST /solicitudes-documentos",
      "POST /solicitudes-documentos/renglones/r1/no-aplica",
      "POST /solicitudes-documentos/renglones/r1/reabrir",
    ]);
    expect(llamadas[1]!.body).toEqual({ periodo: "2026-06" });
    expect(llamadas[2]!.body).toEqual({ motivo: "No facturó" });
  });

  it("un error del servidor sube con su mensaje real", async () => {
    const { f } = fakeFetch(() => json({ code: "validation_error", message: "motivo: explica en 3 a 300 caracteres" }, 400));
    await expect(marcarNoAplica(f, "https://api.test", "tok", "p1", "r1", "x")).rejects.toThrow("motivo: explica");
  });
});

describe("cierre: cerrar con forzado y descarga de artefactos", () => {
  it("cerrar normal manda solo la confirmacion; forzado agrega forzar y motivo", async () => {
    const { f, llamadas } = fakeFetch(() => json({ id: "per-1", status: "closed" }));
    await cerrarPeriodoCierre(f, "https://api.test", "tok", "p1", "per-1", "2026-06");
    await cerrarPeriodoCierre(f, "https://api.test", "tok", "p1", "per-1", "2026-06", { motivo: "Cierro con la diferencia conocida" });
    const cierres = llamadas.filter((l) => l.method === "POST" && l.url.endsWith("/cerrar"));
    expect(cierres[0]!.body).toEqual({ confirmacion: "2026-06" });
    expect(cierres[1]!.body).toEqual({ confirmacion: "2026-06", forzar: true, motivo: "Cierro con la diferencia conocida" });
  });

  it("descargarArtefactoCierre pega a la ruta de descarga y devuelve el blob con el nombre del servidor", async () => {
    const { f, llamadas } = fakeFetch(() => new Response("<xml/>", { status: 200, headers: { "content-disposition": 'attachment; filename="balanza-2026-06.xml"' } }));
    const r = await descargarArtefactoCierre(f, "https://api.test", "tok", "p1", "per-1", "a1", "x.xml");
    expect(r.nombre).toBe("balanza-2026-06.xml");
    expect(llamadas.some((l) => l.url === "https://api.test/despachos/p1/cierre-mensual/periodos/per-1/artefactos/a1/descargar")).toBe(true);
  });
});

describe("portal publico: solicitudes, reportes y subida para un renglon", () => {
  const TOKEN = "A".repeat(43);

  it("las secciones nuevas se piden con el token en el header y 503 = seccion oculta (null), no error", async () => {
    const { f, llamadas } = fakeFetch(() => json({ solicitudes: [{ id: "s1" }], reportes: [] }));
    expect(await fetchPortalSolicitudes(f, "https://api.test", TOKEN)).toEqual([{ id: "s1" }]);
    expect(await fetchPortalReportes(f, "https://api.test", TOKEN)).toEqual([]);
    expect(llamadas[0]!.headers["x-portal-token"]).toBe(TOKEN);
    expect(llamadas[0]!.url).toBe("https://api.test/portal-cliente/solicitudes");
    const caido = fakeFetch(() => json({ code: "service_unavailable", message: "no disponible" }, 503));
    expect(await fetchPortalSolicitudes(caido.f, "https://api.test", TOKEN)).toBeNull();
    expect(await fetchPortalReportes(caido.f, "https://api.test", TOKEN)).toBeNull();
    const invalido = fakeFetch(() => json({ code: "enlace_no_valido", message: "no valido" }, 404));
    await expect(fetchPortalSolicitudes(invalido.f, "https://api.test", TOKEN)).rejects.toBeInstanceOf(PortalClienteError);
  });

  it("subir para un renglon agrega ?renglonId= (codificado); sin renglon la URL no cambia", async () => {
    const { f, llamadas } = fakeFetch(() => json({ id: "d1", estado: "recibido", duplicado: false, nombreArchivo: "a.pdf", renglon: { vinculado: true, estado: "en_revision" } }, 201));
    const archivo = { name: "a.pdf", type: "application/pdf", size: 5, arrayBuffer: async () => new ArrayBuffer(5) };
    const r = await subirDocumentoPortal(f, "https://api.test", TOKEN, archivo, "r 1");
    expect(r.renglon).toEqual({ vinculado: true, estado: "en_revision" });
    await subirDocumentoPortal(f, "https://api.test", TOKEN, archivo);
    expect(llamadas[0]!.url).toBe("https://api.test/portal-cliente/documentos?renglonId=r%201");
    expect(llamadas[1]!.url).toBe("https://api.test/portal-cliente/documentos");
  });

  it("descargarReportePortal usa el id del archivo y el token", async () => {
    const { f, llamadas } = fakeFetch(() => new Response("%PDF-", { status: 200 }));
    const r = await descargarReportePortal(f, "https://api.test", TOKEN, { id: "a/1", tipo: "diot", nombreArchivo: "diot.pdf", tamanoBytes: 5 });
    expect(r.nombre).toBe("diot.pdf");
    expect(llamadas[0]!.url).toBe("https://api.test/portal-cliente/reportes/a%2F1");
    expect(llamadas[0]!.headers["x-portal-token"]).toBe(TOKEN);
  });
});
