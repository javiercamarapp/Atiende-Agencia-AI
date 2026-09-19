// Hallazgo de auditoría (ALTO, SSRF real y explotable) — el endpoint de conexión
// CalDAV (apps/api/.../citas/calendar-providers.ts) solo validaba que la URL
// empezara con "https://", un chequeo de STRING que no impide que un staff
// autenticado guarde una URL cuyo host apunte a infraestructura interna
// (localhost, 127.0.0.1, 169.254.169.254 -- metadata de nube --, RFC1918, sus
// equivalentes IPv6). Esa URL queda guardada y es la que `RealCalDavPort`
// (../caldav-port.ts) usa después para emitir peticiones HTTP reales.
//
// La validación de abajo resuelve el hostname por DNS (nunca confía solo en el
// string) y valida TODAS las IPs devueltas contra la deny-list real de
// `./ssrf.ts` -- mismo criterio ya establecido para feeds iCal de rentas
// (packages/domain-rentas/src/sync/net/fetch-ics-seguro.ts). Esto cierra
// también el vector de DNS rebinding "literal por nombre": un hostname que no
// tiene pinta de privado (no es "localhost" ni una IP literal) pero que SÍ
// resuelve a una IP privada/loopback/metadata queda igual de rechazado, porque
// lo que se valida es la IP resuelta, no el texto del hostname.
//
// Lo que esto NO cubre (documentado, no una laguna oculta): una vez conectada
// una URL pública legítima, `RealCalDavPort` usa `fetch` global directo para las
// peticiones REALES de sincronización (crear/actualizar/cancelar cita, poll de
// cambios) sin re-resolver y pinear la IP en cada petición -- a diferencia del
// fetcher de feeds iCal de rentas, que sí pinea la conexión TCP a la IP ya
// validada. Si el DNS del proveedor cambiara DESPUÉS de conectar (rebinding
// tardío, no en el momento de conectar), esas peticiones futuras no vuelven a
// pasar por este guard. Cerrar ese vector residual requiere portar el mismo
// patrón de "resolver+pinear" a `caldav-port.ts` (que soporta GET/PUT/DELETE/
// REPORT con cuerpo, a diferencia del fetcher de iCal que solo hace GET) -- fuera
// del alcance de este cambio, que cierra el hallazgo reportado: bloquear que la
// URL se guarde en primer lugar.

import { lookup as dnsLookupReal } from "node:dns/promises";
import { validarTodasLasIps, type ResultadoValidacionIp } from "./ssrf.ts";

export type MotivoRechazoUrlCaldav = "url_invalida" | "esquema_no_permitido" | "credenciales_en_url" | "resolucion_dns_vacia" | "ip_bloqueada";

export interface ResultadoValidacionUrlCaldav {
  readonly permitida: boolean;
  readonly motivo?: string;
  readonly codigo?: MotivoRechazoUrlCaldav;
}

/** Resuelve un hostname a todas sus IPs (v4 e IPv6). Inyectable para pruebas: en
 * producción es `dns.lookup(hostname, { all: true })` real (que, para un
 * hostname que YA es una IP literal, la devuelve directo sin tocar la red -- ver
 * documentación de Node -- así que las pruebas de IPs literales bloqueadas no
 * necesitan red). Para simular DNS rebinding (un hostname que no parece privado
 * pero SÍ resuelve a una IP privada) las pruebas pasan un resolver falso. */
export type ResolverDns = (hostname: string) => Promise<readonly string[]> | readonly string[];

async function resolverIpsReal(hostname: string): Promise<string[]> {
  const resultados = await dnsLookupReal(hostname, { all: true });
  return resultados.map((r) => r.address);
}

/** Construye el validador de URL de colección CalDAV que se guarda al conectar
 * un proveedor. Devuelve una función `(url: string) => Promise<ResultadoValidacionUrlCaldav>`
 * -- inyectada en `AppDeps` (ver apps/api/src/deps.ts::citasCaldavUrlValidator)
 * igual que `rentasIcalFeedPort`/`citasGoogleTokenExchange`: producción usa
 * `crearValidadorUrlCaldav()` (DNS real); las pruebas pasan `resolverDns` para
 * fijar deterministamente qué IP "resuelve" cada hostname de prueba, sin
 * depender de la red ni de que un dominio público real siga resolviendo igual
 * mañana. */
export function crearValidadorUrlCaldav(opciones: { resolverDns?: ResolverDns } = {}): (url: string) => Promise<ResultadoValidacionUrlCaldav> {
  const resolverDns = opciones.resolverDns ?? resolverIpsReal;

  return async function validarUrlCaldav(url: string): Promise<ResultadoValidacionUrlCaldav> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { permitida: false, motivo: "URL malformada.", codigo: "url_invalida" };
    }

    if (parsed.protocol !== "https:") {
      return { permitida: false, motivo: "calendar_collection_url debe ser una URL https:// real de tu colección de calendario.", codigo: "esquema_no_permitido" };
    }
    if (parsed.username || parsed.password) {
      return { permitida: false, motivo: "calendar_collection_url no debe llevar credenciales embebidas (usuario:contraseña en la URL).", codigo: "credenciales_en_url" };
    }

    // `URL.hostname` de un literal IPv6 conserva los corchetes (`"[::1]"`) --
    // `dns.lookup`/`net.isIP` no los aceptan, así que se quitan solo para la
    // resolución; el hostname original (con corchetes) se usa igual en los
    // mensajes de error de arriba/abajo.
    const hostnameParaResolver = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;

    let ips: readonly string[];
    try {
      ips = await resolverDns(hostnameParaResolver);
    } catch {
      return { permitida: false, motivo: `no se pudo resolver "${parsed.hostname}" por DNS.`, codigo: "resolucion_dns_vacia" };
    }

    const validacion: ResultadoValidacionIp = validarTodasLasIps(ips);
    if (!validacion.permitida) {
      return {
        permitida: false,
        motivo: validacion.motivo === "resolución DNS sin resultados" ? `no se pudo resolver "${parsed.hostname}" por DNS.` : `"${parsed.hostname}" resuelve a una dirección bloqueada (${validacion.motivo}) -- no se permiten destinos internos/privados/metadata de nube.`,
        codigo: validacion.motivo === "resolución DNS sin resultados" ? "resolucion_dns_vacia" : "ip_bloqueada",
      };
    }

    return { permitida: true };
  };
}
