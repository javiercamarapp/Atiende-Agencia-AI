// Destacado de la cabecera de un Resumen (antes «odometro», el contador retro de Likida con digitos en tablero que volteaban). El dueno
// pidio retirar el estilo reloj: ahora es una cifra grande y elegante (<Cifra>: sans proporcional, signo de moneda tenue, miles es-MX)
// con un solo conteo sutil al aparecer bajo ds3. Se conserva el nombre y la API para no tocar las 10 pantallas que lo usan.
//
// Honesto: `valor` es SIEMPRE un total real que inyecta la pagina. `null` (no medible) pinta "—" y el motivo en `sinDato`, nunca un
// cero que nadie midio. Acento de Atiende: el avance hacia la `meta` (opcional) se pinta con el azul de marca (`bg-primary`).
import { cn } from "../lib/utils";
import { formatMoney } from "../lib/formatMoney";
import { Cifra, type CifraTamano } from "./Cifra";

export type OdometroTamano = "md" | "lg";

/** lg = destacado del MRR (28 px), md = destacado de un Resumen (20 px). */
const TAMANO_CIFRA: Record<OdometroTamano, CifraTamano> = { lg: 28, md: 20 };

export interface OdometroProps {
  /** Total real. `null` = no medible: se pinta "—" y `sinDato`. Debe ser entero >= 0. */
  readonly valor: number | null;
  /**
   * Obsoleto: el tablero rellenaba con ceros a la izquierda («0001234»), parte del estilo reloj que se retiro. Se ignora; se
   * conserva opcional para no romper a quien aun lo pasa.
   */
  readonly digitos?: number;
  /** "$" = monto en pesos (sin decimales); omitido = conteo. */
  readonly prefijo?: string;
  /** Rotulo, p. ej. "MRR — META $1,000,000". */
  readonly etiqueta: string;
  /** Pie cuando `valor` es `null`: por que no hay cifra. */
  readonly sinDato?: string;
  readonly tamano?: OdometroTamano;
  /** Meta numerica: con valor real muestra el avance hacia ella (barra azul + porcentaje). */
  readonly meta?: number;
  readonly className?: string;
}

export function avanceHaciaMeta(valor: number, meta: number): number {
  return Math.min(100, Math.max(0, Math.round((valor / meta) * 100)));
}

const ROTULO = "whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export function Odometro({ valor, prefijo, etiqueta, sinDato = "sin medir", tamano = "md", meta, className }: OdometroProps) {
  const contenedor = cn("hidden shrink-0 flex-col items-end gap-2 sm:flex", className);
  const medible = valor !== null && Number.isFinite(valor) && valor >= 0;
  const cifra = TAMANO_CIFRA[tamano];

  if (!medible) {
    return (
      <div data-testid="odometro" role="group" aria-label={`${etiqueta}: ${sinDato}`} className={contenedor}>
        <span aria-hidden="true" className="cifra cifra-vacia font-display text-muted-foreground" data-tamano={cifra}>
          —
        </span>
        <span className={ROTULO}>{etiqueta}</span>
        <span className="text-2xs normal-case text-faint">{sinDato}</span>
      </div>
    );
  }

  const entero = Math.round(valor);
  const dinero = prefijo === "$";
  const avance = meta !== undefined && meta > 0 ? avanceHaciaMeta(entero, meta) : null;
  return (
    <div data-testid="odometro" role="group" aria-label={`${etiqueta}: ${prefijo ?? ""}${formatMoney(entero, 0)}`} className={contenedor}>
      <span aria-hidden="true" className="leading-none">
        <Cifra
          data-testid="odometro-cifra"
          valor={entero}
          variante={dinero ? "dinero" : "conteo"}
          decimales={0}
          tamano={cifra}
          className="font-display text-foreground"
        />
      </span>
      <span className={ROTULO}>{etiqueta}</span>
      {avance !== null && (
        <div className="flex w-full items-center gap-2">
          <div role="progressbar" aria-label="Avance hacia la meta" aria-valuemin={0} aria-valuemax={100} aria-valuenow={avance} className="h-1 flex-1 overflow-hidden rounded-full bg-canvas">
            <div data-testid="odometro-avance" className="h-full rounded-full bg-primary" style={{ width: `${avance}%` }} />
          </div>
          <span className="text-2xs font-medium tabular-nums text-muted-foreground">{avance}% de la meta</span>
        </div>
      )}
    </div>
  );
}
