// Simulador HTTP real de un feed iCal de canal — port de
// rentas/packages/sim/src/comun/servidorIcal.ts (repo origen), usado SOLO en pruebas
// de integración de este paquete (ver tests/sync-net-real.spec.ts) para probar el
// camino REAL de red de `RealIcalFeedPort` (SSRF-safe fetch, caché HTTP condicional
// por ETag) contra un `http.Server` real en loopback — no un mock de `fetch`, un
// servidor real. Vive en tests/ (no en src/) a propósito: no es un adaptador de
// producción, solo un doble de canal externo para pruebas.
import { createHash } from "node:crypto";
import * as http from "node:http";

export type EscenarioIcalSimulado = { tipo: "vacio" } | { tipo: "malformado" } | { tipo: "inaccesible"; statusHttp?: number } | { tipo: "ics"; contenidoIcs: string };

function etagDe(contenido: string): string {
  return `"${createHash("sha256").update(contenido).digest("hex").slice(0, 16)}"`;
}

const FEED_VACIO_VALIDO = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SIMULADOR//EN\r\nEND:VCALENDAR\r\n";
const FEED_MALFORMADO = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:malformado@simulador.local\r\n"; // sin END, deliberado

/** Un `http.Server` real escuchando en `127.0.0.1` (puerto aleatorio) que expone un
 * único endpoint `GET /feed.ics`, cuyo contenido depende del escenario configurado por
 * la prueba. El host lógico que se usa en las URLs generadas es SIEMPRE
 * `simulador.local` — el llamador debe pasar `resolverPersonalizado` (que este módulo
 * expone) a `fetchIcsSeguro`/`RealIcalFeedPort` para que esa URL resuelva a
 * `127.0.0.1` sin tocar `/etc/hosts` ni DNS real. NUNCA representa una conexión
 * productiva. */
export class IcalFeedHttpSimulator {
  private escenario: EscenarioIcalSimulado = { tipo: "vacio" };
  private servidor: http.Server;
  private puerto = 0;
  private llamadasRecibidas = 0;

  constructor() {
    this.servidor = http.createServer((req, res) => this.manejarPeticion(req, res));
  }

  private manejarPeticion(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.llamadasRecibidas++;

    if (this.escenario.tipo === "inaccesible") {
      res.writeHead(this.escenario.statusHttp ?? 503, { "Content-Type": "text/plain" });
      res.end("SIMULADOR: feed marcado como inaccesible para esta prueba");
      return;
    }

    const contenido = this.escenario.tipo === "vacio" ? FEED_VACIO_VALIDO : this.escenario.tipo === "malformado" ? FEED_MALFORMADO : this.escenario.contenidoIcs;

    const etag = etagDe(contenido);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", ETag: etag, "Last-Modified": new Date().toUTCString() });
    res.end(contenido);
  }

  definirEscenario(escenario: EscenarioIcalSimulado): void {
    this.escenario = escenario;
  }

  async iniciar(): Promise<{ puerto: number; url: string }> {
    await new Promise<void>((resolve) => this.servidor.listen(0, "127.0.0.1", resolve));
    const direccion = this.servidor.address();
    if (!direccion || typeof direccion === "string") {
      throw new Error("no se pudo determinar el puerto del simulador");
    }
    this.puerto = direccion.port;
    return { puerto: this.puerto, url: `http://simulador.local:${this.puerto}/feed.ics` };
  }

  /** Para pasar como `resolverPersonalizado`: `simulador.local` resuelve SIEMPRE a
   * `127.0.0.1`, sin depender de DNS real ni de `/etc/hosts`. */
  resolverPersonalizado = (hostname: string): string[] => {
    if (hostname !== "simulador.local") {
      throw new Error(`IcalFeedHttpSimulator solo resuelve "simulador.local", recibido "${hostname}"`);
    }
    return ["127.0.0.1"];
  };

  get numeroDeLlamadas(): number {
    return this.llamadasRecibidas;
  }

  async detener(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.servidor.close((error) => (error ? reject(error) : resolve())));
  }
}
