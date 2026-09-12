import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { redactarUrlParaLog, validarTodasLasIps, SsrfError } from "./ssrf.ts";

/**
 * Fetcher SSRF-safe para URLs de feeds iCal — port literal de
 * rentas/packages/adapters/src/net/fetchSsrf.ts (repo origen, H-024/H-025). Orden de
 * controles, TODOS antes de abrir cualquier socket saliente:
 *   1. Esquema: solo `https:`. `http:` únicamente si `hostname === "simulador.local"`
 *      Y el llamador pasó `permitirHttpSimuladorLocal: true` explícitamente (nunca
 *      por defecto, nunca en producción).
 *   2. Rechazo de credenciales embebidas en la URL (`user:pass@host`).
 *   3. Resolución DNS previa (o `resolverPersonalizado` para simuladores/pruebas —
 *      evita depender de `/etc/hosts` real para `simulador.local`) y validación de
 *      TODAS las IPs devueltas contra la deny-list de `ssrf.ts`, salvo el caso
 *      explícito de `simulador.local` + flag de dev (loopback es legítimo ahí).
 *   4. La conexión TCP/TLS se PINEA a la IP ya validada (se pasa como `host`) para
 *      que un cambio de respuesta DNS entre la validación y la conexión (DNS
 *      rebinding) no pueda colar una IP distinta sin pasar de nuevo por el guard.
 *   5. Redirecciones: nunca automáticas; cada `Location` se revalida desde el paso 1,
 *      máximo `maxRedirects` saltos.
 *   6. Timeout total y límite duro de bytes de cuerpo.
 */

export interface OpcionesFetchIcs {
  url: string;
  etag?: string | null;
  ultimaModificacionHttp?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Nunca `true` por defecto ni fuera de entornos de desarrollo. El llamador
   * (adaptador/simulador) es responsable de solo pasarlo cuando el entorno lo
   * permite explícitamente. */
  permitirHttpSimuladorLocal?: boolean;
  /** Inyección de resolución DNS para simuladores/pruebas: evita depender de
   * `/etc/hosts` para que `simulador.local` resuelva a `127.0.0.1`. En producción
   * nunca se pasa — se usa `dns.lookup` real. */
  resolverPersonalizado?: (hostname: string) => Promise<string[]> | string[];
}

export interface ResultadoFetchIcs {
  status: number;
  cuerpo: string | null;
  etag: string | null;
  ultimaModificacionHttp: string | null;
  noModificado: boolean;
}

const OPCIONES_POR_DEFECTO = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
};

function esquemaPermitido(u: URL, permitirHttpSimuladorLocal: boolean): boolean {
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && u.hostname === "simulador.local" && permitirHttpSimuladorLocal) {
    return true;
  }
  return false;
}

async function resolverIps(hostname: string, resolverPersonalizado: OpcionesFetchIcs["resolverPersonalizado"]): Promise<string[]> {
  if (resolverPersonalizado) {
    return resolverPersonalizado(hostname);
  }
  const resultados = await dnsLookup(hostname, { all: true });
  return resultados.map((r) => r.address);
}

async function validarYResolverDestino(
  u: URL,
  opciones: Required<Pick<OpcionesFetchIcs, "permitirHttpSimuladorLocal">> & Pick<OpcionesFetchIcs, "resolverPersonalizado">,
): Promise<string> {
  if (!esquemaPermitido(u, opciones.permitirHttpSimuladorLocal)) {
    throw new SsrfError("esquema_no_permitido", `esquema "${u.protocol}" no permitido para ${redactarUrlParaLog(u.toString())}`);
  }
  if (u.username || u.password) {
    throw new SsrfError("credenciales_en_url", `la URL de feed no debe llevar credenciales embebidas (${redactarUrlParaLog(u.toString())})`);
  }

  const esSimuladorLocalDeDesarrollo = u.protocol === "http:" && u.hostname === "simulador.local" && opciones.permitirHttpSimuladorLocal;

  const ips = await resolverIps(u.hostname, opciones.resolverPersonalizado);
  if (ips.length === 0) {
    throw new SsrfError("resolucion_dns_vacia", `sin resolución DNS para "${u.hostname}"`);
  }

  if (!esSimuladorLocalDeDesarrollo) {
    const validacion = validarTodasLasIps(ips);
    if (!validacion.permitida) {
      throw new SsrfError("ip_bloqueada", `IP resuelta para "${u.hostname}" rechazada (${validacion.motivo}): destino privado/loopback/metadata no permitido`);
    }
  }

  return ips[0]!;
}

function realizarPeticionPineada(u: URL, ipPineada: string, cabeceras: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; cuerpo: string }> {
  return new Promise((resolve, reject) => {
    // Exceder `maxBytes` liquida la promesa DIRECTAMENTE (sin depender de que un
    // evento de error se propague) apenas se detecta el exceso, y un guard
    // `liquidado` asegura que solo la primera resolución/rechazo cuenta — cualquier
    // evento posterior se ignora en vez de escapar como excepción no controlada.
    let liquidado = false;
    const resolverUnaVez = (valor: { status: number; headers: http.IncomingHttpHeaders; cuerpo: string }) => {
      if (liquidado) return;
      liquidado = true;
      clearTimeout(temporizadorTotal);
      resolve(valor);
    };
    const rechazarUnaVez = (error: Error) => {
      if (liquidado) return;
      liquidado = true;
      clearTimeout(temporizadorTotal);
      reject(error);
    };

    // `http.request({ timeout })` (más abajo, pasado como opción `timeout: timeoutMs`)
    // es un timeout de INACTIVIDAD del socket — se resetea con cada byte recibido, no
    // es un límite de duración TOTAL. Este temporizador SÍ es de duración total:
    // dispara a los `timeoutMs` exactos desde que se emite la petición, sin importar
    // cuánta actividad haya en el socket. Se conserva además la opción `timeout` de
    // `http.request` como defensa adicional contra un socket COMPLETAMENTE inactivo
    // (cero bytes) — cualquiera de los dos que dispare primero liquida la promesa.
    const temporizadorTotal = setTimeout(() => {
      rechazarUnaVez(new Error(`timeout total de ${timeoutMs}ms excedido al obtener el feed iCal`));
      req.destroy();
    }, timeoutMs);

    const cliente = u.protocol === "https:" ? https : http;
    const req = cliente.request(
      {
        host: ipPineada,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { ...cabeceras, Host: u.host },
        // TLS: valida el certificado contra el hostname original, no la IP.
        servername: u.protocol === "https:" ? u.hostname : undefined,
        timeout: timeoutMs,
      } as https.RequestOptions,
      (res) => {
        let recibidos = 0;
        const trozos: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (liquidado) return; // ya liquidada — ignorar datos tardíos del socket
          recibidos += chunk.length;
          if (recibidos > maxBytes) {
            rechazarUnaVez(new Error(`cuerpo excede el límite de ${maxBytes} bytes`));
            req.destroy();
            res.destroy();
            return;
          }
          trozos.push(chunk);
        });
        res.on("end", () => {
          resolverUnaVez({ status: res.statusCode ?? 0, headers: res.headers, cuerpo: Buffer.concat(trozos).toString("utf8") });
        });
        res.on("error", (err) => rechazarUnaVez(err instanceof Error ? err : new Error(String(err))));
      },
    );
    req.on("timeout", () => {
      rechazarUnaVez(new Error("timeout de fetch de feed iCal"));
      req.destroy();
    });
    req.on("error", (err) => rechazarUnaVez(err instanceof Error ? err : new Error(String(err))));
    req.end();
  });
}

export async function fetchIcsSeguro(opciones: OpcionesFetchIcs): Promise<ResultadoFetchIcs> {
  const timeoutMs = opciones.timeoutMs ?? OPCIONES_POR_DEFECTO.timeoutMs;
  const maxBytes = opciones.maxBytes ?? OPCIONES_POR_DEFECTO.maxBytes;
  const maxRedirects = opciones.maxRedirects ?? OPCIONES_POR_DEFECTO.maxRedirects;
  const permitirHttpSimuladorLocal = opciones.permitirHttpSimuladorLocal ?? false;

  let urlActual = new URL(opciones.url);
  let saltos = 0;

  for (;;) {
    const ipPineada = await validarYResolverDestino(urlActual, { permitirHttpSimuladorLocal, resolverPersonalizado: opciones.resolverPersonalizado });

    const cabeceras: Record<string, string> = {};
    if (opciones.etag) cabeceras["If-None-Match"] = opciones.etag;
    if (opciones.ultimaModificacionHttp) cabeceras["If-Modified-Since"] = opciones.ultimaModificacionHttp;

    const respuesta = await realizarPeticionPineada(urlActual, ipPineada, cabeceras, timeoutMs, maxBytes);

    if (respuesta.status >= 300 && respuesta.status < 400 && respuesta.headers.location) {
      saltos++;
      if (saltos > maxRedirects) {
        throw new SsrfError("demasiadas_redirecciones", `más de ${maxRedirects} redirecciones siguiendo ${redactarUrlParaLog(opciones.url)}`);
      }
      urlActual = new URL(respuesta.headers.location, urlActual);
      continue;
    }

    if (respuesta.status === 304) {
      return {
        status: 304,
        cuerpo: null,
        etag: (respuesta.headers.etag as string) ?? opciones.etag ?? null,
        ultimaModificacionHttp: (respuesta.headers["last-modified"] as string) ?? opciones.ultimaModificacionHttp ?? null,
        noModificado: true,
      };
    }

    return {
      status: respuesta.status,
      cuerpo: respuesta.cuerpo,
      etag: (respuesta.headers.etag as string) ?? null,
      ultimaModificacionHttp: (respuesta.headers["last-modified"] as string) ?? null,
      noModificado: false,
    };
  }
}

export { SsrfError, validarIpPermitida, validarTodasLasIps, redactarUrlParaLog } from "./ssrf.ts";
export type { MotivoRechazoSsrf, ResultadoValidacionIp } from "./ssrf.ts";
