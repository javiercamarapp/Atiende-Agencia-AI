// Ajustes del agente de restaurantes (owner/admin): el equivalente, sobre la arquitectura vigente (gateway LLM + Gemini Live), de lo que el original dejaba
// ajustar en ElevenLabs. Todo control llama a un endpoint real (contrato: lib/ajustes-agente-client.ts) y dice DONDE aplica hoy:
//   * modelo y temperatura del agente de WhatsApp: aplican en el siguiente mensaje;
//   * temperatura y ritmo/estilo de habla de la voz: aplican en la vista previa; en llamadas reales cuando se despliegue el servicio de llamadas;
//   * modelo de la cascada de voz, ambiente de restaurante, tecleo y naturalidad: se guardan y viajan al worker con el contexto de la llamada; la vista previa del panel todavia no
//     reproduce el ambiente ni el tecleo y la pantalla lo dice ("No disponible aún"); el preset 'restaurante-humano' solo RELLENA el borrador (se guarda con el boton);
//   * clonacion de voz: no se construye (Gemini no clona): estado honesto.
// La voz, el saludo por sucursal y el conocimiento automatico viven aqui mismo como secciones propias.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Selector, PageContainer, RadioSegmentado, StatusBadge, Switch, formatMoney, useT } from "@atiende/ui";
import { restaurantesAjustesAgente } from "@atiende/ui/i18n/restaurantes/ajustesAgente";
import { fechaCortaEsMx } from "../../../lib/formato-fecha.ts";
import { fetchAjustesAgente, guardarAjustesAgente } from "../lib/ajustes-agente-client.ts";
import type { AjustesAgente, AjustesAgenteVista, ModeloAgenteVista } from "../lib/ajustes-agente-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { ESTILOS, NIVELES_FONDO, NIVELES_TECLEO, PASOS_TEMPERATURA, PRESETS_AMBIENTE, RITMOS, ajustesIguales, costoPorMil, etiquetaNivel, pasoDeTemperatura, rotuloTemperatura, temperaturaDePaso } from "../voz/formato-ajustes.ts";
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
  const t = useT(restaurantesAjustesAgente);
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
        if (!cancelado) setCarga(desdeError(err, t("restaurantes.ajustesAgente.error.cargar")));
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
  // Las columnas de la migracion 087 (ambiente con presets, tecleo y naturalidad) pueden faltar aunque la 055 este aplicada.
  const ambienteListo = servicioListo && vista?.ambienteDisponible === true;
  const presetHumano = vista?.presetHumano ?? null;

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

  function aplicarPresetHumano() {
    if (!presetHumano) return;
    cambiar({
      vozRitmo: presetHumano.ritmo,
      vozEstilo: presetHumano.estilo,
      vozTemperatura: presetHumano.temperatura,
      vozFondoActivo: presetHumano.fondo.activo,
      vozFondoVolumen: presetHumano.fondo.volumen,
      vozFondoPreset: presetHumano.fondo.preset,
      vozTecleoActivo: presetHumano.tecleo.activo,
      vozTecleoVolumen: presetHumano.tecleo.volumen,
      vozHumanizar: presetHumano.humanizar,
    });
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
      setErrorGuardado(err instanceof Error ? err.message : t("restaurantes.ajustesAgente.error.guardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PageContainer padding="none">
      <div>
        <h1 className="sr-only">{t("restaurantes.ajustesAgente.titulo")}</h1>
        <p className="text-ui text-muted-foreground">{t("restaurantes.ajustesAgente.subtitulo")}</p>
      </div>

      {carga.estado === "cargando" ? <EstadoCargando etiqueta={t("restaurantes.ajustesAgente.cargando")} /> : null}
      {carga.estado === "error" ? <EstadoError mensaje={carga.mensaje} onReintentar={reintentar} /> : null}
      {carga.estado === "no_disponible" ? (
        <p role="status" data-testid="ajustes-no-disponible" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("restaurantes.ajustesAgente.noDisponible")}
        </p>
      ) : null}

      {vista && borrador ? (
        <>
          {!vista.disponible ? (
            <Callout tone="info" role="status" data-testid="ajustes-sin-migrar">
              {t("restaurantes.ajustesAgente.sinMigrar")}
            </Callout>
          ) : null}

          <Card data-testid="seccion-whatsapp">
            <CardHeader className="p-4 pb-2">
              <CardTitle>{t("restaurantes.ajustesAgente.whatsapp.titulo")}</CardTitle>
              <CardDescription>
                {t("restaurantes.ajustesAgente.whatsapp.descripcion")} <span data-testid="aplica-whatsapp">{t("restaurantes.ajustesAgente.aplica", { cuando: vista.aplicaEn.whatsappModeloYTemperatura === "ahora" ? t("restaurantes.ajustesAgente.aplica.siguienteMensaje") : vista.aplicaEn.whatsappModeloYTemperatura })}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div>
                <label htmlFor="ajustes-modelo-whatsapp" className="block text-sm font-medium text-foreground mb-1.5">
                  {t("restaurantes.ajustesAgente.modelo")}
                </label>
                <Selector id="ajustes-modelo-whatsapp" value={borrador.whatsappModelo ?? ""} disabled={!servicioListo} onChange={(e) => cambiar({ whatsappModelo: e.target.value === "" ? null : e.target.value })}>
                  <option value="">{t("restaurantes.ajustesAgente.predeterminado")}{modeloPlataforma ? ` (${modeloPlataforma.etiqueta})` : ""}</option>
                  {vista.modelos.map((m) => (
                    <option key={m.id} value={m.id}>
                      {etiquetaOpcionModelo(m, "whatsapp")}
                    </option>
                  ))}
                </Selector>
                {modeloWhatsapp ? (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="costo-whatsapp">
                    {modeloWhatsapp.descripcion} {t("restaurantes.ajustesAgente.costoEstimado", { costo: costoPorMil(modeloWhatsapp.costoWhatsappMicroUsdPorMensaje, "mensajes") })}
                    {modeloWhatsapp.precioVerificadoEn ? t("restaurantes.ajustesAgente.precioVerificado", { fecha: fechaCorta(modeloWhatsapp.precioVerificadoEn) }) : ""}.
                  </p>
                ) : null}
                <p className="mt-1 text-2xs text-muted-foreground" data-testid="supuestos-costo">
                  <Info aria-hidden="true" className="mr-1 inline size-3 align-[-2px]" strokeWidth={1.75} />
                  {t("restaurantes.ajustesAgente.supuesto", { entrada: formatMoney(vista.supuestosCosto.whatsappMensaje.tokensEntrada, 0), salida: formatMoney(vista.supuestosCosto.whatsappMensaje.tokensSalida, 0) })} {vista.supuestosCosto.nota} {t("restaurantes.ajustesAgente.respaldo")}
                </p>
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.temperatura")}</p>
                {modeloWhatsapp && !modeloWhatsapp.aceptaTemperatura ? (
                  <p data-testid="sin-temperatura-whatsapp" className="text-xs text-muted-foreground">
                    {t("restaurantes.ajustesAgente.sinTemperatura", { modelo: modeloWhatsapp.etiqueta })}
                  </p>
                ) : (
                  <SelectorTemperatura nombre="ajustes-temperatura-whatsapp" etiqueta={t("restaurantes.ajustesAgente.temperaturaWhatsapp")} valor={borrador.whatsappTemperatura} deshabilitado={!servicioListo} onCambio={(t) => cambiar({ whatsappTemperatura: t })} />
                )}
              </div>
            </CardContent>
          </Card>

          {presetHumano ? (
            <Card data-testid="seccion-preset-humano">
              <CardHeader className="p-4 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{t("restaurantes.ajustesAgente.preset.titulo")}</CardTitle>
                  {!ambienteListo ? (
                    <StatusBadge tone="neutral" dot={false}>
                      {t("restaurantes.ajustesAgente.noDisponibleAun")}
                    </StatusBadge>
                  ) : null}
                </div>
                <CardDescription>{t("restaurantes.ajustesAgente.preset.descripcion")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-4 pt-0">
                {!ambienteListo ? (
                  <p role="status" data-testid="preset-no-disponible" className="text-xs text-muted-foreground">
                    {t("restaurantes.ajustesAgente.preset.noDisponible")}
                  </p>
                ) : null}
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground" data-testid="preset-valores">
                  <li>
                    {t("restaurantes.ajustesAgente.preset.ritmo", {
                      ritmo: RITMOS.find((r) => r.id === presetHumano.ritmo)?.rotulo ?? presetHumano.ritmo,
                      estilo: ESTILOS.find((e) => e.id === presetHumano.estilo)?.rotulo ?? presetHumano.estilo,
                      temperatura: presetHumano.temperatura.toFixed(1),
                    })}
                  </li>
                  <li>
                    {t("restaurantes.ajustesAgente.preset.ambiente", {
                      ambiente: PRESETS_AMBIENTE.find((p) => p.id === presetHumano.fondo.preset)?.rotulo ?? presetHumano.fondo.preset,
                      fondo: String(presetHumano.fondo.volumen),
                      tecleo: String(presetHumano.tecleo.volumen),
                    })}
                  </li>
                  <li>{t("restaurantes.ajustesAgente.preset.naturalidad")}</li>
                </ul>
                <div data-testid="preset-voces">
                  <p className="text-sm font-medium text-foreground mb-1">{t("restaurantes.ajustesAgente.preset.vozSugerida")}</p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {[presetHumano.voz.principal, ...presetHumano.voz.alternativas].map((v, i) => (
                      <li key={v}>
                        <span className="font-medium text-foreground">{v}</span> · {presetHumano.voz.descripciones[v] ?? "—"}
                        {t(i === 0 ? "restaurantes.ajustesAgente.preset.sugerida" : "restaurantes.ajustesAgente.preset.alternativa")}
                      </li>
                    ))}
                  </ul>
                </div>
                {presetHumano.vozPorMotor ? (
                  <p className="text-xs text-muted-foreground" data-testid="preset-voz-motores">
                    {t("restaurantes.ajustesAgente.preset.porMotor", { gemini: presetHumano.vozPorMotor["gemini-live"].principal, cascada: presetHumano.vozPorMotor.cascada.principal })}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground" data-testid="preset-acento">
                  {presetHumano.acento}
                </p>
                <div>
                  <Button type="button" variant="outline" onClick={aplicarPresetHumano} disabled={!ambienteListo}>
                    {t("restaurantes.ajustesAgente.preset.aplicar")}
                  </Button>
                  <p className="mt-1.5 text-2xs text-muted-foreground">{t("restaurantes.ajustesAgente.preset.aplicarNota")}</p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card data-testid="seccion-voz">
            <CardHeader className="p-4 pb-2">
              <CardTitle>{t("restaurantes.ajustesAgente.voz.titulo")}</CardTitle>
              <CardDescription>{t("restaurantes.ajustesAgente.voz.motor", { principal: vista.escaleraVoz.principal, respaldo: vista.escaleraVoz.respaldo })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.voz.temperatura")}</p>
                <SelectorTemperatura nombre="ajustes-temperatura-voz" etiqueta={t("restaurantes.ajustesAgente.voz.temperatura")} valor={borrador.vozTemperatura} deshabilitado={!servicioListo} onCambio={(t) => cambiar({ vozTemperatura: t })} />
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="aplica-voz-temperatura">
                  {t("restaurantes.ajustesAgente.voz.temperaturaNota", { cuando: vista.aplicaEn.vozTemperaturaYHabla })}
                </p>
                {vista.temperatura.maxLlamada !== undefined ? (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="temperatura-tope-llamada">
                    {t("restaurantes.ajustesAgente.voz.tope", { max: vista.temperatura.maxLlamada.toFixed(1) })}
                    {borrador.vozTemperatura !== null && borrador.vozTemperatura > vista.temperatura.maxLlamada
                      ? t("restaurantes.ajustesAgente.voz.topeExcede", { valor: borrador.vozTemperatura.toFixed(1), max: vista.temperatura.maxLlamada.toFixed(1) })
                      : t("restaurantes.ajustesAgente.voz.topeOk")}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.voz.ritmo")}</p>
                <RadioSegmentado name="ajustes-ritmo" label={t("restaurantes.ajustesAgente.voz.ritmo")} value={borrador.vozRitmo} disabled={!servicioListo} onChange={(r) => cambiar({ vozRitmo: r })} opciones={RITMOS.map((r) => ({ id: r.id, rotulo: r.rotulo }))} />
              </div>
              <div>
                <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.voz.estilo")}</p>
                <RadioSegmentado name="ajustes-estilo" label={t("restaurantes.ajustesAgente.voz.estilo")} value={borrador.vozEstilo} disabled={!servicioListo} onChange={(e) => cambiar({ vozEstilo: e })} opciones={ESTILOS.map((e) => ({ id: e.id, rotulo: e.rotulo }))} />
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="nota-habla">
                  {vista.habla.nota}
                </p>
              </div>
              <div>
                <label htmlFor="ajustes-modelo-cascada" className="block text-sm font-medium text-foreground mb-1.5">
                  {t("restaurantes.ajustesAgente.cascada")}
                </label>
                <Selector id="ajustes-modelo-cascada" value={borrador.vozModeloCascada ?? ""} disabled={!servicioListo} onChange={(e) => cambiar({ vozModeloCascada: e.target.value === "" ? null : e.target.value })}>
                  <option value="">{t("restaurantes.ajustesAgente.predeterminado")}{modeloPlataforma ? ` (${modeloPlataforma.etiqueta})` : ""}</option>
                  {/* Solo modelos con endpoint de retencion cero: la voz se enruta con ZDR y sin el cada turno fallaria (la API tambien lo valida). */}
                  {vista.modelos.filter((m) => m.vozZdr !== false).map((m) => (
                    <option key={m.id} value={m.id}>
                      {etiquetaOpcionModelo(m, "voz")}
                    </option>
                  ))}
                </Selector>
                {modeloCascada ? (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="costo-cascada">
                    {t("restaurantes.ajustesAgente.cascada.costo", {
                      modelo: modeloCascada.etiqueta,
                      costo: costoPorMil(modeloCascada.costoVozMicroUsdPorMinuto, "minutos"),
                      entrada: formatMoney(vista.supuestosCosto.vozCascadaMinuto.tokensEntrada, 0),
                      salida: formatMoney(vista.supuestosCosto.vozCascadaMinuto.tokensSalida, 0),
                    })}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground" data-testid="aplica-cascada">
                  {t("restaurantes.ajustesAgente.aplicaEn", { cuando: vista.aplicaEn.vozModeloCascada })}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="seccion-fondo">
            <CardHeader className="p-4 pb-2">
              <CardTitle>{t("restaurantes.ajustesAgente.fondo.titulo")}</CardTitle>
              <CardDescription>{t("restaurantes.ajustesAgente.fondo.descripcion")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div className="flex items-center gap-2">
                <Switch id="ajustes-fondo" checked={borrador.vozFondoActivo} disabled={!servicioListo} onCheckedChange={(v) => cambiar({ vozFondoActivo: v })} aria-label={t("restaurantes.ajustesAgente.fondo.activar")} />
                <label htmlFor="ajustes-fondo" className="text-sm text-foreground">
                  {t(borrador.vozFondoActivo ? "restaurantes.ajustesAgente.activado" : "restaurantes.ajustesAgente.apagado")}
                </label>
              </div>
              {borrador.vozFondoActivo ? (
                <div>
                  <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.fondo.volumen", { max: String(vista.fondo.volumenMax) })}</p>
                  <RadioSegmentado
                    name="ajustes-fondo-volumen"
                    label={t("restaurantes.ajustesAgente.fondo.volumenEtiqueta")}
                    value={String(borrador.vozFondoVolumen)}
                    disabled={!servicioListo}
                    onChange={(v) => cambiar({ vozFondoVolumen: Number(v) })}
                    opciones={(NIVELES_FONDO.includes(borrador.vozFondoVolumen) ? NIVELES_FONDO : [...NIVELES_FONDO, borrador.vozFondoVolumen].sort((a, b) => a - b)).map((n) => ({ id: String(n), rotulo: `${n} %` }))}
                  />
                </div>
              ) : null}
              {borrador.vozFondoActivo && vista.fondo.presets ? (
                <div>
                  <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.fondo.ambiente")}</p>
                  <RadioSegmentado name="ajustes-fondo-preset" label={t("restaurantes.ajustesAgente.fondo.ambienteEtiqueta")} value={borrador.vozFondoPreset} disabled={!ambienteListo} onChange={(p) => cambiar({ vozFondoPreset: p })} opciones={PRESETS_AMBIENTE.map((p) => ({ id: p.id, rotulo: p.rotulo }))} />
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="descripcion-preset-ambiente">
                    {vista.fondo.presets.find((p) => p.id === borrador.vozFondoPreset)?.descripcion ?? ""}
                  </p>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground" data-testid="aplica-fondo">
                {t("restaurantes.ajustesAgente.aplicaEn", { cuando: vista.aplicaEn.vozFondo })}
              </p>
            </CardContent>
          </Card>

          <Card data-testid="seccion-tecleo">
            <CardHeader className="p-4 pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t("restaurantes.ajustesAgente.tecleo.titulo")}</CardTitle>
                {!ambienteListo ? (
                  <StatusBadge tone="neutral" dot={false}>
                    {t("restaurantes.ajustesAgente.noDisponibleAun")}
                  </StatusBadge>
                ) : null}
              </div>
              <CardDescription>{t("restaurantes.ajustesAgente.tecleo.descripcion")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              {!ambienteListo ? (
                <p role="status" data-testid="tecleo-no-disponible" className="text-xs text-muted-foreground">
                  {t("restaurantes.ajustesAgente.tecleo.noDisponible")}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Switch id="ajustes-tecleo" checked={borrador.vozTecleoActivo} disabled={!ambienteListo} onCheckedChange={(v) => cambiar({ vozTecleoActivo: v })} aria-label={t("restaurantes.ajustesAgente.tecleo.activar")} />
                <label htmlFor="ajustes-tecleo" className="text-sm text-foreground">
                  {t("restaurantes.ajustesAgente.tecleo.estado", { estado: t(borrador.vozTecleoActivo ? "restaurantes.ajustesAgente.tecleo.activado" : "restaurantes.ajustesAgente.tecleo.apagado") })}
                </label>
              </div>
              {borrador.vozTecleoActivo ? (
                <div>
                  <p className="block text-sm font-medium text-foreground mb-1.5">{t("restaurantes.ajustesAgente.tecleo.volumen", { max: String(vista.tecleo?.volumenMax ?? 25) })}</p>
                  <RadioSegmentado
                    name="ajustes-tecleo-volumen"
                    label={t("restaurantes.ajustesAgente.tecleo.volumenEtiqueta")}
                    value={String(borrador.vozTecleoVolumen)}
                    disabled={!ambienteListo}
                    onChange={(v) => cambiar({ vozTecleoVolumen: Number(v) })}
                    opciones={(NIVELES_TECLEO.includes(borrador.vozTecleoVolumen) ? NIVELES_TECLEO : [...NIVELES_TECLEO, borrador.vozTecleoVolumen].sort((a, b) => a - b)).map((n) => ({ id: String(n), rotulo: `${n} %` }))}
                  />
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground" data-testid="nota-tecleo">
                {vista.tecleo?.nota ?? t("restaurantes.ajustesAgente.tecleo.notaPorOmision")} {t("restaurantes.ajustesAgente.aplicaEn", { cuando: vista.aplicaEn.vozTecleo ?? vista.aplicaEn.vozFondo })}
              </p>
              <div className="flex items-center gap-2">
                <Switch id="ajustes-humanizar" checked={borrador.vozHumanizar} disabled={!ambienteListo} onCheckedChange={(v) => cambiar({ vozHumanizar: v })} aria-label={t("restaurantes.ajustesAgente.humanizar.activar")} />
                <label htmlFor="ajustes-humanizar" className="text-sm text-foreground">
                  {t("restaurantes.ajustesAgente.humanizar.estado", { estado: t(borrador.vozHumanizar ? "restaurantes.ajustesAgente.humanizar.activada" : "restaurantes.ajustesAgente.humanizar.apagada") })}
                </label>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="nota-vista-previa-sonido">
                {t("restaurantes.ajustesAgente.vistaPreviaSonido")}
              </p>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void guardar()} disabled={!servicioListo || !sucio} loading={guardando}>
              {t("restaurantes.ajustesAgente.guardar")}
            </Button>
            {sucio ? <span className="text-xs text-muted-foreground">{t("restaurantes.ajustesAgente.sinGuardar")}</span> : null}
            {aviso && !sucio ? (
              <span role="status" className="text-xs text-primary">
                {t("restaurantes.ajustesAgente.guardados")}{vista.actualizadoEn ? ` (${fechaCorta(vista.actualizadoEn)})` : ""}.
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
                <CardTitle>{t("restaurantes.ajustesAgente.clonacion.titulo")}</CardTitle>
                <StatusBadge tone="neutral" dot={false}>
                  {t("restaurantes.ajustesAgente.clonacion.noDisponible")}
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
