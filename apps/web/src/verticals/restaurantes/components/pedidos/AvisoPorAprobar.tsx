// Aviso de «Ordenes recibidas» cuando hay pedidos esperando aprobacion (regla del repo suelto: lo que espera aprobacion nunca queda
// fuera de la vista de recibidas). Con alguna urgente (escalada al dueno o pasado el umbral de la sucursal) el aviso es de peligro.
import { Button, Callout, StatusBadge, useT } from "@atiende/ui";
import { aprobaciones } from "@atiende/ui/i18n/aprobaciones";
import type { ResumenPorAprobar } from "../../lib/pedidos-por-aprobar.ts";

export function AvisoPorAprobar({ resumen, onRevisar }: { readonly resumen: ResumenPorAprobar; readonly onRevisar: () => void }) {
  const t = useT(aprobaciones);
  if (resumen.total === 0) return null;
  const urgente = resumen.urgentes > 0;
  const detalle = urgente
    ? t("aprobaciones.aviso.urgentes", { count: resumen.urgentes, minutos: resumen.masAntiguaMin })
    : resumen.masAntiguaMin < 1
      ? t("aprobaciones.aviso.esperaMenosDeUno")
      : t("aprobaciones.aviso.espera", { minutos: resumen.masAntiguaMin });
  return (
    <Callout
      tone={urgente ? "danger" : "warning"}
      titulo={t("aprobaciones.aviso.titulo", { count: resumen.total })}
      data-testid="aviso-por-aprobar"
      accion={
        <Button type="button" size="sm" variant={urgente ? "default" : "outline"} onClick={onRevisar}>
          {t("aprobaciones.aviso.revisar")}
        </Button>
      }
    >
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {urgente && (
          <StatusBadge tone="danger" dot={false}>
            {t("aprobaciones.urgente")}
          </StatusBadge>
        )}
        {detalle}
      </span>
    </Callout>
  );
}
