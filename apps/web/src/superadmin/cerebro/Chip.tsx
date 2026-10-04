// Chip de filtro del Cerebro (el `Chip` de cerebro.tsx de Likida). ADITIVO: sin nada seleccionado se ve todo y los chips van apagados; un
// clic AGREGA el chip (se pinta con tinta suave, no relleno negro) y otro clic lo quita. Los chips de vertical se pintan con el color de su vertical.
import { cn } from "@atiende/ui";
import { claseVertical } from "./verticales.ts";

export function Chip({ activo, vertical, onClick, children, title }: {
  readonly activo: boolean;
  /** Si es una vertical, el chip activo se pinta con su color. */
  readonly vertical?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-eyebrow transition-all",
        vertical && claseVertical(vertical),
        activo ? cn("font-medium", vertical ? "cerebro-chip-vertical-activo" : "cerebro-chip-activo") : "border-border text-muted-foreground hover:bg-canvas",
      )}
    >
      {vertical && <span aria-hidden="true" className="cerebro-punto-sin-halo size-1.5 rounded-full" />}
      {children}
    </button>
  );
}
