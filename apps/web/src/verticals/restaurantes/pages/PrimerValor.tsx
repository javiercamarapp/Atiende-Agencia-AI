// «Tu restaurante listo en 30 minutos»: los pasos minimos para que la sucursal actual atienda su primer pedido por WhatsApp (menu,
// horario, zonas, metodos de pago, prueba del agente y activacion), con lo que falta y los minutos estimados. Todo lo calcula el
// servidor con datos reales (GET .../admin/primer-valor); confirmar metodos de pago y activar llaman a endpoints reales. La activacion
// la valida la base (0071): si faltan pasos obligatorios responde cuales.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, PageContainer, StatusBadge, notify } from "@atiende/ui";
import { activarSucursal, confirmarMetodosPago, fetchPrimerValor, type EstadoPasoPrimerValor, type PrimerValor } from "../lib/primer-valor-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const TONO: Record<EstadoPasoPrimerValor, "success" | "warning" | "neutral"> = { hecho: "success", pendiente: "warning", no_disponible: "neutral" };
const ETIQUETA: Record<EstadoPasoPrimerValor, string> = { hecho: "Listo", pendiente: "Pendiente", no_disponible: "No disponible aún" };

export function RestaurantesPrimerValorPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const [estado, setEstado] = useState<PrimerValor | "cargando" | { error: string }>("cargando");
  const [trabajando, setTrabajando] = useState<"pago" | "activar" | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setEstado("cargando");
    fetchPrimerValor(fetch, apiBaseUrl, token, propertyId)
      .then(setEstado)
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No se pudo cargar el avance." }));
  }, [apiBaseUrl, token, propertyId]);
  useEffect(cargar, [cargar]);

  async function accion(tipo: "pago" | "activar") {
    setTrabajando(tipo);
    setErrorAccion(null);
    try {
      if (tipo === "pago") await confirmarMetodosPago(fetch, apiBaseUrl, token, propertyId);
      else {
        await activarSucursal(fetch, apiBaseUrl, token, orgSlug, propertyId);
        notify.success("Sucursal activa: ya recibe pedidos.");
      }
      cargar();
    } catch (e) {
      setErrorAccion(e instanceof Error ? e.message : "No se pudo completar.");
    } finally {
      setTrabajando(null);
    }
  }

  const pv = typeof estado === "object" && "pasos" in estado ? estado : null;
  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Tu restaurante listo en 30 minutos</h1>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={cargar} disabled={estado === "cargando"}>
          <RefreshCw />
          Actualizar
        </Button>
      </div>
      {estado === "cargando" && <EstadoCargando etiqueta="Revisando tu sucursal…" />}
      {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}
      {pv && (
        <>
          <Callout tone={pv.listo ? "success" : "info"} titulo={pv.listo ? "¡Listo! Tu sucursal ya atiende por WhatsApp" : `${pv.sucursal.nombre}: ${pv.hechos} de ${pv.pasos.length} pasos`}>
            {pv.listo
              ? "Comparte tu número de WhatsApp con tus clientes. El resto de la configuración está en Primeros pasos."
              : `Te faltan unos ${pv.minutosRestantes} minutos para recibir tu primer pedido.`}{" "}
            <Link className="underline underline-offset-2" to={`/restaurantes/${orgSlug}/primeros-pasos`}>
              Ver todos los primeros pasos
            </Link>
          </Callout>
          {errorAccion && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {errorAccion}
            </p>
          )}
          <ol className="flex flex-col gap-2" data-testid="primer-valor-pasos">
            {pv.pasos.map((p, i) => (
              <li key={p.id}>
                <Card>
                  <CardContent className="flex flex-col gap-1.5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="m-0 text-sm font-medium text-foreground">
                        {i + 1}. {p.titulo}
                        {p.estado !== "hecho" && <span className="ml-1.5 text-xs font-normal text-muted-foreground">~{p.minutos} min</span>}
                      </p>
                      <StatusBadge tone={TONO[p.estado]}>{ETIQUETA[p.estado]}</StatusBadge>
                    </div>
                    <p className="m-0 text-xs text-muted-foreground">{p.detalle}</p>
                    {p.estado === "pendiente" && p.pantalla && (
                      <Link className="text-xs underline underline-offset-2" to={`/restaurantes/${orgSlug}/${p.pantalla}`}>
                        Ir a la pantalla
                      </Link>
                    )}
                    {p.estado === "pendiente" && p.id === "metodos_pago" && (
                      <div>
                        <Button type="button" size="sm" variant="outline" onClick={() => void accion("pago")} loading={trabajando === "pago"} disabled={trabajando !== null}>
                          Confirmo: efectivo y tarjeta con terminal
                        </Button>
                      </div>
                    )}
                    {p.estado === "pendiente" && p.id === "activar" && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" onClick={() => void accion("activar")} loading={trabajando === "activar"} disabled={trabajando !== null || !pv.puedeActivar}>
                          Activar sucursal
                        </Button>
                        {!pv.puedeActivar && <span className="text-xs text-muted-foreground">Primero completa menú, horario y zonas.</span>}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </>
      )}
    </PageContainer>
  );
}
