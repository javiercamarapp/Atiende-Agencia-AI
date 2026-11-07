// Nuevo pedido del encargado (captura por llamada, mostrador o WhatsApp manual). PLAN-PANEL-OPERADOR §5.4-B.
// Formulario rapido de movil: telefono (con busqueda de cliente), nombre, domicilio/recoger, productos, pago, total CALCULADO POR EL SERVIDOR
// (`cotizar`), y consentimiento de WhatsApp obligatorio y explicito. Privacidad: de un cliente existente solo se indica que existe y se muestran las COLONIAS guardadas
// (en llamadas no hay remitente que valide el numero): nombre y direccion completa los captura el encargado a mano, nunca se leen ni se precargan.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, EstadoCargando, EstadoError, FormField, Input, PageContainer, StatusBadge, Switch, Textarea, formatMoney, notify, useT } from "@atiende/ui";
import { restaurantesCaptura } from "@atiende/ui/i18n/restaurantes/captura";
import type { RespuestaCotizar, RespuestaCrearPedido } from "@atiende/domain-restaurantes/operacion";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Link } from "react-router-dom";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { ConsentimientoWhatsapp } from "../components/operacion/ConsentimientoWhatsapp.tsx";
import { SelectorProductos } from "../components/operacion/SelectorProductos.tsx";
import { fetchProducts } from "../lib/catalog-client.ts";
import type { Product } from "../lib/catalog-client.ts";
import { ETIQUETA_CANAL_CAPTURA, entradaCotizar, entradaCrear, faltantes, formularioVacio, normalizarTelefono, textoAviso } from "../lib/captura-pedido.ts";
import type { FormularioCaptura } from "../lib/captura-pedido.ts";
import { capturarPedido, cotizarPedido, ErrorOperacion, fetchClientePorTelefono, nuevaLlave } from "../lib/operacion-client.ts";
import { aplicarTemaAutomatico } from "../lib/tema-nocturno.ts";

const CANALES_CAPTURA = ["llamada", "mostrador", "whatsapp_manual"] as const;

function Opciones<T extends string>({ etiqueta, valor, opciones, alCambiar }: { readonly etiqueta: string; readonly valor: T; readonly opciones: readonly { readonly valor: T; readonly texto: string }[]; readonly alCambiar: (v: T) => void }) {
  return (
    <div role="group" aria-label={etiqueta} className="grid auto-cols-fr grid-flow-col gap-2">
      {opciones.map((o) => (
        <Button key={o.valor} type="button" className="h-12 text-base" variant={valor === o.valor ? "default" : "outline"} aria-pressed={valor === o.valor} onClick={() => alCambiar(o.valor)}>
          {o.texto}
        </Button>
      ))}
    </div>
  );
}

export function OperacionNuevoPedidoPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const t = useT(restaurantesCaptura);
  const [form, setForm] = useState<FormularioCaptura>(() => formularioVacio(propertyId));
  const [productos, setProductos] = useState<readonly Product[] | null>(null);
  const [errorProductos, setErrorProductos] = useState<string | null>(null);
  // Privacidad: de un cliente existente SOLO se conservan las colonias; ni su nombre ni el texto de su direccion se guardan, muestran o precargan.
  const [cliente, setCliente] = useState<{ readonly colonias: readonly string[] } | null>(null);
  const [busquedaFallo, setBusquedaFallo] = useState(false);
  const [cotizacion, setCotizacion] = useState<RespuestaCotizar | null>(null);
  const [errorCotizar, setErrorCotizar] = useState<string | null>(null);
  const [fueraCobertura, setFueraCobertura] = useState(false);
  const [cotizando, setCotizando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaCrearPedido | null>(null);
  const [duplicado, setDuplicado] = useState(false);
  const intento = useRef<{ cuerpo: string; llave: string } | null>(null);
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);

  useEffect(() => aplicarTemaAutomatico(), []);
  // El «Sí» al aviso por WhatsApp es de ESE numero y de ESA via: si cambia el telefono o como entro el pedido, la pregunta se vuelve a hacer.
  const cambiar = useCallback(
    (parche: Partial<FormularioCaptura>) =>
      setForm((f) => {
        const cambiaDestino = (parche.telefono !== undefined && parche.telefono !== f.telefono) || (parche.canalCaptura !== undefined && parche.canalCaptura !== f.canalCaptura);
        return { ...f, ...parche, ...(cambiaDestino && parche.consentimiento === undefined ? { consentimiento: null } : {}) };
      }),
    [],
  );

  const cargarProductos = useCallback(() => {
    setErrorProductos(null);
    fetchProducts(fetchImpl, apiBaseUrl, token, propertyId)
      .then(setProductos)
      .catch((e: unknown) => setErrorProductos(e instanceof Error ? e.message : t("restaurantes.captura.errorMenu")));
  }, [apiBaseUrl, fetchImpl, propertyId, token]);
  useEffect(() => cargarProductos(), [cargarProductos]);

  // Busqueda de cliente por telefono (solo se conservan nombre y colonias; ver cabecera).
  const telefonoE164 = normalizarTelefono(form.telefono);
  useEffect(() => {
    setCliente(null);
    setBusquedaFallo(false);
    if (!telefonoE164) return;
    let vigente = true;
    const id = window.setTimeout(() => {
      fetchClientePorTelefono(fetchImpl, apiBaseUrl, token, propertyId, telefonoE164)
        .then((r) => {
          if (!vigente) return;
          setCliente({ colonias: [...new Set(r.cliente.domicilios.map((d) => d.colonia).filter((c): c is string => !!c))] });
        })
        .catch((e: unknown) => {
          if (!vigente) return;
          if (!(e instanceof ErrorOperacion && e.status === 404)) setBusquedaFallo(true); // 404 = cliente nuevo, no es un fallo
        });
    }, 300);
    return () => {
      vigente = false;
      window.clearTimeout(id);
    };
  }, [apiBaseUrl, fetchImpl, propertyId, telefonoE164, token]);

  // Total: lo calcula el servidor. Se pide cuando el formulario ya es cotizable (con una pausa para no cotizar cada tecla).
  const entradaCot = useMemo(() => entradaCotizar(form), [form]);
  const claveCot = entradaCot ? JSON.stringify(entradaCot) : "";
  useEffect(() => {
    setCotizacion(null);
    setErrorCotizar(null);
    setFueraCobertura(false);
    if (!entradaCot) return;
    let vigente = true;
    setCotizando(true);
    const id = window.setTimeout(() => {
      cotizarPedido(fetchImpl, apiBaseUrl, token, propertyId, entradaCot, nuevaLlave())
        .then((r) => {
          if (!vigente) return;
          setCotizacion(r);
          setFueraCobertura(!r.cobertura.dentro);
        })
        .catch((e: unknown) => {
          if (!vigente) return;
          if (e instanceof ErrorOperacion && e.code === "fuera_de_cobertura") setFueraCobertura(true);
          setErrorCotizar(e instanceof Error ? e.message : t("restaurantes.captura.errorTotal"));
        })
        .finally(() => vigente && setCotizando(false));
    }, 500);
    return () => {
      vigente = false;
      window.clearTimeout(id);
      setCotizando(false);
    };
    // claveCot resume entradaCot: evita re-cotizar por cambios de identidad.
  }, [apiBaseUrl, claveCot, fetchImpl, propertyId, token]);

  const total = cotizacion?.cotizacion.total ?? null;
  const dentro = cotizacion ? cotizacion.cobertura.dentro : fueraCobertura ? false : null;
  const falta = faltantes(form, total, dentro);

  async function guardar(forzar = false) {
    const f = forzar ? { ...form, forzarDuplicado: true } : form;
    const cuerpo = entradaCrear(f);
    if (!cuerpo || enviando) return;
    const texto = JSON.stringify(cuerpo);
    // Una llave por intento: se reutiliza si el cuerpo es el mismo (reintento tras timeout) y cambia si algo cambio.
    if (intento.current?.cuerpo !== texto) intento.current = { cuerpo: texto, llave: nuevaLlave() };
    setEnviando(true);
    try {
      const r = await capturarPedido(fetchImpl, apiBaseUrl, token, propertyId, cuerpo, intento.current.llave);
      intento.current = null;
      setResultado(r);
      notify.success(t("restaurantes.captura.guardado", { numero: String(r.pedido.numero) }));
    } catch (e) {
      if (e instanceof ErrorOperacion && e.status === 409 && e.code === "pedido_duplicado_reciente") setDuplicado(true);
      else {
        if (e instanceof ErrorOperacion && e.status >= 400 && e.status < 500) intento.current = null;
        notify.error(e instanceof ErrorOperacion ? e.message : t("restaurantes.captura.errorSinRed"));
      }
    } finally {
      setEnviando(false);
    }
  }

  function reiniciar() {
    intento.current = null;
    setResultado(null);
    setCliente(null);
    setForm(formularioVacio(propertyId));
  }

  if (resultado) {
    const aviso = textoAviso(resultado.aviso);
    return (
      <PageContainer padding="none">
        <div className="mx-auto w-full max-w-2xl space-y-3 pb-6" role="status" data-testid="pedido-guardado">
          <h1 className="text-xl font-bold text-foreground">{t("restaurantes.captura.guardadoTitulo", { numero: String(resultado.pedido.numero) })}</h1>
          <p className="flex items-center gap-2 text-lg text-foreground">
            <CheckCircle2 className="size-5" aria-hidden="true" />
            {t("restaurantes.captura.guardadoTotal", { total: formatMoney(resultado.pedido.total), estado: t(resultado.pedido.estado === "pending" ? "restaurantes.captura.pendienteAceptar" : "restaurantes.captura.yaEnPreparacion") })}
          </p>
          <p className={`rounded-lg border-2 p-3 text-base ${resultado.aviso.estado === "omitido" ? "border-warning bg-warning-tint text-warning" : "border-border text-foreground"}`}>{aviso.charAt(0).toUpperCase() + aviso.slice(1)}.</p>
          <Button type="button" className="h-14 w-full text-lg" onClick={reiniciar}>
            {t("restaurantes.captura.capturarOtro")}
          </Button>
          <Button asChild variant="outline" className="h-14 w-full text-lg">
            <Link to={`/restaurantes/${orgSlug}/operacion`}>{t("restaurantes.captura.irCola")}</Link>
          </Button>
        </div>
      </PageContainer>
    );
  }

  const esDomicilio = form.canal === "domicilio";
  return (
    <PageContainer padding="none">
      <div className="mx-auto w-full max-w-3xl space-y-4 pb-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="sr-only">{t("restaurantes.captura.titulo")}</h1>
        </div>

        <FormField label={t("restaurantes.captura.comoEntro")}>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("restaurantes.captura.comoEntro")}>
            {CANALES_CAPTURA.map((c) => (
              <Button key={c} type="button" className="h-12 text-base" variant={form.canalCaptura === c ? "default" : "outline"} aria-pressed={form.canalCaptura === c} onClick={() => cambiar({ canalCaptura: c })}>
                {ETIQUETA_CANAL_CAPTURA[c]}
              </Button>
            ))}
          </div>
        </FormField>

        <FormField label={t("restaurantes.captura.telefono")} required hint={t("restaurantes.captura.telefonoAyuda")}>
          <Input type="tel" inputMode="tel" autoComplete="off" className="h-12 text-lg" value={form.telefono} onChange={(e) => cambiar({ telefono: e.target.value })} />
        </FormField>
        {cliente && (
          <div role="status" className="space-y-2 rounded-lg border border-border bg-card p-3 text-base" data-testid="cliente-existente">
            <p className="font-medium text-foreground">{t("restaurantes.captura.clienteExistente")}</p>
            <p className="text-muted-foreground">{t("restaurantes.captura.clienteExistenteAyuda")}</p>
            {cliente.colonias.length > 0 && (
              <>
                <p className="text-muted-foreground">{t("restaurantes.captura.colonias")}</p>
                <div className="flex flex-wrap gap-2">
                  {cliente.colonias.map((c) => (
                    <Button key={c} type="button" variant="outline" className="h-14" onClick={() => cambiar({ colonia: c })}>
                      {c}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {busquedaFallo && <p className="text-sm text-muted-foreground">{t("restaurantes.captura.busquedaFallo")}</p>}

        <FormField label={t("restaurantes.captura.nombre")} required>
          <Input autoComplete="off" className="h-12 text-lg" value={form.nombre} maxLength={120} onChange={(e) => cambiar({ nombre: e.target.value })} />
        </FormField>

        <Opciones etiqueta={t("restaurantes.captura.entrega")} valor={form.canal} opciones={[{ valor: "domicilio", texto: t("restaurantes.captura.domicilio") }, { valor: "recoger", texto: t("restaurantes.captura.recoger") }]} alCambiar={(canal) => cambiar({ canal })} />

        {esDomicilio && (
          <>
            <FormField label={t("restaurantes.captura.direccion")} required>
              <Input autoComplete="off" className="h-12 text-lg" value={form.direccion} maxLength={240} onChange={(e) => cambiar({ direccion: e.target.value })} />
            </FormField>
            <FormField label={t("restaurantes.captura.colonia")}>
              <Input autoComplete="off" className="h-12 text-lg" value={form.colonia} maxLength={120} onChange={(e) => cambiar({ colonia: e.target.value })} />
            </FormField>
            <FormField label={t("restaurantes.captura.indicaciones")} hint={t("restaurantes.captura.indicacionesAyuda")}>
              <Textarea rows={2} maxLength={240} className="text-base" value={form.indicaciones} onChange={(e) => cambiar({ indicaciones: e.target.value })} />
            </FormField>
          </>
        )}

        <section aria-label={t("restaurantes.captura.productos")} className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">{t("restaurantes.captura.productos")}</h2>
          {productos === null && errorProductos === null && <EstadoCargando variante="tarjeta" etiqueta={t("restaurantes.captura.cargandoMenu")} />}
          {errorProductos !== null && <EstadoError compacto mensaje={errorProductos} onReintentar={cargarProductos} />}
          {productos !== null && <SelectorProductos productos={productos} lineas={form.lineas} alCambiar={(lineas) => cambiar({ lineas })} />}
        </section>

        <section aria-label={t("restaurantes.captura.pago")} className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">{t("restaurantes.captura.pago")}</h2>
          <Opciones etiqueta={t("restaurantes.captura.formaPago")} valor={form.forma} opciones={[{ valor: "efectivo", texto: t("restaurantes.captura.efectivo") }, { valor: "tarjeta", texto: t("restaurantes.captura.tarjeta") }]} alCambiar={(forma) => cambiar({ forma })} />
          {form.forma === "efectivo" && (
            <FormField label={t("restaurantes.captura.pagaCon")} hint={t("restaurantes.captura.pagaConAyuda")}>
              <Input inputMode="decimal" className="h-12 text-lg" value={form.pagaCon} onChange={(e) => cambiar({ pagaCon: e.target.value.replace(/[^0-9.,]/g, "") })} />
            </FormField>
          )}
        </section>

        <div aria-live="polite" className="space-y-2" data-testid="resumen-total">
          {cotizando && <p className="text-base text-muted-foreground">{t("restaurantes.captura.calculando")}</p>}
          {cotizacion && (
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-2xl font-bold text-foreground">{t("restaurantes.captura.total", { total: formatMoney(cotizacion.cotizacion.total) })}</p>
              <p className="text-base text-muted-foreground">
                {t("restaurantes.captura.subtotal", { subtotal: formatMoney(cotizacion.cotizacion.subtotal) })}
                {cotizacion.cotizacion.envio > 0 ? t("restaurantes.captura.envio", { envio: formatMoney(cotizacion.cotizacion.envio) }) : ""}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-base text-foreground">
                <Clock className="size-4" aria-hidden="true" />
                {t("restaurantes.captura.tiempoEstimado", { min: String(cotizacion.cotizacion.tiempoEstimadoMin[0] ?? ""), max: String(cotizacion.cotizacion.tiempoEstimadoMin[1] ?? "") })}
              </p>
            </div>
          )}
          {fueraCobertura && (
            <div role="alert" className="rounded-lg border-2 border-destructive bg-destructive-tint p-3 text-base text-destructive">
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="size-5" aria-hidden="true" />
                {t("restaurantes.captura.fueraCobertura")}
              </p>
              <p>{t("restaurantes.captura.fueraCoberturaTexto")}</p>
              {cotizacion?.cobertura.sucursalAlterna && (
                <p>
                  {t("restaurantes.captura.sucursalAlterna", { nombre: cotizacion.cobertura.sucursalAlterna.nombre, telefono: cotizacion.cobertura.sucursalAlterna.telefono })}
                </p>
              )}
            </div>
          )}
          {errorCotizar && !fueraCobertura && <EstadoError compacto mensaje={errorCotizar} />}
        </div>

        <ConsentimientoWhatsapp valor={form.consentimiento} alCambiar={(consentimiento) => cambiar({ consentimiento })} />

        {/* Toda la fila es el objetivo tactil (>= 56 dp): el interruptor solo mide 24x40 px y el panel se usa con el pulgar. */}
        <label htmlFor="confirmar-ya" className="flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-base text-foreground">
          <span>{t("restaurantes.captura.confirmarYa")}</span>
          <Switch id="confirmar-ya" checked={form.confirmarYa} onCheckedChange={(confirmarYa) => cambiar({ confirmarYa })} />
        </label>

        <div className="sticky bottom-0 -mx-1 space-y-2 border-t border-border bg-background p-2">
          {falta.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="faltantes">
              <StatusBadge tone="warning" dot={false} className="mr-1.5 text-sm">
                {t("restaurantes.captura.falta")}
              </StatusBadge>
              {falta.join(" · ")}
            </p>
          )}
          <Button type="button" className="h-14 w-full text-lg" disabled={falta.length > 0 || enviando} loading={enviando} onClick={() => void guardar()}>
            {t(form.consentimiento === false ? "restaurantes.captura.guardarSinAviso" : "restaurantes.captura.guardarYAvisar")}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={duplicado}
        onOpenChange={setDuplicado}
        titulo={t("restaurantes.captura.repetidoTitulo")}
        descripcion={t("restaurantes.captura.repetidoTexto")}
        confirmar={t("restaurantes.captura.repetidoConfirmar")}
        cancelar={t("restaurantes.captura.repetidoCancelar")}

        onConfirm={async () => {
          setDuplicado(false);
          await guardar(true);
        }}
      />
    </PageContainer>
  );
}
