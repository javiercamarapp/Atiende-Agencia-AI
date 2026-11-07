import { useId, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { AtiendeMark } from "../AtiendeLogo";
import { useIdiomaCopiloto } from "./idioma";
import type { PasoHerramienta } from "./useCopiloto";

/**
 * El "pensando": logo Atiende de 16 px que respira (atiende-respira) con sus tres lineas corriendo,
 * la fase por tiempo y, debajo, los pasos de herramienta en vivo (punto = en curso, palomita = terminado).
 */
export function CopilotoPensando({
  fase,
  pasos,
  etiquetas,
}: {
  fase: string;
  pasos: readonly PasoHerramienta[];
  etiquetas: Readonly<Record<string, string>>;
}) {
  const etiqueta = (p: PasoHerramienta) => etiquetas[p.herramienta] ?? p.herramienta;
  const { t } = useIdiomaCopiloto();
  // ds3: los pasos se pueden plegar con «Pensamiento del sistema en vivo · n» (abiertos de entrada, como hoy).
  const [abierto, setAbierto] = useState(true);
  const idLista = useId();
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="copiloto-pensando">
      <AtiendeMark animado className="h-4 w-auto atiende-respira shrink-0 mt-0.5" />
      <div>
        <span data-testid="copiloto-fase">{fase}</span>
        {pasos.length > 0 ? (
          <button
            type="button"
            hidden
            className="ds3-solo ds3-copiloto-pensamiento"
            aria-expanded={abierto}
            aria-controls={idLista}
            onClick={() => setAbierto((v) => !v)}
          >
            <ChevronRight aria-hidden="true" />
            {t("pensamientoVivo", { n: pasos.length })}
          </button>
        ) : null}
        {pasos.length > 0 ? (
          <ul id={idLista} hidden={!abierto} className="mt-2 space-y-1.5">
            {pasos.map((p, i) =>
              p.fin ? (
                <li key={`${p.herramienta}-${i}`} className="text-pill text-faint flex items-center gap-1.5">
                  <Check className="size-3 stroke-2" aria-hidden />
                  {etiqueta(p)}
                </li>
              ) : (
                <li key={`${p.herramienta}-${i}`} className="text-pill text-foreground flex items-center gap-1.5">
                  <span className="ds-skeleton size-2.5 rounded-full bg-muted" aria-hidden />
                  {etiqueta(p)}…
                </li>
              ),
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
