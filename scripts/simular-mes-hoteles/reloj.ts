// Reloj simulado del simulador de hoteles. Sustituye `Date` GLOBAL por una subclase cuyo "ahora" lo manda el simulador: asi el
// codigo REAL de la API y del worker (`hoyFechaNegocio`, JWT, rate limits, crons) ve el dia simulado sin tocar una sola linea.
// LIMITE DECLARADO: el `now()` de Postgres sigue siendo el real (default de columnas `created_at`, SLA, expiraciones calculadas en
// SQL); lo que el simulador necesita mover en SQL se mueve con fixtures explicitos (ver escenarios.ts), igual que los verify-*.
const RealDate = Date;

export class RelojSimulado {
  #ms: number;

  constructor(inicioIso: string) {
    this.#ms = RealDate.parse(inicioIso);
  }

  instalar(): void {
    const ahoraSimulado = (): number => this.#ms;
    class FechaSimulada extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(ahoraSimulado());
        else super(...(args as [number]));
      }
      static override now(): number {
        return ahoraSimulado();
      }
    }
    (globalThis as unknown as { Date: DateConstructor }).Date = FechaSimulada as unknown as DateConstructor;
  }

  desinstalar(): void {
    (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
  }

  ahoraMs(): number {
    return this.#ms;
  }

  iso(): string {
    return new RealDate(this.#ms).toISOString();
  }

  /** Avanza el reloj (nunca retrocede). */
  avanzarMinutos(min: number): void {
    if (min < 0) throw new Error("el reloj simulado no retrocede");
    this.#ms += min * 60_000;
  }

  /** Salta a un instante absoluto (debe ser >= ahora). */
  irA(iso: string): void {
    const ms = RealDate.parse(iso);
    if (ms < this.#ms) throw new Error(`el reloj simulado no retrocede: ${iso} < ${this.iso()}`);
    this.#ms = ms;
  }
}

/** Instante UTC de las `hh:mm` locales de `fecha` (YYYY-MM-DD) en `zona`. Resuelve el offset real de esa fecha (DST incluido). */
export function instanteLocalIso(fecha: string, hhmm: string, zona: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const base = RealDate.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)) - 1, Number(fecha.slice(8, 10)), h, m);
  // offset de la zona en ese instante aproximado: itera una vez para absorber el DST.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const partes = (ms: number) => {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new RealDate(ms))) o[p.type] = p.value;
    return RealDate.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour), Number(o.minute));
  };
  const offset = partes(base) - base;
  return new RealDate(base - offset).toISOString();
}

export function sumarDias(fecha: string, dias: number): string {
  return new RealDate(RealDate.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}
