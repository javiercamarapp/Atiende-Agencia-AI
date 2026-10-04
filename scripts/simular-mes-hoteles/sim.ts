// Nucleo del simulador: cliente HTTP en proceso contra la app Hono REAL (app.request), registro de eventos del dia, conteo de
// respuestas por status (assert "ningun 5xx") y conteo de filas por tabla (filas creadas por dia).
import type { Hono } from "hono";
import type { Client } from "pg";
import type { ActorEvento, EventoLedger, Hallazgo, ResumenHttp } from "./ledger.ts";
import { PASSWORD, correoDe, type RolStaff } from "./mundo.ts";

export interface RespuestaApi {
  readonly status: number;
  // JSON de la API bajo prueba: el simulador lo recorre sin esquema (la forma real la valida la API, no el simulador).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly json: any;
  readonly texto: string;
}

export interface OpcionesApi {
  /** Statuses que el escenario espera (p. ej. un rechazo deliberado 409). Por defecto, cualquier 2xx. */
  readonly esperado?: readonly number[];
  readonly idem?: string;
  readonly tipo?: string;
  readonly actor?: ActorEvento;
  readonly detalle?: Record<string, string | number | boolean | null>;
  readonly headers?: Record<string, string>;
  /** No registrar como evento del ledger (llamadas de apoyo, p. ej. login). */
  readonly silencioso?: boolean;
  /** Sondeo contra OTRA instancia de la app (p. ej. la de produccion sin dobles): su respuesta no cuenta en el assert de cero 5xx ni en los rechazos inesperados. */
  readonly sondeo?: Hono;
}

export class Simulador {
  readonly eventos: EventoLedger[] = [];
  readonly hallazgos: Hallazgo[] = [];
  readonly porStatus: Record<string, number> = {};
  inesperados: { tipo: string; metodo: string; ruta: string; status: number; cuerpo: string }[] = [];
  #total = 0;
  #cinco = 0;
  #tokens = new Map<RolStaff, string>();
  #idem = 0;

  constructor(
    readonly app: Hono,
    readonly db: Client,
  ) {}

  nuevaClaveIdem(prefijo: string): string {
    this.#idem += 1;
    return `sim-${prefijo}-${this.#idem}`;
  }

  async login(rol: RolStaff, forzar = false): Promise<string> {
    if (!forzar) {
      const t = this.#tokens.get(rol);
      if (t) return t;
    }
    const raw = JSON.stringify({ email: correoDe(rol), password: PASSWORD });
    const res = await this.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) }, body: raw });
    this.#contar(res.status);
    const j = (await res.json().catch(() => ({}))) as { token?: string };
    if (res.status !== 200 || !j.token) throw new Error(`login de ${rol} fallo: ${res.status}`);
    this.#tokens.set(rol, j.token);
    return j.token;
  }

  olvidarTokens(): void {
    this.#tokens.clear();
  }

  #contar(status: number): void {
    this.#total += 1;
    const k = String(status);
    this.porStatus[k] = (this.porStatus[k] ?? 0) + 1;
    if (status >= 500) this.#cinco += 1;
  }

  /** Llamada autenticada como `rol` (o sin token con rol=null). */
  async api(rol: RolStaff | null, metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", ruta: string, cuerpo?: unknown, op: OpcionesApi = {}): Promise<RespuestaApi> {
    const headers: Record<string, string> = { ...(op.headers ?? {}) };
    if (rol) headers.authorization = `Bearer ${await this.login(rol)}`;
    if (op.idem) headers["idempotency-key"] = op.idem;
    let body: string | undefined;
    if (cuerpo !== undefined) {
      body = JSON.stringify(cuerpo);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const res = await (op.sondeo ?? this.app).request(ruta, { method: metodo, headers, body });
    if (!op.sondeo) this.#contar(res.status);
    const texto = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try {
      json = texto.length > 0 ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    const esperado = op.esperado ?? [200, 201, 202, 204];
    const ok = esperado.includes(res.status);
    if (!ok && !op.sondeo) this.inesperados.push({ tipo: op.tipo ?? `${metodo} ${ruta}`, metodo, ruta, status: res.status, cuerpo: texto.slice(0, 300) });
    if (!op.silencioso) this.evento(op.tipo ?? `${metodo} ${ruta}`, op.actor ?? "staff", ok, res.status, op.detalle ?? {});
    return { status: res.status, json, texto };
  }

  /** Registra (una sola vez por id) un bug real o hueco que la simulacion expuso; si repite, solo agrega el dia. */
  hallazgo(h: Omit<Hallazgo, "dias">, dia: number): void {
    const i = this.hallazgos.findIndex((x) => x.id === h.id);
    if (i === -1) this.hallazgos.push({ ...h, dias: [dia] });
    else if (!this.hallazgos[i]!.dias.includes(dia)) this.hallazgos[i] = { ...this.hallazgos[i]!, dias: [...this.hallazgos[i]!.dias, dia] };
  }

  evento(tipo: string, actor: ActorEvento, ok: boolean, status: number | null, detalle: Record<string, string | number | boolean | null> = {}): void {
    this.eventos.push({ tipo, actor, ok, status, detalle });
  }

  /** Cierra el dia: devuelve eventos + http y reinicia los contadores del dia. */
  cerrarDia(): { eventos: EventoLedger[]; http: ResumenHttp } {
    const out = { eventos: [...this.eventos], http: { total: this.#total, porStatus: { ...this.porStatus }, cincoXX: this.#cinco } };
    this.eventos.length = 0;
    for (const k of Object.keys(this.porStatus)) delete this.porStatus[k];
    this.#total = 0;
    this.#cinco = 0;
    return out;
  }

  async conteosTablas(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'hoteles' and table_type = 'BASE TABLE' order by 1`);
    const out: Record<string, number> = {};
    for (const { t } of rows) {
      const r = await this.db.query<{ n: string }>(`select count(*)::text as n from hoteles."${t}"`);
      out[`hoteles.${t}`] = Number(r.rows[0]!.n);
    }
    return out;
  }
}

export function diferenciaConteos(antes: Record<string, number>, despues: Record<string, number>): Record<string, number> {
  const d: Record<string, number> = {};
  for (const [k, v] of Object.entries(despues)) {
    const n = v - (antes[k] ?? 0);
    if (n !== 0) d[k] = n;
  }
  return d;
}
