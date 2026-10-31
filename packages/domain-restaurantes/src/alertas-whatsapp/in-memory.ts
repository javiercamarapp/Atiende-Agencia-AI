// Dobles en memoria de los puertos de alertas (adaptador FALSO: nunca toca WhatsApp, Meta ni la base). Mismo contrato que `postgres.ts`.
import type { AlertaCandidata, AlertaSucursalConfig, AlertasOutboxPort, AlertasPanelPort, AlertasRepositorio, Lectura, MotivoDegradacion, RegistroAlerta } from "./tipos.ts";

export class InMemoryAlertasRepositorio implements AlertasRepositorio {
  readonly lista: AlertaCandidata[] = [];
  readonly configs = new Map<string, AlertaSucursalConfig>();
  readonly registros: RegistroAlerta[] = [];
  /** Simula la base sin la migracion 103. */
  noDisponible = false;

  async candidatas(_ahora: Date, limite: number): Promise<Lectura<readonly AlertaCandidata[]>> {
    if (this.noDisponible) return { disponible: false, valor: [] };
    // Solo sucursales con alertas activas, como la funcion SQL.
    return { disponible: true, valor: this.lista.filter((c) => this.configs.get(c.propertyId)?.activa === true).slice(0, limite) };
  }

  async leerConfig(organizationId: string, propertyId: string): Promise<AlertaSucursalConfig | null> {
    const c = this.configs.get(propertyId);
    return c && c.organizationId === organizationId ? c : null;
  }

  async registrar(r: RegistroAlerta): Promise<boolean> {
    if (this.registros.some((x) => x.tipo === r.tipo && x.clave === r.clave && x.destinoHash === r.destinoHash)) return false;
    this.registros.push(r);
    return true;
  }
}

export class InMemoryAlertasOutbox implements AlertasOutboxPort {
  readonly enviados = new Map<string, { readonly organizationId: string; readonly payload: Readonly<Record<string, unknown>> }>();
  /** Todo lo que SE HABRIA mandado a Meta (idempotente por dedupeKey, como el outbox real). */
  async encolar(organizationId: string, dedupeKey: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.enviados.has(dedupeKey)) this.enviados.set(dedupeKey, { organizationId, payload });
  }
}

export class InMemoryAlertasPanel implements AlertasPanelPort {
  readonly degradadas: { readonly c: AlertaCandidata; readonly motivo: MotivoDegradacion }[] = [];
  readonly sinRespuestaAvisos: AlertaCandidata[] = [];
  async degradada(c: AlertaCandidata, motivo: MotivoDegradacion): Promise<void> {
    this.degradadas.push({ c, motivo });
  }
  async sinRespuesta(c: AlertaCandidata): Promise<void> {
    if (!this.sinRespuestaAvisos.some((x) => x.clave === c.clave)) this.sinRespuestaAvisos.push(c);
  }
}
