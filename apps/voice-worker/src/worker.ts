// Ciclo de vida del worker: estado honesto (/salud), recepcion de llamadas por el puerto de telefonia y apagado ordenado.
//   - Sin configuracion completa: arranca igual, registra los MOTIVOS (nombres de variables, nunca valores), responde 503 en /salud y NO escucha
//     llamadas. Nunca contesta a medias.
//   - Con configuracion: cada llamada se atiende en su propia promesa; un fallo en una llamada no tumba al worker ni a las demas.
//   - Apagado (SIGTERM): deja de recibir llamadas, da un plazo a las activas y despues las aborta (cuelga y cierra la conversacion como `abandonado`).
//     Si el proceso muere sin poder cerrar, el barrido de llamadas huerfanas de la API (cron de QA lote C) cierra la conversacion.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { atenderLlamada } from "./llamada.ts";
import type { DepsAtencion, ResumenAtencion } from "./llamada.ts";
import type { ConfigWorker } from "./config.ts";
import type { LlamadaTelefonica, TelefoniaPort } from "./telefonia/puerto.ts";

export interface EstadoSalud {
  readonly estado: "configurado" | "no_configurado";
  readonly motivos: readonly string[];
  readonly escuchando: boolean;
  readonly llamadasActivas: number;
  readonly llamadasAtendidas: number;
  /** Milisegundos desde el ultimo sondeo exitoso de la telefonia; null si la telefonia no sondea o aun no hubo uno. */
  readonly latidoHaceMs: number | null;
  /** `true` = puede atender: configurado, escuchando y con latido vigente. Es lo que decide el 200/503 de /salud. */
  readonly sano: boolean;
}

/** Tras cuanto tiempo sin sondeo exitoso de LiveKit /salud deja de ser sano (el sondeo es cada ~1 s). */
export const LATIDO_MAX_MS = 60_000;

export interface OpcionesWorker {
  readonly config: ConfigWorker;
  readonly telefonia: TelefoniaPort | null;
  /** Dependencias de cada llamada; null cuando el worker no esta configurado. */
  readonly deps: DepsAtencion | null;
  readonly log: (evento: string, campos?: Readonly<Record<string, string | number | boolean>>) => void;
}

export class Worker {
  private escuchando = false;
  private readonly activas = new Set<Promise<unknown>>();
  private readonly abortos = new Set<AbortController>();
  private atendidas = 0;
  /** Resumen de las ultimas llamadas atendidas (sin PII: resultado, costo, ids opacos y latencias); sirve a las pruebas y al diagnostico. */
  readonly resumenes: ResumenAtencion[] = [];

  constructor(private readonly o: OpcionesWorker) {}

  salud(ahora: number = Date.now()): EstadoSalud {
    const latido = this.o.telefonia?.latidoMs?.() ?? null;
    const latidoHaceMs = latido === null ? null : Math.max(0, ahora - latido);
    // Sin latido (telefonia que no sondea, o aun no hubo el primero) no se penaliza: `iniciar` ya espera el primer sondeo. Con latido, debe ser reciente.
    const latidoVigente = latidoHaceMs === null || latidoHaceMs <= LATIDO_MAX_MS;
    return {
      estado: this.o.config.estado,
      motivos: this.o.config.motivos,
      escuchando: this.escuchando,
      llamadasActivas: this.activas.size,
      llamadasAtendidas: this.atendidas,
      latidoHaceMs,
      sano: this.o.config.estado === "configurado" && latidoVigente,
    };
  }

  /** El sondeo de la telefonia lleva mas de `maxMs` sin responder y no hay llamadas en curso: el proceso esta vivo pero NO atiende. El arranque lo usa para salir
   * con error y que el host (Fly: `restart policy always`) lo reinicie; las health checks de Fly solo informan, no reinician. */
  latidoVencido(maxMs: number = LATIDO_MAX_MS * 2, ahora: number = Date.now()): boolean {
    if (!this.escuchando || this.activas.size > 0) return false;
    const latido = this.o.telefonia?.latidoMs?.() ?? null;
    return latido !== null && ahora - latido > maxMs;
  }

  /** `true` si empezo a escuchar llamadas. */
  async iniciar(): Promise<boolean> {
    if (this.o.config.estado !== "configurado" || !this.o.telefonia || !this.o.deps) {
      this.o.log("worker_no_configurado", { motivos: this.o.config.motivos.length });
      for (const m of this.o.config.motivos) this.o.log("worker_motivo", { motivo: m });
      return false;
    }
    await this.o.telefonia.escuchar((tel) => this.alLlegar(tel));
    this.escuchando = true;
    this.o.log("worker_escuchando", { numeros: this.o.config.dnis.size });
    return true;
  }

  private alLlegar(tel: LlamadaTelefonica): void {
    const deps = this.o.deps;
    if (!deps) return;
    const control = new AbortController();
    this.abortos.add(control);
    const p = atenderLlamada(tel, deps, control.signal)
      .then((resumen) => {
        this.atendidas += 1;
        this.resumenes.push(resumen);
        if (this.resumenes.length > 100) this.resumenes.shift();
      })
      .catch(() => {
        // Un error inesperado en una llamada no llega al proceso: se cuelga y se sigue (el detalle sin PII ya salio por el log de la llamada).
        this.o.log("llamada_error", { codigo: "excepcion" });
        return tel.colgar().catch(() => undefined);
      })
      .finally(() => {
        this.abortos.delete(control);
        this.activas.delete(p);
      });
    this.activas.add(p);
  }

  /** Deja de recibir llamadas y espera a las activas hasta `plazoMs`; las que sigan se abortan. */
  async detener(plazoMs = 20_000): Promise<void> {
    this.escuchando = false;
    await this.o.telefonia?.detener().catch(() => undefined);
    const espera = Promise.allSettled([...this.activas]);
    let temporizador: ReturnType<typeof setTimeout> | null = null;
    const plazo = new Promise<"plazo">((r) => {
      temporizador = setTimeout(() => r("plazo"), plazoMs);
    });
    const gano = await Promise.race([espera.then(() => "fin" as const), plazo]);
    if (temporizador) clearTimeout(temporizador);
    if (gano === "plazo") {
      for (const c of this.abortos) c.abort();
      await Promise.race([espera, new Promise((r) => setTimeout(r, 5_000))]);
    }
  }
}

/** Servidor de /salud: 200 si el worker esta configurado y con latido vigente, 503 con los motivos (o el latido vencido) si no. Sin autenticacion: no devuelve valores ni PII. */
export function crearServidorSalud(worker: Worker): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/salud" || req.url === "/salud/")) {
      const s = worker.salud();
      res.writeHead(s.sano ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(s));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_encontrado" }));
  });
}
