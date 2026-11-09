// R-15 -- pestanas "Historial del dia" y "Mi perfil" del panel del repartidor (Repartidor.tsx). Cada pestana carga SOLO cuando se abre
// (la primera pestana, "Mis pedidos", no cambia) y llama a endpoints reales: GET .../repartidor/historial-dia, GET|PUT .../repartidor/perfil.
// Estados honestos: cargando, error con reintento, vacio ("Sin entregas hoy") y "no disponible aun" cuando la base no tiene la migracion 044.
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, StatCard, StatusBadge, formatMoney, notify, useT } from "@atiende/ui";
import { restaurantesChofer } from "@atiende/ui/i18n/restaurantes/chofer";
import { Banknote, CircleCheck, CreditCard } from "lucide-react";
import { horaEsMx } from "../../../lib/formato-fecha.ts";
import { fetchHistorialDia, fetchMiPerfil, formDesdePerfil, guardarMiPerfil, validarPerfilForm, PERFIL_FORM_VACIO } from "../lib/repartidor-perfil-client.ts";
import type { HistorialDia, PerfilForm, PerfilFormErrores, PerfilRespuesta } from "../lib/repartidor-perfil-client.ts";
import { formatoDia, formatoMxn } from "../voz/formato-kpi.ts";
import { AlertaLicencia, PerfilRepartidorCampos } from "./PerfilRepartidorCampos.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl?: typeof fetch;
}

type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "listo"; readonly datos: T } | { readonly estado: "error"; readonly mensaje: string };

export function HistorialDiaTab({ apiBaseUrl, token, propertyId, fetchImpl }: Props) {
  const [carga, setCarga] = useState<Carga<HistorialDia>>({ estado: "cargando" });
  const t = useT(restaurantesChofer);
  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    try {
      setCarga({ estado: "listo", datos: await fetchHistorialDia(fetchImpl ?? fetch, apiBaseUrl, token, propertyId) });
    } catch (err) {
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : t("restaurantes.chofer.historial.error") });
    }
  }, [apiBaseUrl, token, propertyId, fetchImpl, t]);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (carga.estado === "cargando") return <EstadoCargando etiqueta={t("restaurantes.chofer.historial.cargando")} />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  const { fecha, zonaHoraria, entregas, totales } = carga.datos;
  return (
    <div className="flex flex-col gap-3" data-testid="repartidor-historial-dia">
      <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.chofer.historial.encabezado", { fecha: formatoDia(fecha) })}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <StatCard icon={CircleCheck} label={t("restaurantes.chofer.historial.entregados")} value={String(totales.pedidos)} nota={t("restaurantes.chofer.historial.total", { monto: formatoMxn(totales.totalCentavos) })} />
        <StatCard
          icon={Banknote}
          label={t("restaurantes.chofer.historial.efectivo")}
          value={formatoMxn(totales.efectivoCentavos)}
          nota={t("restaurantes.chofer.historial.efectivoPedidos", { count: totales.efectivoPedidos })}
        />
        <StatCard icon={CreditCard} label={t("restaurantes.chofer.historial.tarjeta")} value={formatoMxn(totales.tarjetaCentavos)} nota={t("restaurantes.chofer.historial.tarjetaNota")} />
      </div>
      {totales.sinMetodoPedidos > 0 && (
        <Callout tone="warning" titulo={t("restaurantes.chofer.historial.sinMetodoTitulo")}>
          {t("restaurantes.chofer.historial.sinMetodo", { count: totales.sinMetodoPedidos })}
        </Callout>
      )}
      {entregas.length === 0 ? (
        <EstadoVacio mensaje={t("restaurantes.chofer.historial.vacio")} />
      ) : (
        <div className="flex flex-col gap-2">
          {entregas.map((e) => (
            <Card key={e.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <p className="m-0 text-sm font-semibold text-foreground">{e.customerName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{e.deliveredAt ? t("restaurantes.chofer.historial.entregadoA", { hora: horaEsMx(e.deliveredAt, zonaHoraria) }) : t("restaurantes.chofer.historial.entregado")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={e.paymentMethod === "efectivo" ? "warning" : e.paymentMethod === "tarjeta" ? "success" : "neutral"} dot={false}>
                    {e.paymentMethod === "efectivo" ? t("restaurantes.chofer.historial.pago.efectivo") : e.paymentMethod === "tarjeta" ? t("restaurantes.chofer.historial.pago.tarjeta") : t("restaurantes.chofer.historial.pago.sinMetodo")}
                  </StatusBadge>
                  <span className="text-sm font-semibold tabular-nums text-foreground">${formatMoney(e.total)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function MiPerfilTab({ apiBaseUrl, token, propertyId, fetchImpl }: Props) {
  const [carga, setCarga] = useState<Carga<PerfilRespuesta>>({ estado: "cargando" });
  const [form, setForm] = useState<PerfilForm>({ ...PERFIL_FORM_VACIO });
  const [errores, setErrores] = useState<PerfilFormErrores>({});
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const t = useT(restaurantesChofer);

  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    try {
      const r = await fetchMiPerfil(fetchImpl ?? fetch, apiBaseUrl, token, propertyId);
      setCarga({ estado: "listo", datos: r });
      setForm(formDesdePerfil(r.perfil));
    } catch (err) {
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : t("restaurantes.chofer.perfil.errorCarga") });
    }
  }, [apiBaseUrl, token, propertyId, fetchImpl, t]);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar() {
    const e = validarPerfilForm(form);
    setErrores(e);
    if (Object.keys(e).length > 0) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const r = await guardarMiPerfil(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, form);
      setCarga({ estado: "listo", datos: r });
      setForm(formDesdePerfil(r.perfil));
      notify.success(t("restaurantes.chofer.perfil.guardado"));
    } catch (err) {
      setErrorGuardar(err instanceof Error ? err.message : t("restaurantes.chofer.perfil.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  if (carga.estado === "cargando") return <EstadoCargando etiqueta={t("restaurantes.chofer.perfil.cargando")} />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  if (!carga.datos.disponible) {
    return (
      <Callout tone="info" titulo={t("restaurantes.chofer.perfil.noDisponibleTitulo")}>
        {t("restaurantes.chofer.perfil.noDisponible")}
      </Callout>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="repartidor-mi-perfil"
      onSubmit={(ev) => {
        ev.preventDefault();
        void guardar();
      }}
    >
      <AlertaLicencia perfil={carga.datos.perfil} persona="propia" />
      {errorGuardar && <Callout tone="danger">{errorGuardar}</Callout>}
      <Card>
        <CardContent className="p-3">
          <PerfilRepartidorCampos valor={form} errores={errores} deshabilitado={guardando} onCambio={(campo, texto) => setForm((f) => ({ ...f, [campo]: texto }))} />
        </CardContent>
      </Card>
      <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.chofer.perfil.privacidad")}</p>
      <Button type="submit" loading={guardando} className="self-start">
        {t("restaurantes.chofer.perfil.guardar")}
      </Button>
    </form>
  );
}
