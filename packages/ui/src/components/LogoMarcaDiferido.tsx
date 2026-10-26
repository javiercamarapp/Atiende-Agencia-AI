import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
// Solo TIPOS de LogoMarca (se borran al compilar): un import de valor lo metería en el chunk de entrada y anularía el diferido.
import type { LogoMarca as LogoMarcaCompleto, LogoMarcaTamano } from "./LogoMarca";

const Perezoso = lazy(() => import("./LogoMarca").then((m) => ({ default: m.LogoMarca })));

/** Hueco que reserva mientras carga (14/16/20/24 px, igual que `LOGO_MARCA_PX`). */
const HUECO: Record<LogoMarcaTamano, string> = { xs: "size-3.5", sm: "size-4", md: "size-5", lg: "size-6" };

/**
 * `LogoMarca` por import dinamico, para chunks de ENTRADA (el presupuesto del lote 2.4 es <= 4 KB gz). Mientras carga
 * reserva el hueco del logo (`aria-hidden`, sin texto) para que no haya salto de layout. Mismas props que `LogoMarca`.
 *
 * Como importar: en chunks de entrada usa `LogoMarcaDiferido` (barrel `@atiende/ui`); `LogoMarca` NO esta en el barrel a proposito (un
 * export estatico lo metería en el chunk de entrada). Donde el peso no importa: `import { LogoMarca } from "@atiende/ui/logo-marca"`.
 */
export function LogoMarcaDiferido(props: ComponentProps<typeof LogoMarcaCompleto>) {
  return (
    <Suspense fallback={<span aria-hidden="true" data-logo-marca-cargando="" className={`inline-block shrink-0 ${HUECO[props.tamano ?? "md"]}`} />}>
      <Perezoso {...props} />
    </Suspense>
  );
}
