import { describe, expect, it, vi } from "vitest";
import {
  actIncidente,
  advanceArco,
  blockIdentidad,
  decideAcceso,
  etiquetaHoras,
  extendArco,
  fetchArco,
  fetchAvisos,
  fetchBitacora,
  fetchConfiguracion,
  fetchIncidentes,
  fetchPrivacidadInfo,
  fetchRetenciones,
  openArco,
  placeRetencion,
  publishAviso,
  releaseRetencion,
  reportIncidente,
  requestAccesoExcepcional,
  revealAccesoExcepcional,
  revokeConsentimiento,
  saveVentanaBloqueo,
  textoPlazo,
} from "../src/verticals/hoteles/lib/privacidad-client.ts";

const API = "http://api.local";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function recorder(respond: (method: string, path: string) => unknown = () => ({ disponible: true, items: [] })) {
  const calls: Array<[string, string, unknown]> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(`${API}/hoteles/p1/privacidad/`, "");
    calls.push([method, path, init?.body ? JSON.parse(init.body as string) : undefined]);
    return ok(respond(method, path));
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("privacidad-client (hoteles)", () => {
  it("las lecturas usan las rutas reales de /privacidad", async () => {
    const { f, calls } = recorder();
    await fetchPrivacidadInfo(f, API, "t", "p1");
    await fetchConfiguracion(f, API, "t", "p1");
    await fetchAvisos(f, API, "t", "p1");
    await fetchArco(f, API, "t", "p1");
    await fetchIncidentes(f, API, "t", "p1");
    await fetchRetenciones(f, API, "t", "p1");
    await fetchBitacora(f, API, "t", "p1");
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(["GET info", "GET configuracion", "GET avisos", "GET arco", "GET incidentes", "GET retenciones", "GET bitacora?limit=50"]);
  });

  it("las escrituras mandan el cuerpo exacto (aviso, ARCO, prorroga, incidente, retencion, bloqueo, acceso excepcional)", async () => {
    const { f, calls } = recorder((_m, p) => (p.endsWith("decidir") ? { resultado: "aprobada" } : p.endsWith("revelar") ? { documento: { nombreCompleto: "Ana", numeroDocumento: "X1" } } : p.startsWith("identidades/i1/bloquear") ? { identidad: { id: "i1", estado: "bloqueada" } } : {}));
    await saveVentanaBloqueo(f, API, "t", "p1", 14);
    await publishAviso(f, API, "t", "p1", { version: "v1", textoSimplificado: "x".repeat(25), finalidadesObligatorias: ["identificar"], finalidadesOpcionales: [] });
    await revokeConsentimiento(f, API, "t", "p1", "c1", "El titular retira su consentimiento");
    await openArco(f, API, "t", "p1", { derecho: "acceso", solicitante: "Juan", canal: "correo" });
    await advanceArco(f, API, "t", "p1", "a1", "procedente", "Procede la solicitud del titular");
    await extendArco(f, API, "t", "p1", "a1", "Se requiere recabar informacion");
    await reportIncidente(f, API, "t", "p1", { tipo: "divulgacion", severidad: "alta", titulo: "Correo equivocado", descripcion: "Se envio a otra persona.", riesgoSignificativo: true });
    await actIncidente(f, API, "t", "p1", "n1", { accion: "registrar_notificacion", canal: "correo", constancia: "0007" });
    await placeRetencion(f, API, "t", "p1", "i1", { folio: "FGR-1", motivo: "Carpeta de investigacion abierta", autorizacion: "Direccion juridica" });
    await releaseRetencion(f, API, "t", "p1", "h1", "Caso cerrado por la autoridad");
    expect((await blockIdentidad(f, API, "t", "p1", "i1", "Bloqueo preventivo del titular"))?.id).toBe("i1");
    await requestAccesoExcepcional(f, API, "t", "p1", "i1", "Requerimiento de autoridad con oficio");
    expect(await decideAcceso(f, API, "t", "p1", "x1", true, "Aprobado")).toBe("aprobada");
    expect(await revealAccesoExcepcional(f, API, "t", "p1", "x1")).toMatchObject({ nombreCompleto: "Ana" });
    expect(calls.map(([m, p, b]) => [m, p, b])).toEqual([
      ["PUT", "configuracion", { dias: 14 }],
      ["POST", "avisos", { version: "v1", textoSimplificado: "x".repeat(25), finalidadesObligatorias: ["identificar"], finalidadesOpcionales: [] }],
      ["POST", "consentimientos/c1/revocar", { motivo: "El titular retira su consentimiento" }],
      ["POST", "arco", { derecho: "acceso", solicitante: "Juan", canal: "correo" }],
      ["POST", "arco/a1/avanzar", { estado: "procedente", nota: "Procede la solicitud del titular" }],
      ["POST", "arco/a1/prorroga", { motivo: "Se requiere recabar informacion" }],
      ["POST", "incidentes", { tipo: "divulgacion", severidad: "alta", titulo: "Correo equivocado", descripcion: "Se envio a otra persona.", riesgoSignificativo: true }],
      ["POST", "incidentes/n1/accion", { accion: "registrar_notificacion", canal: "correo", constancia: "0007" }],
      ["POST", "identidades/i1/retencion", { folio: "FGR-1", motivo: "Carpeta de investigacion abierta", autorizacion: "Direccion juridica" }],
      ["POST", "retenciones/h1/liberar", { nota: "Caso cerrado por la autoridad" }],
      ["POST", "identidades/i1/bloquear", { motivo: "Bloqueo preventivo del titular" }],
      ["POST", "identidades/i1/acceso-excepcional", { motivo: "Requerimiento de autoridad con oficio" }],
      ["POST", "accesos-excepcionales/x1/decidir", { aprobar: true, nota: "Aprobado" }],
      ["POST", "accesos-excepcionales/x1/revelar", {}],
    ]);
  });

  it("textoPlazo y etiquetaHoras: fase, dias restantes o vencimiento", () => {
    expect(textoPlazo({ fase: "respuesta", vence: "2026-03-21", diasRestantes: 5, estado: "por_vencer" })).toBe("Responder antes del 2026-03-21 (quedan 5 d)");
    expect(textoPlazo({ fase: "ejecucion", vence: "2026-04-05", diasRestantes: -2, estado: "vencida" })).toBe("Ejecutar antes del 2026-04-05: vencida hace 2 d");
    expect(textoPlazo({ fase: null, vence: null, diasRestantes: null, estado: "cerrada" })).toBe("Plazo cerrado");
    expect(etiquetaHoras(0)).toBe("menos de 1 h");
    expect(etiquetaHoras(5)).toBe("5 h");
    expect(etiquetaHoras(72)).toBe("3 días");
  });
});
