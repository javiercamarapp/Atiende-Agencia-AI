// R-15 -- pestanas "Historial del dia" y "Mi perfil" del panel del repartidor (Repartidor.tsx). Cada pestana carga SOLO cuando se abre
// (la primera pestana, "Mis pedidos", no cambia) y llama a endpoints reales: GET .../repartidor/historial-dia, GET|PUT .../repartidor/perfil.
// Estados honestos: cargando, error con reintento, vacio ("Sin entregas hoy") y "no disponible aun" cuando la base no tiene la migracion 044.
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, StatCard, StatusBadge, formatMoney, notify } from "@atiende/ui";
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
  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    try {
      setCarga({ estado: "listo", datos: await fetchHistorialDia(fetchImpl ?? fetch, apiBaseUrl, token, propertyId) });
    } catch (err) {
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar el historial del día." });
    }
  }, [apiBaseUrl, token, propertyId, fetchImpl]);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (carga.estado === "cargando") return <EstadoCargando etiqueta="Cargando tus entregas de hoy…" />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  const { fecha, zonaHoraria, entregas, totales } = carga.datos;
  return (
    <div className="flex flex-col gap-3" data-testid="repartidor-historial-dia">
      <p className="m-0 text-xs text-muted-foreground">Entregas del {formatoDia(fecha)} (día completo en la zona horaria de la sucursal).</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <StatCard icon={CircleCheck} label="Entregados hoy" value={String(totales.pedidos)} nota={`Total ${formatoMxn(totales.totalCentavos)}`} />
        <StatCard
          icon={Banknote}
          label="Efectivo a rendir"
          value={formatoMxn(totales.efectivoCentavos)}
          nota={totales.efectivoPedidos === 0 ? "Ningún pedido pagado en efectivo" : totales.efectivoPedidos === 1 ? "1 pedido pagado en efectivo" : `${totales.efectivoPedidos} pedidos pagados en efectivo`}
        />
        <StatCard icon={CreditCard} label="Pagado con tarjeta" value={formatoMxn(totales.tarjetaCentavos)} nota="No se rinde: ya está cobrado" />
      </div>
      {totales.sinMetodoPedidos > 0 && (
        <Callout tone="warning" titulo="Hay pedidos sin método de pago registrado">
          {totales.sinMetodoPedidos} {totales.sinMetodoPedidos === 1 ? "pedido entregado hoy no tiene" : "pedidos entregados hoy no tienen"} método de pago registrado: no se suman al efectivo a rendir. Confírmalo con administración.
        </Callout>
      )}
      {entregas.length === 0 ? (
        <EstadoVacio mensaje="Todavía no has entregado ningún pedido hoy." />
      ) : (
        <div className="flex flex-col gap-2">
          {entregas.map((e) => (
            <Card key={e.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <p className="m-0 text-sm font-semibold text-foreground">{e.customerName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{e.deliveredAt ? `Entregado a las ${horaEsMx(e.deliveredAt, zonaHoraria)}` : "Entregado"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={e.paymentMethod === "efectivo" ? "warning" : e.paymentMethod === "tarjeta" ? "success" : "neutral"} dot={false}>
                    {e.paymentMethod === "efectivo" ? "Efectivo" : e.paymentMethod === "tarjeta" ? "Tarjeta" : "Sin método"}
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

  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    try {
      const r = await fetchMiPerfil(fetchImpl ?? fetch, apiBaseUrl, token, propertyId);
      setCarga({ estado: "listo", datos: r });
      setForm(formDesdePerfil(r.perfil));
    } catch (err) {
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar tu perfil." });
    }
  }, [apiBaseUrl, token, propertyId, fetchImpl]);
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
      notify.success("Perfil guardado.");
    } catch (err) {
      setErrorGuardar(err instanceof Error ? err.message : "No se pudo guardar tu perfil.");
    } finally {
      setGuardando(false);
    }
  }

  if (carga.estado === "cargando") return <EstadoCargando etiqueta="Cargando tu perfil…" />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  if (!carga.datos.disponible) {
    return (
      <Callout tone="info" titulo="Tu perfil aún no está disponible">
        No disponible aún: requiere la actualización de base de datos del perfil del repartidor (migración 044). Pide a administración que la aplique.
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
      <p className="m-0 text-xs text-muted-foreground">La licencia y el contacto de emergencia solo los ve administración (dueño y administradores), nunca el resto del equipo.</p>
      <Button type="submit" loading={guardando} className="self-start">
        Guardar perfil
      </Button>
    </form>
  );
}
