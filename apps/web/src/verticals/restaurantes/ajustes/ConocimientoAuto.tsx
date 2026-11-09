// Base de conocimiento automatica: los documentos que el agente recibe, generados AHORA de los datos de la cuenta (nada escrito a mano, sin copias que envejezcan).
// Contrato: GET .../admin/agente/conocimiento. Muestra que documentos entran a la instruccion de voz y cuales el agente consulta en vivo, las colonias ambiguas y lo que
// la plataforma decidio NO generar (ventas y personal) con su razon.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, StatusBadge, formatMoney, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesConocimiento } from "@atiende/ui/i18n/restaurantes/conocimiento";
import { horaEsMx } from "../../../lib/formato-fecha.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { fetchConocimientoAuto } from "../lib/ajustes-agente-client.ts";
import type { ConocimientoAutoVista } from "../lib/ajustes-agente-client.ts";

type Estado =
  | { readonly fase: "cargando" }
  | { readonly fase: "listo"; readonly datos: ConocimientoAutoVista }
  | { readonly fase: "no_disponible" }
  | { readonly fase: "error"; readonly mensaje: string };

const ETIQUETA_OMITIDO: Readonly<Record<string, Clave>> = { ventas: "restaurantes.conocimiento.auto.ventas", personal: "restaurantes.conocimiento.auto.personal" };

function hora(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? "—" : horaEsMx(iso);
}

export interface ConocimientoAutoProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function ConocimientoAuto({ apiBaseUrl, token, propertyId }: ConocimientoAutoProps) {
  const t = useT(restaurantesConocimiento);
  const [estado, setEstado] = useState<Estado>({ fase: "cargando" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setEstado({ fase: "cargando" });
    (async () => {
      try {
        const datos = await fetchConocimientoAuto(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setEstado({ fase: "listo", datos });
      } catch (err) {
        if (cancelado) return;
        setEstado(err instanceof VozNoDisponibleError ? { fase: "no_disponible" } : { fase: "error", mensaje: err instanceof Error ? err.message : t("restaurantes.conocimiento.auto.errorGenerar") });
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <Card data-testid="seccion-conocimiento-auto">
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{t("restaurantes.conocimiento.auto.titulo")}</CardTitle>
            <CardDescription>{t("restaurantes.conocimiento.auto.descripcion")}</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={reintentar} disabled={estado.fase === "cargando"}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.75} />
            {t("restaurantes.conocimiento.auto.regenerar")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {estado.fase === "cargando" ? <EstadoCargando etiqueta={t("restaurantes.conocimiento.auto.generando")} /> : null}
        {estado.fase === "error" ? <EstadoError mensaje={estado.mensaje} onReintentar={reintentar} /> : null}
        {estado.fase === "no_disponible" ? (
          <p role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("restaurantes.conocimiento.auto.noDisponible")}
          </p>
        ) : null}
        {estado.fase === "listo" ? (
          <>
            <p className="text-xs text-muted-foreground" data-testid="conocimiento-nota">
              {estado.datos.nota}
              {t("restaurantes.conocimiento.auto.generado", { hora: hora(estado.datos.generadoEn) })}
              <span className="font-mono">{estado.datos.huella.slice(0, 8)}</span>.
            </p>

            {estado.datos.alertasColonias.items.length > 0 ? (
              <Callout tone="warning" role="status" data-testid="alerta-colonias">
                <p className="font-medium">{t("restaurantes.conocimiento.auto.coloniasTitulo", { km: estado.datos.alertasColonias.umbralKm })}</p>
                <ul className="mt-1 list-disc pl-4">
                  {estado.datos.alertasColonias.items.map((a) => (
                    <li key={a.colonia}>
                      {t("restaurantes.conocimiento.auto.coloniaItem", { colonia: a.colonia, a: a.sucursales[0] ?? "", b: a.sucursales[1] ?? "", km: formatMoney(a.diferenciaKm, 2) })}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {estado.datos.alertasColonias.sinSucursal > 0 ? (
              <Callout tone="info" role="status" data-testid="aviso-colonias-sin-sucursal">
                {t("restaurantes.conocimiento.auto.sinSucursal", { n: estado.datos.alertasColonias.sinSucursal })}
              </Callout>
            ) : null}

            <ul className="grid gap-2">
              {estado.datos.documentos.map((d) => (
                <li key={d.tipo} data-documento={d.tipo} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{d.titulo}</p>
                    {d.vacio ? (
                      <StatusBadge tone="neutral" dot={false}>{t("restaurantes.conocimiento.auto.sinDatos")}</StatusBadge>
                    ) : d.enPrompt ? (
                      <StatusBadge tone="success" dot={false}>{t("restaurantes.conocimiento.auto.enPrompt")}</StatusBadge>
                    ) : (
                      <StatusBadge tone="warning" dot={false}>{t("restaurantes.conocimiento.auto.enVivo")}</StatusBadge>
                    )}
                  </div>
                  {d.vacio ? (
                    <p className="mt-1 text-xs text-muted-foreground">{d.motivoVacio}</p>
                  ) : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {t("restaurantes.conocimiento.auto.caracteres", { n: formatMoney(d.caracteres, 0) })}
                        <span className="font-mono">{d.huella.slice(0, 8)}</span>
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs text-foreground">{d.contenido}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>

            <p className="text-xs text-muted-foreground" data-testid="conocimiento-tope">
              {t("restaurantes.conocimiento.auto.tope", { usados: formatMoney(estado.datos.prompt.caracteresUsados, 0), tope: formatMoney(estado.datos.prompt.topeCaracteres, 0) })}
            </p>

            <div data-testid="documentos-omitidos">
              <p className="text-sm font-medium text-foreground mb-1">{t("restaurantes.conocimiento.auto.noSeGeneran")}</p>
              <ul className="space-y-1.5">
                {estado.datos.documentosOmitidos.map((o) => (
                  <li key={o.tipo} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{ETIQUETA_OMITIDO[o.tipo] ? t(ETIQUETA_OMITIDO[o.tipo] as Clave) : o.tipo}:</span> {o.motivo}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
