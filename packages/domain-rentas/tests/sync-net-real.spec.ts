// Prueba de integración del camino de red REAL: `RealIcalFeedPort` (SSRF-safe,
// packages/domain-rentas/src/sync/net/fetch-ics-seguro.ts) contra un `http.Server`
// real en loopback (IcalFeedHttpSimulator, port de rentas/packages/sim/src/comun/
// servidorIcal.ts del repo original) — no un mock de `fetch`: un servidor real que
// responde 200/304/503 según el escenario configurado.
import { afterEach, describe, expect, it } from "vitest";
import { RealIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import { SsrfError } from "../src/sync/net/ssrf.ts";
import { fetchIcsSeguro } from "../src/sync/net/fetch-ics-seguro.ts";
import { IcalFeedHttpSimulator } from "./helpers/ical-feed-http-simulator.ts";

describe("RealIcalFeedPort contra un servidor HTTP real (simulador de canal)", () => {
  let simulador: IcalFeedHttpSimulator | null = null;

  afterEach(async () => {
    if (simulador) await simulador.detener();
    simulador = null;
  });

  it("obtiene el contenido .ics real de un servidor HTTP y lo cachea por ETag (304 en la segunda corrida)", async () => {
    simulador = new IcalFeedHttpSimulator();
    const { url } = await simulador.iniciar();
    const icsReal = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:real-1@simulador.local\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nDTEND;VALUE=DATE:20260605\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    simulador.definirEscenario({ tipo: "ics", contenidoIcs: icsReal });

    const port = new RealIcalFeedPort();
    const r1 = await port.fetchFeed({ url, etag: null, ultimaModificacionHttp: null, permitirHttpSimuladorLocal: true, resolverPersonalizado: simulador.resolverPersonalizado });
    expect(r1.status).toBe(200);
    expect(r1.cuerpo).toBe(icsReal);
    expect(r1.etag).toBeTruthy();

    const r2 = await port.fetchFeed({ url, etag: r1.etag, ultimaModificacionHttp: r1.ultimaModificacionHttp, permitirHttpSimuladorLocal: true, resolverPersonalizado: simulador.resolverPersonalizado });
    expect(r2.noModificado).toBe(true);
    expect(r2.status).toBe(304);
    expect(r2.cuerpo).toBeNull();
    expect(simulador.numeroDeLlamadas).toBe(2);
  });

  it("un feed inaccesible (503 real) se refleja en el status, nunca como cuerpo vacío silencioso", async () => {
    simulador = new IcalFeedHttpSimulator();
    const { url } = await simulador.iniciar();
    simulador.definirEscenario({ tipo: "inaccesible", statusHttp: 503 });

    const port = new RealIcalFeedPort();
    const r = await port.fetchFeed({ url, etag: null, ultimaModificacionHttp: null, permitirHttpSimuladorLocal: true, resolverPersonalizado: simulador.resolverPersonalizado });
    expect(r.status).toBe(503);
  });

  it("rechaza http:// contra un host que no es simulador.local, sin abrir ningún socket", async () => {
    await expect(fetchIcsSeguro({ url: "http://canal-externo-real.example.com/feed.ics", etag: null, ultimaModificacionHttp: null })).rejects.toThrow(SsrfError);
  });

  it("rechaza credenciales embebidas en la URL antes de resolver DNS", async () => {
    await expect(fetchIcsSeguro({ url: "https://user:pass@canal.example.com/feed.ics", etag: null, ultimaModificacionHttp: null, resolverPersonalizado: () => ["93.184.216.34"] })).rejects.toThrow(SsrfError);
  });

  it("rechaza una IP privada/loopback resuelta vía DNS (protección SSRF real, no solo por nombre de host)", async () => {
    await expect(
      fetchIcsSeguro({ url: "https://canal-que-resuelve-a-metadata.example.com/feed.ics", etag: null, ultimaModificacionHttp: null, resolverPersonalizado: () => ["169.254.169.254"] }),
    ).rejects.toThrow(SsrfError);
  });
});
