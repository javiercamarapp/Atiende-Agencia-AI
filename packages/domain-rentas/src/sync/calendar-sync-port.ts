// Puerto de sincronización de calendario por canal — mismo espíritu que
// `GoogleCalendarPort`/`ResolveCalendarPort` de @atiende/domain-citas
// (google-calendar-port.ts, calendar-sync.ts): el motor de sincronización
// (./motor.ts) nunca importa `RealIcalFeedPort`/`FakeIcalFeedPort` directamente, solo
// el contrato `CalendarSyncPort` — así un caller de producción y una prueba local
// corren exactamente el mismo código de orquestación.
//
// A diferencia de Google Calendar (una API REST autenticada por proveedor), un feed
// iCal de canal (Airbnb/Booking/VRBO/...) es una URL PÚBLICA sin autenticación — el
// contrato tiene un único método (`fetchFeed`) que fusiona fetch SSRF-safe + caché
// HTTP condicional (ETag/If-Modified-Since). La segunda mitad del ciclo de vida
// (parsear el `.ics` recibido y decidir qué aplicar) es SIEMPRE la misma lógica pura
// de ../ical/parser.ts + ./resolucion-version.ts, nunca parte del puerto — ver
// ./motor.ts.
//
// Dos implementaciones, mismo patrón dual que el resto del repo:
//  - RealIcalFeedPort: red real, SSRF-safe (./net/fetch-ics-seguro.ts) — código de
//    producción real, no un stub: no requiere credenciales de ninguna plataforma (un
//    feed iCal es información de disponibilidad pública), a diferencia de
//    RealGoogleCalendarPort que sí depende de OAuth por proveedor.
//  - FakeIcalFeedPort: respuestas fijadas en memoria, sin red — para tests
//    deterministas del motor de sincronización.
import { createHash } from "node:crypto";
import { fetchIcsSeguro } from "./net/fetch-ics-seguro.ts";

export interface FetchFeedInput {
  readonly url: string;
  readonly etag: string | null;
  readonly ultimaModificacionHttp: string | null;
  /** Solo para pruebas/simuladores — ver RealIcalFeedPort. Nunca se pasa en
   * producción. */
  readonly permitirHttpSimuladorLocal?: boolean;
  readonly resolverPersonalizado?: (hostname: string) => Promise<string[]> | string[];
}

export interface FetchFeedResult {
  readonly status: number;
  readonly cuerpo: string | null;
  readonly etag: string | null;
  readonly ultimaModificacionHttp: string | null;
  readonly noModificado: boolean;
}

export interface CalendarSyncPort {
  /** Obtiene el contenido crudo (texto `.ics`) de un feed externo, o `noModificado:
   * true` si el canal respondió 304 contra el `etag`/`ultimaModificacionHttp`
   * provistos. Nunca lanza por un fallo de red/DNS/SSRF/timeout — los traduce a un
   * resultado con `status` fuera de 2xx/304 cuando es posible, o rechaza la promesa
   * para que `./motor.ts` lo trate uniformemente como "fallo_red" (ver
   * ejecutarCicloImportacion). */
  fetchFeed(input: FetchFeedInput): Promise<FetchFeedResult>;
}

/**
 * Implementación real: red SSRF-safe. No necesita credenciales de plataforma — un
 * feed iCal de canal es una URL pública, sin autenticación (así es como
 * Airbnb/Booking/VRBO exponen su calendario de disponibilidad hoy en la práctica).
 */
export class RealIcalFeedPort implements CalendarSyncPort {
  async fetchFeed(input: FetchFeedInput): Promise<FetchFeedResult> {
    return fetchIcsSeguro({
      url: input.url,
      etag: input.etag,
      ultimaModificacionHttp: input.ultimaModificacionHttp,
      permitirHttpSimuladorLocal: input.permitirHttpSimuladorLocal,
      resolverPersonalizado: input.resolverPersonalizado,
    });
  }
}

interface EscenarioFake {
  tipo: "ics" | "vacio" | "malformado" | "inaccesible" | "no_modificado";
  contenidoIcs?: string;
  statusHttp?: number;
  etag?: string;
}

/**
 * Adaptador simulado/capturador: nunca toca la red. Guarda el escenario configurado
 * por URL, para que las pruebas del motor de sincronización verifiquen el
 * comportamiento completo (cuarentena, anti-eco, reconciliación) sin depender de un
 * servidor HTTP real — mismo patrón que `FakeGoogleCalendarPort` de domain-citas.
 */
export class FakeIcalFeedPort implements CalendarSyncPort {
  private escenarios = new Map<string, EscenarioFake>();
  /** Historial de llamadas, para aserciones de "se llamó exactamente así" (p. ej. que
   * el ETag de la corrida anterior sí se reenvía). */
  calls: FetchFeedInput[] = [];
  /** Fuerza que la siguiente llamada rechace la promesa (simula un timeout/DNS
   * roto), para probar el camino de "fallo_red" sin pasar por `statusHttp`. */
  failNextCall: Error | null = null;

  definirEscenario(url: string, escenario: EscenarioFake): void {
    this.escenarios.set(url, escenario);
  }

  async fetchFeed(input: FetchFeedInput): Promise<FetchFeedResult> {
    this.calls.push(input);
    if (this.failNextCall) {
      const err = this.failNextCall;
      this.failNextCall = null;
      throw err;
    }

    const escenario = this.escenarios.get(input.url);
    if (!escenario) {
      return { status: 404, cuerpo: null, etag: null, ultimaModificacionHttp: null, noModificado: false };
    }

    if (escenario.tipo === "inaccesible") {
      return { status: escenario.statusHttp ?? 503, cuerpo: "simulador: feed marcado como inaccesible para esta prueba", etag: null, ultimaModificacionHttp: null, noModificado: false };
    }
    if (escenario.tipo === "no_modificado") {
      return { status: 304, cuerpo: null, etag: escenario.etag ?? input.etag ?? null, ultimaModificacionHttp: input.ultimaModificacionHttp, noModificado: true };
    }

    const contenido = escenario.tipo === "vacio" ? "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FAKE//EN\r\nEND:VCALENDAR\r\n" : escenario.tipo === "malformado" ? "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:malformado@fake.local\r\n" : (escenario.contenidoIcs ?? "");

    // Hash real del contenido, no la longitud: dos feeds distintos pueden coincidir
    // en longitud por casualidad (p. ej. cambiar SEQUENCE de un dígito y DTEND por
    // otra fecha de igual longitud) — un ETag por longitud colisionaría y el motor
    // trataría un cambio real como "no_modificado" (304), un bug de la fixture, no
    // del motor real.
    const etag = escenario.etag ?? `"fake-${createHash("sha256").update(contenido).digest("hex").slice(0, 16)}"`;
    if (input.etag && input.etag === etag) {
      return { status: 304, cuerpo: null, etag, ultimaModificacionHttp: input.ultimaModificacionHttp, noModificado: true };
    }
    return { status: 200, cuerpo: contenido, etag, ultimaModificacionHttp: new Date().toUTCString(), noModificado: false };
  }
}
