// Servidor HTTP de API simulada (solo Node, sin dependencias). Sirve fixtures realistas por vertical,
// aisla el estado por "escenario" (una prueba = un escenario, asi corren en paralelo sin pisarse),
// registra cada peticion y permite inyectar fallas 4xx/5xx y latencia.
//
// Aislamiento: el codigo de login (`/auth/exchange-code`) lleva el escenario ("<escenario>~<persona>") y los
// tokens que emite lo repiten ("mock.<escenario>.<persona>.<n>"), de modo que toda peticion autenticada se
// atribuye a su escenario sin cabeceras especiales (refresh/logout, que llevan el refreshToken en el cuerpo, tambien).
// Las peticiones sin sesion (login, magic link) caen en el escenario "anon".
//
// Canal de control (solo 127.0.0.1): GET /__mock/salud, GET|DELETE /__mock/escenarios/:id/peticiones,
// POST /__mock/escenarios/:id/config ({ latenciaMs, fallas }), POST /__mock/escenarios/:id/reiniciar.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { esRespuestaMarcada, fallo } from "./respuestas.ts";
import { leerToken } from "./tokens.ts";
import { rutasAuth } from "./fixtures/auth.ts";
import { agregarNotificacion } from "./fixtures/comun.ts";
import { todasLasRutas } from "./fixtures/indice.ts";
import type { EstadoEscenario, Falla, RegistroPeticion, Ruta } from "./tipos.ts";

const ANON = "anon";
const MAX_REGISTROS = 5000;

interface Escenario {
  readonly id: string;
  latenciaMs: number;
  fallas: Array<Falla & { restantes: number }>;
  readonly registros: RegistroPeticion[];
  readonly datos: Map<string, unknown>;
  seq: number;
}

interface RutaCompilada {
  readonly ruta: Ruta;
  readonly segmentos: readonly string[];
}

function compilar(ruta: Ruta): RutaCompilada {
  return { ruta, segmentos: ruta.patron.split("/").filter(Boolean) };
}

function casar(compilada: RutaCompilada, segmentos: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  const pat = compilada.segmentos;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "*") {
      params["*"] = segmentos.slice(i).join("/");
      return params;
    }
    const s = segmentos[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return pat.length === segmentos.length ? params : null;
}

function coincideRuta(patron: string, ruta: string): boolean {
  if (patron.length > 2 && patron.startsWith("/") && patron.endsWith("/")) {
    try {
      return new RegExp(patron.slice(1, -1)).test(ruta);
    } catch {
      return false;
    }
  }
  return ruta.includes(patron);
}

function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolver) => {
    const trozos: Buffer[] = [];
    req.on("data", (t: Buffer) => trozos.push(t));
    req.on("end", () => {
      const texto = Buffer.concat(trozos).toString("utf8");
      if (!texto) return resolver(undefined);
      try {
        resolver(JSON.parse(texto));
      } catch {
        resolver(texto);
      }
    });
    req.on("error", () => resolver(undefined));
  });
}

function dormir(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export interface OpcionesServidor {
  readonly puerto: number;
  readonly host?: string;
  /** Latencia base (ms) de todos los escenarios; cada escenario puede sobreescribirla. */
  readonly latenciaMs?: number;
  readonly silencioso?: boolean;
}

export interface ServidorSimulado {
  readonly url: string;
  cerrar(): Promise<void>;
}

export function iniciarServidor(opciones: OpcionesServidor): Promise<ServidorSimulado> {
  const host = opciones.host ?? "127.0.0.1";
  const escenarios = new Map<string, Escenario>();
  const rutas = [...rutasAuth, ...todasLasRutas].map(compilar);

  function escenario(id: string): Escenario {
    let e = escenarios.get(id);
    if (!e) {
      e = { id, latenciaMs: opciones.latenciaMs ?? 0, fallas: [], registros: [], datos: new Map(), seq: 0 };
      escenarios.set(id, e);
    }
    return e;
  }

  function estadoDe(e: Escenario): EstadoEscenario {
    return {
      obtener<T>(clave: string, semilla: () => T): T {
        if (!e.datos.has(clave)) e.datos.set(clave, semilla());
        return e.datos.get(clave) as T;
      },
      guardar(clave, valor) {
        e.datos.set(clave, valor);
      },
    };
  }

  function cabecerasCors(origen: string | undefined): Record<string, string> {
    return {
      "access-control-allow-origin": origen ?? "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,idempotency-key,x-requested-with,x-step-up-token",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  function enviar(res: ServerResponse, status: number, cuerpo: unknown, origen: string | undefined): void {
    const texto = cuerpo === undefined ? "" : JSON.stringify(cuerpo);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cabecerasCors(origen) });
    res.end(texto);
  }

  function enviarCrudo(res: ServerResponse, status: number, tipo: string, texto: string, origen: string | undefined): void {
    res.writeHead(status, { "content-type": tipo, "cache-control": "no-store", ...cabecerasCors(origen) });
    res.end(texto);
  }

  async function control(req: IncomingMessage, res: ServerResponse, ruta: string, origen: string | undefined): Promise<void> {
    const metodo = req.method ?? "GET";
    if (ruta === "/__mock/salud") return enviar(res, 200, { ok: true, escenarios: escenarios.size }, origen);
    const m = /^\/__mock\/escenarios\/([^/]+)\/(peticiones|config|reiniciar|notificaciones|estado)$/.exec(ruta);
    if (!m) return enviar(res, 404, { message: "control desconocido" }, origen);
    const e = escenario(decodeURIComponent(m[1]!));
    if (m[2] === "peticiones") {
      if (metodo === "DELETE") {
        e.registros.length = 0;
        return enviar(res, 200, { ok: true }, origen);
      }
      return enviar(res, 200, { peticiones: e.registros }, origen);
    }
    if (m[2] === "reiniciar") {
      escenarios.delete(e.id);
      return enviar(res, 200, { ok: true }, origen);
    }
    if (m[2] === "notificaciones") {
      // Solo del mock: simula que un evento del ciclo emitio una notificacion nueva (sin leer) para esta sesion.
      const nueva = ((await leerCuerpo(req)) ?? {}) as { titulo?: unknown; severidad?: unknown; categoria?: unknown; enlace?: unknown };
      if (typeof nueva.titulo !== "string" || nueva.titulo === "") return enviar(res, 400, { message: "titulo requerido" }, origen);
      const severidad = nueva.severidad === "critica" || nueva.severidad === "info" ? nueva.severidad : "atencion";
      const fila = agregarNotificacion(estadoDe(e), {
        titulo: nueva.titulo,
        severidad,
        ...(typeof nueva.categoria === "string" ? { categoria: nueva.categoria } : {}),
        ...(typeof nueva.enlace === "string" ? { enlace: nueva.enlace } : {}),
      });
      return enviar(res, 200, { ok: true, id: fila.id }, origen);
    }
    if (m[2] === "estado") {
      // Solo del mock: agrega un elemento a una lista del estado del escenario (p. ej. un pedido nuevo que llega mientras la
      // prueba mira el panel: en produccion lo crea WhatsApp o la llamada, aqui no hay quien lo origine).
      const dato = ((await leerCuerpo(req)) ?? {}) as { clave?: unknown; agregar?: unknown };
      if (typeof dato.clave !== "string" || dato.clave === "" || dato.agregar === undefined) return enviar(res, 400, { message: "clave y agregar requeridos" }, origen);
      const lista = e.datos.get(dato.clave) as unknown[] | undefined;
      if (!Array.isArray(lista)) return enviar(res, 409, { message: "la lista aun no existe: la pantalla debe cargarla primero" }, origen);
      lista.push(dato.agregar);
      return enviar(res, 200, { ok: true, total: lista.length }, origen);
    }
    const cuerpo = ((await leerCuerpo(req)) ?? {}) as { latenciaMs?: number; fallas?: Falla[]; agregarFallas?: Falla[] };
    if (typeof cuerpo.latenciaMs === "number") e.latenciaMs = Math.max(0, cuerpo.latenciaMs);
    if (Array.isArray(cuerpo.fallas)) e.fallas = cuerpo.fallas.map((f) => ({ ...f, restantes: f.veces ?? 0 }));
    if (Array.isArray(cuerpo.agregarFallas)) e.fallas.push(...cuerpo.agregarFallas.map((f) => ({ ...f, restantes: f.veces ?? 0 })));
    return enviar(res, 200, { ok: true, latenciaMs: e.latenciaMs, fallas: e.fallas.length }, origen);
  }

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origen = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const metodo = (req.method ?? "GET").toUpperCase();
    if (metodo === "OPTIONS") {
      res.writeHead(204, cabecerasCors(origen));
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://mock.local");
    const ruta = url.pathname;
    if (ruta.startsWith("/__mock/")) return control(req, res, ruta, origen);

    const cuerpo = await leerCuerpo(req);
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const sesion = token ? leerToken(token) : null;
    // Las rutas publicas con sesion en el cuerpo (refresh, logout) se atribuyen al escenario de su refreshToken.
    const refresco = (cuerpo as { refreshToken?: unknown } | undefined)?.refreshToken;
    const escenarioId = sesion?.escenario ?? (typeof refresco === "string" ? leerToken(refresco)?.escenario : undefined) ?? ANON;
    const e = escenario(escenarioId);
    const persona = sesion?.persona ?? null;

    const registrar = (status: number, extra: { sinFixture?: boolean; inyectada?: boolean }): void => {
      e.registros.push({
        seq: ++e.seq,
        ts: Date.now(),
        metodo,
        ruta: url.pathname + url.search,
        cuerpo,
        persona: persona?.id ?? null,
        status,
        sinFixture: extra.sinFixture ?? false,
        inyectada: extra.inyectada ?? false,
      });
      if (e.registros.length > MAX_REGISTROS) e.registros.splice(0, e.registros.length - MAX_REGISTROS);
    };

    // Fallas inyectadas: se evaluan primero (incluso antes de la latencia base si traen su propio retraso).
    const idx = e.fallas.findIndex((f) => (!f.metodo || f.metodo.toUpperCase() === metodo) && coincideRuta(f.ruta, url.pathname + url.search) && (f.veces === undefined || f.veces === 0 || f.restantes > 0));
    if (idx >= 0) {
      const f = e.fallas[idx]!;
      if (f.veces && f.veces > 0) {
        f.restantes -= 1;
        if (f.restantes <= 0) e.fallas.splice(idx, 1);
      }
      await dormir(f.retrasoMs ?? e.latenciaMs);
      registrar(f.status, { inyectada: true });
      return enviar(res, f.status, f.cuerpo ?? { message: `Falla inyectada ${f.status}` }, origen);
    }

    await dormir(e.latenciaMs);
    const segmentos = ruta.split("/").filter(Boolean);
    for (const c of rutas) {
      if (c.ruta.metodo !== metodo) continue;
      const params = casar(c, segmentos);
      if (!params) continue;
      if (!c.ruta.publica && !persona) {
        registrar(401, {});
        return enviar(res, 401, { message: "Sesion requerida" }, origen);
      }
      if (c.ruta.roles && persona && !c.ruta.roles.includes(persona.rol)) {
        registrar(403, {});
        return enviar(res, 403, { message: "Tu rol no permite esta accion" }, origen);
      }
      try {
        const salida = await c.ruta.manejador({ metodo, ruta, query: url.searchParams, cuerpo, params, persona, cabeceras: req.headers, estado: estadoDe(e) });
        if (esRespuestaMarcada(salida)) {
          registrar(salida.status, {});
          if (salida.crudo) return enviarCrudo(res, salida.status, salida.crudo.tipo, salida.crudo.texto, origen);
          return enviar(res, salida.status, salida.cuerpo, origen);
        }
        registrar(200, {});
        return enviar(res, 200, salida, origen);
      } catch (err) {
        // Un error en una fixture es un bug de la fixture, no del producto: 500 explicito y visible en el registro.
        registrar(500, {});
        const m = fallo(500, `mock-api: error en la fixture (${err instanceof Error ? err.message : String(err)})`);
        return enviar(res, m.status, m.cuerpo, origen);
      }
    }
    registrar(404, { sinFixture: true });
    return enviar(res, 404, { message: `mock-api: sin fixture para ${metodo} ${ruta}`, code: "mock_sin_fixture" }, origen);
  }

  const servidor: Server = createServer((req, res) => {
    atender(req, res).catch((err: unknown) => {
      if (!opciones.silencioso) console.error("[mock-api] error no controlado", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(opciones.puerto, host, () => {
      const dir = servidor.address();
      const puerto = typeof dir === "object" && dir ? dir.port : opciones.puerto;
      resolver({
        url: `http://${host}:${puerto}`,
        cerrar: () => new Promise((r) => servidor.close(() => r())),
      });
    });
  });
}
