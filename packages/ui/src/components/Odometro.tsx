// Odometro (contador retro) de Likida (admin/contador-retro.tsx:32-48,113-131): digitos en tablero
// oscuro con raya central y "hoja" que gira 420 ms cuando el digito cambia. Pensado para el MRR
// del superadmin contra su meta.
//
// Honesto: `valor` es SIEMPRE un total real que inyecta la pagina. `null` (no medible) pinta "—" y
// el motivo en `sinDato`, nunca un cero que nadie midio. El volteo solo ocurre cuando el valor
// CAMBIA despues de montar (no se inventa una cuenta desde 0), y se apaga con reduced-motion.
//
// Acento de Atiende: donde Likida usa tinta, el avance hacia la `meta` (opcional) se pinta con el
// azul de marca (`bg-primary`). Los tableros conservan los tokens `--odometro-*` de Likida.
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { formatMoney } from "../lib/formatMoney";

export type OdometroTamano = "md" | "lg";

const DIMS: Record<OdometroTamano, { w: number; h: number; font: number; radio: number; prefijo: number }> = {
  lg: { w: 33, h: 45, font: 29, radio: 7, prefijo: 23 },
  md: { w: 20, h: 27, font: 18, radio: 5, prefijo: 16 },
};

/** Duracion del volteo de la hoja (Likida: 420 ms). */
export const ODOMETRO_VOLTEO_MS = 420;

function Digito({ valor, tamano }: { valor: string; tamano: OdometroTamano }) {
  const [mostrado, setMostrado] = useState(valor);
  const [anterior, setAnterior] = useState<string | null>(null);

  // Ajustar estado derivado en el render (patron recomendado por React); el efecto solo retira la hoja.
  if (valor !== mostrado) {
    setAnterior(mostrado);
    setMostrado(valor);
  }

  useEffect(() => {
    if (anterior === null) return;
    const t = setTimeout(() => setAnterior(null), ODOMETRO_VOLTEO_MS);
    return () => clearTimeout(t);
  }, [anterior]);

  const d = DIMS[tamano];
  const estilo = { fontSize: d.font, borderRadius: d.radio } as const;
  return (
    <div data-testid="odometro-digito" aria-hidden="true" className="odometro-digito relative" style={{ width: d.w, height: d.h, borderRadius: d.radio, perspective: d.h * 5.5 }}>
      <span className="absolute inset-0 flex items-center justify-center" style={estilo}>
        {mostrado}
      </span>
      <div className="odometro-raya absolute inset-x-0 top-1/2 h-px" />
      {anterior !== null && (
        <div data-testid="odometro-hoja" className="odometro-hoja absolute inset-0 flex items-center justify-center" style={estilo}>
          {anterior}
        </div>
      )}
    </div>
  );
}

export interface OdometroProps {
  /** Total real. `null` = no medible: se pinta "—" y `sinDato`. Debe ser entero >= 0. */
  readonly valor: number | null;
  /** Cifras minimas (se rellena con ceros a la izquierda): 7 = el ancho de "1,000,000". */
  readonly digitos: number;
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

export function Odometro({ valor, digitos, prefijo, etiqueta, sinDato = "sin medir", tamano = "md", meta, className }: OdometroProps) {
  const d = DIMS[tamano];
  const contenedor = cn("hidden shrink-0 flex-col items-end gap-2 sm:flex", className);
  const medible = valor !== null && Number.isFinite(valor) && valor >= 0;

  if (!medible) {
    return (
      <div data-testid="odometro" role="group" aria-label={`${etiqueta}: ${sinDato}`} className={contenedor}>
        <span className="font-bold tabular-nums text-muted-foreground" style={{ fontSize: d.font }}>
          —
        </span>
        <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground">{etiqueta}</span>
        <span className="text-2xs normal-case text-faint">{sinDato}</span>
      </div>
    );
  }

  const entero = Math.round(valor);
  const cifras = String(entero).padStart(digitos, "0").split("");
  const avance = meta !== undefined && meta > 0 ? avanceHaciaMeta(entero, meta) : null;
  return (
    <div data-testid="odometro" role="group" aria-label={`${etiqueta}: ${prefijo ?? ""}${formatMoney(entero, 0)}`} className={contenedor}>
      <div className="flex items-center gap-1.5">
        {prefijo && (
          <span aria-hidden="true" className="font-bold text-muted-foreground" style={{ fontSize: d.prefijo }}>
            {prefijo}
          </span>
        )}
        {cifras.map((c, i) => (
          // La clave es la posicion DESDE LA DERECHA: al crecer el numero, cada digito conserva su hoja.
          <Digito key={cifras.length - i} valor={c} tamano={tamano} />
        ))}
      </div>
      <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground">{etiqueta}</span>
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
