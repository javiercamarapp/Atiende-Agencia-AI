// Base de conocimiento automatica: los documentos que el agente recibe, generados AHORA de los datos de la cuenta (nada escrito a mano, sin copias que envejezcan).
// Contrato: GET .../admin/agente/conocimiento. Muestra que documentos entran a la instruccion de voz y cuales el agente consulta en vivo, las colonias ambiguas y lo que
// la plataforma decidio NO generar (ventas y personal) con su razon.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, StatusBadge, formatMoney } from "@atiende/ui";
import { horaEsMx } from "../../../lib/formato-fecha.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { fetchConocimientoAuto } from "../lib/ajustes-agente-client.ts";
import type { ConocimientoAutoVista } from "../lib/ajustes-agente-client.ts";

type Estado =
  | { readonly fase: "cargando" }
  | { readonly fase: "listo"; readonly datos: ConocimientoAutoVista }
  | { readonly fase: "no_disponible" }
  | { readonly fase: "error"; readonly mensaje: string };

const ETIQUETA_OMITIDO: Readonly<Record<string, string>> = { ventas: "Ventas", personal: "Personal" };

function hora(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? "—" : horaEsMx(iso);
}

export interface ConocimientoAutoProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function ConocimientoAuto({ apiBaseUrl, token, propertyId }: ConocimientoAutoProps) {
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
        setEstado(err instanceof VozNoDisponibleError ? { fase: "no_disponible" } : { fase: "error", mensaje: err instanceof Error ? err.message : "No se pudo generar el conocimiento del agente." });
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
            <CardTitle>Conocimiento automático</CardTitle>
            <CardDescription>Documentos generados de los datos de tu cuenta. Al cambiar un precio, un horario o una colonia, el documento cambia solo.</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={reintentar} disabled={estado.fase === "cargando"}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.75} />
            Volver a generar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {estado.fase === "cargando" ? <EstadoCargando etiqueta="Generando los documentos…" /> : null}
        {estado.fase === "error" ? <EstadoError mensaje={estado.mensaje} onReintentar={reintentar} /> : null}
        {estado.fase === "no_disponible" ? (
          <p role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            No disponible aún en este despliegue.
          </p>
        ) : null}
        {estado.fase === "listo" ? (
          <>
            <p className="text-xs text-muted-foreground" data-testid="conocimiento-nota">
              {estado.datos.nota} Generado a las {hora(estado.datos.generadoEn)} · huella <span className="font-mono">{estado.datos.huella.slice(0, 8)}</span>.
            </p>

            {estado.datos.alertasColonias.items.length > 0 ? (
              <Callout tone="warning" role="status" data-testid="alerta-colonias">
                <p className="font-medium">Colonias entre dos sucursales (a menos de {estado.datos.alertasColonias.umbralKm} km de diferencia)</p>
                <ul className="mt-1 list-disc pl-4">
                  {estado.datos.alertasColonias.items.map((a) => (
                    <li key={a.colonia}>
                      {a.colonia}: {a.sucursales[0]} o {a.sucursales[1]} ({formatMoney(a.diferenciaKm, 2)} km). El agente pregunta cuál le queda mejor al cliente.
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {estado.datos.alertasColonias.sinSucursal > 0 ? (
              <Callout tone="info" role="status" data-testid="aviso-colonias-sin-sucursal">
                {estado.datos.alertasColonias.sinSucursal} colonias no se pudieron asignar porque ninguna sucursal activa tiene coordenadas. Agrégalas en Sucursales.
              </Callout>
            ) : null}

            <ul className="grid gap-2">
              {estado.datos.documentos.map((d) => (
                <li key={d.tipo} data-documento={d.tipo} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{d.titulo}</p>
                    {d.vacio ? (
                      <StatusBadge tone="neutral" dot={false}>Sin datos</StatusBadge>
                    ) : d.enPrompt ? (
                      <StatusBadge tone="success" dot={false}>En la instrucción de voz</StatusBadge>
                    ) : (
                      <StatusBadge tone="warning" dot={false}>Se consulta en vivo</StatusBadge>
                    )}
                  </div>
                  {d.vacio ? (
                    <p className="mt-1 text-xs text-muted-foreground">{d.motivoVacio}</p>
                  ) : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {formatMoney(d.caracteres, 0)} caracteres · huella <span className="font-mono">{d.huella.slice(0, 8)}</span>
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs text-foreground">{d.contenido}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>

            <p className="text-xs text-muted-foreground" data-testid="conocimiento-tope">
              La instrucción de voz usa {formatMoney(estado.datos.prompt.caracteresUsados, 0)} de {formatMoney(estado.datos.prompt.topeCaracteres, 0)} caracteres. Un documento que no cabe entero no se corta: el agente lo consulta en vivo con sus herramientas.
            </p>

            <div data-testid="documentos-omitidos">
              <p className="text-sm font-medium text-foreground mb-1">No se generan</p>
              <ul className="space-y-1.5">
                {estado.datos.documentosOmitidos.map((o) => (
                  <li key={o.tipo} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{ETIQUETA_OMITIDO[o.tipo] ?? o.tipo}:</span> {o.motivo}
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
