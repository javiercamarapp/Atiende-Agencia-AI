// Ajustes del agente de restaurantes (owner/admin): el equivalente, sobre la arquitectura vigente (gateway LLM + Gemini Live), de lo que el original dejaba
// ajustar en ElevenLabs. Todo control llama a un endpoint real (contrato: lib/ajustes-agente-client.ts) y dice DONDE aplica hoy:
//   * modelo y temperatura del agente de WhatsApp: aplican en el siguiente mensaje;
//   * temperatura y ritmo/estilo de habla de la voz: aplican en la vista previa; en llamadas reales cuando se despliegue el servicio de llamadas;
//   * modelo de la cascada de voz y sonido de fondo: solo existen en llamadas reales (servicio de llamadas), asi que se guardan y se declara la dependencia;
//   * clonacion de voz: no se construye (Gemini no clona): estado honesto.
// La voz, el saludo por sucursal y el conocimiento automatico viven aqui mismo como secciones propias.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, NativeSelect, PageContainer, RadioSegmentado, StatusBadge, Switch, formatMoney } from "@atiende/ui";
import { fechaCortaEsMx } from "../../../lib/formato-fecha.ts";
import { fetchAjustesAgente, guardarAjustesAgente } from "../lib/ajustes-agente-client.ts";
import type { AjustesAgente, AjustesAgenteVista, ModeloAgenteVista } from "../lib/ajustes-agente-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { ESTILOS, NIVELES_FONDO, PASOS_TEMPERATURA, RITMOS, ajustesIguales, costoPorMil, etiquetaNivel, pasoDeTemperatura, rotuloTemperatura, temperaturaDePaso } from "../voz/formato-ajustes.ts";
import { ConocimientoAuto } from "../ajustes/ConocimientoAuto.tsx";
import { VozYSaludo } from "../ajustes/VozYSaludo.tsx";
import type { MuestraAudio } from "../voz/SelectorVoz.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export interface AjustesAgentePageProps extends RestaurantesShellContext {
  /** Solo para pruebas: reemplaza la reproduccion real de la muestra de voz. */
  readonly crearAudio?: (url: string) => MuestraAudio;
}

function etiquetaOpcionModelo(m: ModeloAgenteVista, unidad: "whatsapp" | "voz"): string {
  const costo = unidad === "whatsapp" ? costoPorMil(m.costoWhatsappMicroUsdPorMensaje, "mensajes") : costoPorMil(m.costoVozMicroUsdPorMinuto, "minutos");
  return `${m.etiqueta} · ${etiquetaNivel(m.nivel)} · ${costo}`;
}

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fechaCortaEsMx(d);
}

function SelectorTemperatura({ nombre, etiqueta, valor, onCambio, deshabilitado }: { nombre: string; etiqueta: string; valor: number | null; onCambio: (t: number | null) => void; deshabilitado?: boolean }) {
  const actual = pasoDeTemperatura(valor);
  const pasos = PASOS_TEMPERATURA.includes(actual) ? PASOS_TEMPERATURA : [...PASOS_TEMPERATURA, actual];
  return (
    <RadioSegmentado
      name={nombre}
      label={etiqueta}
      value={actual}
      disabled={deshabilitado === true}
      onChange={(paso) => onCambio(temperaturaDePaso(paso))}
      opciones={pasos.map((p) => ({ id: p, rotulo: rotuloTemperatura(p) }))}
    />
  );
}

export function AjustesAgentePage({ apiBaseUrl, token, propertyId, crearAudio }: AjustesAgentePageProps) {
  const [carga, setCarga] = useState<Carga<AjustesAgenteVista>>({ estado: "cargando" });
  const [guardado, setGuardado] = useState<AjustesAgente | null>(null);
  const [borrador, setBorrador] = useState<AjustesAgente | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [aviso, setAviso] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setCarga({ estado: "cargando" });
    (async () => {
      try {
        const v = await fetchAjustesAgente(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setCarga({ estado: "listo", datos: v });
        setGuardado(v.ajustes);
        setBorrador(v.ajustes);
      } catch (err) {
        if (!cancelado) setCarga(desdeError(err, "No se pudieron cargar los ajustes del agente."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  const reintentar = useCallback(() => setVersion((v) => v + 1), []);
  const vista = carga.estado === "listo" ? carga.datos : null;
  const sucio = borrador !== null && guardado !== null && !ajustesIguales(borrador, guardado);
  const servicioListo = vista?.disponible === true;

  const modeloPlataforma = vista?.modelos.find((m) => m.predeterminado) ?? null;
  const modeloWhatsapp = useMemo(() => (vista && borrador ? (vista.modelos.find((m) => m.id === borrador.whatsappModelo) ?? modeloPlataforma) : null), [vista, borrador, modeloPlataforma]);
  const modeloCascada = useMemo(() => (vista && borrador ? (vista.modelos.find((m) => m.id === borrador.vozModeloCascada) ?? modeloPlataforma) : null), [vista, borrador, modeloPlataforma]);

  function cambiar(parche: Partial<AjustesAgente>) {
    if (!borrador || !vista) return;
    const siguiente = { ...borrador, ...parche };
    // Un modelo que no admite temperatura no la conserva: el servidor lo rechazaria y la pantalla no ofrece un control que no hace nada.
    if ("whatsappModelo" in parche) {
      const m = vista.modelos.find((x) => x.id === siguiente.whatsappModelo) ?? modeloPlataforma;
      if (m && !m.aceptaTemperatura) siguiente.whatsappTemperatura = null;
    }
    setBorrador(siguiente);
    setAviso(false);
  }

  async function guardar() {
    if (!borrador || !servicioListo || guardando || !sucio) return;
    setGuardando(true);
    setErrorGuardado(null);
    setAviso(false);
    try {
      const v = await guardarAjustesAgente(fetch, apiBaseUrl, token, propertyId, borrador);
      setCarga({ estado: "listo", datos: v });
      setGuardado(v.ajustes);
      setBorrador(v.ajustes);
      setAviso(true);
    } catch (err) {
      setErrorGuardado(err instanceof Error ? err.message : "No se pudieron guardar los ajustes.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PageContainer padding="none">
      <div>
        <h1 className="sr-only">Ajustes del agente</h1>
        <p className="text-ui text-muted-foreground">Modelo, temperatura, voz, sonido de fondo y conocimiento del agente que atiende WhatsApp y las llamadas de tu restaurante.</p>
      </div>

      {carga.estado === "cargando" ? <EstadoCargando etiqueta="Cargando los ajustes del agente…" /> : null}
      {carga.estado === "error" ? <EstadoError mensaje={carga.mensaje} onReintentar={reintentar} /> : null}
      {carga.estado === "no_disponible" ? (
        <p role="status" data-testid="ajustes-no-disponible" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          No disponible aún: los ajustes del agente todavía no están activos en este despliegue.
        </p>
      ) : null}

      {vista && borrador ? (
        <>
          {!vista.disponible ? (
            <Callout tone="info" role="status" data-testid="ajustes-sin-migrar">
              Los ajustes todavía no están disponibles en esta base de datos: se muestran los valores de siempre y no se pueden guardar hasta que se active la migración 055.
            </Callout>
          ) : null}

          <Card data-testid="seccion-whatsapp">
            <CardHeader className="p-4 pb-2">
              <CardTitle>Agente de WhatsApp</CardTitle>
              <CardDescription>
                Modelo y temperatura del agente que contesta los mensajes. <span data-testid="aplica-whatsapp">Aplica {vista.aplicaEn.whatsappModeloYTemperatura === "ahora" ? "desde el siguiente mensaje" : vista.aplicaEn.whatsappModeloYTemperatura}.</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div>
                <label htmlFor="ajustes-modelo-whatsapp" className="block text-sm font-medium text-foreground mb-1.5">
                  Modelo
                </label>
                <NativeSelect id="ajustes-modelo-whatsapp" value={borrador.whatsappModelo ?? ""} disabled={!servicioListo} onChange={(e) => cambiar({ whatsappModelo: e.target.value === "" ? null : e.target.value })}>
                  <option value="">Predeterminado de la plataforma{modeloPlataforma ? ` (${modeloPlataforma.etiqueta})` : ""}</option>
                  {vista.modelos.map((m) => (
                    <option key={m.id} value={m.id}>
                      {etiquetaOpcionModelo(m, "whatsapp")}
                    </option>
                  ))}
                </NativeSelect>
                {modeloWhatsapp ? (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="costo-whatsapp">
                    {modeloWhatsapp.descripcion} Costo estimado: {costoPorMil(modeloWhatsapp.costoWhatsappMicroUsdPorMensaje, "mensajes")}
                    {modeloWhatsapp.precioVerificadoEn ? ` (precio de lista verificado el ${fechaCorta(modeloWhatsapp.precioVerificadoEn)})` : ""}.
                  </p>
                ) : null}
                <p className="mt-1 text-2xs text-muted-foreground" data-testid="supuestos-costo">
                  <Info aria-hidden="true" className="mr-1 inline size-3 align-[-2px]" strokeWidth={1.75} />
                  Supuesto: {formatMoney(vista.supuestosCosto.whatsappMensaje.tokensEntrada, 0)} tokens de entrada y {formatMoney(vista.supuestosCosto.whatsappMensaje.tokensSalida, 0)} de salida por mensaje. {vista.supuestosCosto.nota} Si el modelo falla, la plataforma cae sola al siguiente.
                </p>
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">Temperatura</p>
                {modeloWhatsapp && !modeloWhatsapp.aceptaTemperatura ? (
                  <p data-testid="sin-temperatura-whatsapp" className="text-xs text-muted-foreground">
                    {modeloWhatsapp.etiqueta} no admite temperatura: el agente usa un valor fijo (0) para que no improvise con precios ni cantidades. Elige otro modelo si quieres ajustarla.
                  </p>
                ) : (
                  <SelectorTemperatura nombre="ajustes-temperatura-whatsapp" etiqueta="Temperatura del agente de WhatsApp" valor={borrador.whatsappTemperatura} deshabilitado={!servicioListo} onCambio={(t) => cambiar({ whatsappTemperatura: t })} />
                )}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="seccion-voz">
            <CardHeader className="p-4 pb-2">
              <CardTitle>Voz (llamadas)</CardTitle>
              <CardDescription>
                Motor principal: {vista.escaleraVoz.principal}; respaldo automático: {vista.escaleraVoz.respaldo}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">Temperatura de la voz</p>
                <SelectorTemperatura nombre="ajustes-temperatura-voz" etiqueta="Temperatura de la voz" valor={borrador.vozTemperatura} deshabilitado={!servicioListo} onCambio={(t) => cambiar({ vozTemperatura: t })} />
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="aplica-voz-temperatura">
                  Es un parámetro real de Gemini Live. Aplica en {vista.aplicaEn.vozTemperaturaYHabla}.
                </p>
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">Ritmo de habla</p>
                <RadioSegmentado name="ajustes-ritmo" label="Ritmo de habla" value={borrador.vozRitmo} disabled={!servicioListo} onChange={(r) => cambiar({ vozRitmo: r })} opciones={RITMOS.map((r) => ({ id: r.id, rotulo: r.rotulo }))} />
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">Estilo de habla</p>
                <RadioSegmentado name="ajustes-estilo" label="Estilo de habla" value={borrador.vozEstilo} disabled={!servicioListo} onChange={(e) => cambiar({ vozEstilo: e })} opciones={ESTILOS.map((e) => ({ id: e.id, rotulo: e.rotulo }))} />
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="nota-habla">
                  {vista.habla.nota}
                </p>
              </div>
              <div>
                <label htmlFor="ajustes-modelo-cascada" className="block text-sm font-medium text-foreground mb-1.5">
                  Modelo de la cascada de respaldo
                </label>
                <NativeSelect id="ajustes-modelo-cascada" value={borrador.vozModeloCascada ?? ""} disabled={!servicioListo} onChange={(e) => cambiar({ vozModeloCascada: e.target.value === "" ? null : e.target.value })}>
                  <option value="">Predeterminado de la plataforma{modeloPlataforma ? ` (${modeloPlataforma.etiqueta})` : ""}</option>
                  {vista.modelos.map((m) => (
                    <option key={m.id} value={m.id}>
                      {etiquetaOpcionModelo(m, "voz")}
                    </option>
                  ))}
                </NativeSelect>
                {modeloCascada ? (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="costo-cascada">
                    Costo estimado de la cascada con {modeloCascada.etiqueta}: {costoPorMil(modeloCascada.costoVozMicroUsdPorMinuto, "minutos")} ({formatMoney(vista.supuestosCosto.vozCascadaMinuto.tokensEntrada, 0)} tokens de entrada y {formatMoney(vista.supuestosCosto.vozCascadaMinuto.tokensSalida, 0)} de salida por minuto).
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground" data-testid="aplica-cascada">
                  Aplica en {vista.aplicaEn.vozModeloCascada}.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="seccion-fondo">
            <CardHeader className="p-4 pb-2">
              <CardTitle>Sonido de fondo de restaurante</CardTitle>
              <CardDescription>Un murmullo suave de sala mezclado bajo la voz del agente en la llamada. Apagado por omisión.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div className="flex items-center gap-2">
                <Switch id="ajustes-fondo" checked={borrador.vozFondoActivo} disabled={!servicioListo} onCheckedChange={(v) => cambiar({ vozFondoActivo: v })} aria-label="Activar el sonido de fondo" />
                <label htmlFor="ajustes-fondo" className="text-sm text-foreground">
                  {borrador.vozFondoActivo ? "Activado" : "Apagado"}
                </label>
              </div>
              {borrador.vozFondoActivo ? (
                <div>
                  <p className="block text-sm font-medium text-foreground mb-1.5">Volumen (nunca pasa de {vista.fondo.volumenMax} % para no tapar la voz)</p>
                  <RadioSegmentado
                    name="ajustes-fondo-volumen"
                    label="Volumen del sonido de fondo"
                    value={String(borrador.vozFondoVolumen)}
                    disabled={!servicioListo}
                    onChange={(v) => cambiar({ vozFondoVolumen: Number(v) })}
                    opciones={(NIVELES_FONDO.includes(borrador.vozFondoVolumen) ? NIVELES_FONDO : [...NIVELES_FONDO, borrador.vozFondoVolumen].sort((a, b) => a - b)).map((n) => ({ id: String(n), rotulo: `${n} %` }))}
                  />
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground" data-testid="aplica-fondo">
                Aplica en {vista.aplicaEn.vozFondo}.
              </p>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void guardar()} disabled={!servicioListo || !sucio} loading={guardando}>
              Guardar ajustes
            </Button>
            {sucio ? <span className="text-xs text-muted-foreground">Hay cambios sin guardar.</span> : null}
            {aviso && !sucio ? (
              <span role="status" className="text-xs text-primary">
                Ajustes guardados{vista.actualizadoEn ? ` (${fechaCorta(vista.actualizadoEn)})` : ""}.
              </span>
            ) : null}
            {errorGuardado ? (
              <span role="alert" className="text-xs text-destructive">
                {errorGuardado}
              </span>
            ) : null}
          </div>

          <VozYSaludo apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} {...(crearAudio ? { crearAudio } : {})} />

          <ConocimientoAuto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />

          <Card data-testid="seccion-clonacion">
            <CardHeader className="p-4 pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Clonación de voz</CardTitle>
                <StatusBadge tone="neutral" dot={false}>
                  No disponible
                </StatusBadge>
              </div>
            </CardHeader>
            <CardContent className="space-y-1 p-4 pt-0 text-xs text-muted-foreground">
              <p data-testid="clonacion-motivo">{vista.clonacionDeVoz.motivo}</p>
              <p data-testid="clonacion-decision">{vista.clonacionDeVoz.decision}</p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageContainer>
  );
}
