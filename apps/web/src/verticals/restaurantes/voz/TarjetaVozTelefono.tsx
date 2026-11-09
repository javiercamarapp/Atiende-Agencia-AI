// Tarjeta de la voz TELEFONICA de la sucursal (avatar conico con tokens, como el panel original) + boton «Clonar una voz».
// El dialogo de clonacion se carga perezoso: su codigo (grabadora, lista de clips) solo baja cuando alguien lo abre.
import { Suspense, lazy, useState } from "react";
import { Mic } from "lucide-react";
import { Button, StatusBadge, useT } from "@atiende/ui";
import { vozClon } from "@atiende/ui/i18n/vozClon";
import { VOCES_TELEFONO } from "../lib/voz-telefono-catalogo.ts";
import { AVATARES_BASE, giroAvatar } from "./SelectorVoz.tsx";

const ClonarVozDialogo = lazy(async () => ({ default: (await import("./ClonarVozDialogo.tsx")).ClonarVozDialogo }));

/** La voz guardada no es del catalogo telefonico: es una voz clonada de la sucursal. */
export function esVozClonada(vozTelefono: string | null | undefined): vozTelefono is string {
  return typeof vozTelefono === "string" && !VOCES_TELEFONO.some((v) => v.id === vozTelefono);
}

export interface TarjetaVozTelefonoProps {
  /** Voz telefonica elegida (null = la de la plataforma). */
  readonly vozTelefono: string | null;
  /** Solo owner/admin clonan (la API exige lo mismo). */
  readonly puedeClonar: boolean;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** La API ya guardo la voz clonada como voz telefonica de la sucursal. */
  readonly onClonada: (vozTelefono: string) => void;
}

export function TarjetaVozTelefono({ vozTelefono, puedeClonar, apiBaseUrl, token, propertyId, onClonada }: TarjetaVozTelefonoProps) {
  const t = useT(vozClon);
  const [abierto, setAbierto] = useState(false);
  const clonada = esVozClonada(vozTelefono);
  const delCatalogo = VOCES_TELEFONO.find((v) => v.id === vozTelefono) ?? VOCES_TELEFONO[0]!;
  const id = clonada ? vozTelefono : delCatalogo.id;
  const nombre = clonada ? t("vozClon.tarjeta.clonada") : delCatalogo.nombre;
  const detalle = clonada ? t("vozClon.tarjeta.clonadaDetalle") : delCatalogo.estilo;

  return (
    <div data-testid="tarjeta-voz-telefono" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <span aria-hidden="true" className={`h-10 w-10 shrink-0 rounded-full ${giroAvatar(id.charCodeAt(0) * 37, AVATARES_BASE)}`} />
      <div className="min-w-0 flex-1">
        <p className="text-eyebrow text-muted-foreground">{t("vozClon.tarjeta.etiqueta")}</p>
        <p className="truncate text-sm font-medium text-foreground">
          {nombre}
          {vozTelefono === null ? <span className="text-muted-foreground"> · {t("vozClon.tarjeta.plataforma")}</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">{detalle}</p>
      </div>
      {clonada ? <StatusBadge tone="info">{t("vozClon.tarjeta.clonada")}</StatusBadge> : null}
      {puedeClonar ? (
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setAbierto(true)}>
          <Mic className="h-3.5 w-3.5" aria-hidden="true" />
          {clonada ? t("vozClon.tarjeta.clonarDeNuevo") : t("vozClon.tarjeta.clonar")}
        </Button>
      ) : null}
      {abierto ? (
        <Suspense fallback={null}>
          <ClonarVozDialogo
            open={abierto}
            onOpenChange={setAbierto}
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            onClonada={(v) => {
              setAbierto(false);
              onClonada(v);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
