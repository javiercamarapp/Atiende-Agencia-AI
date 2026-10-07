// Menu + carrito + checkout de UNA sucursal. Todo contra el backend real: el menu, los precios y la
// disponibilidad salen de la base (se refrescan cada minuto: "hoy no hay" aparece en vivo), la cotizacion y el
// pedido pasan por la misma maquina de estados del servidor (cotizar -> confirmar -> crear) y las reglas duras
// de PM las aplica el servidor; esta pagina solo las anticipa para no ofrecer lo que se rechazaria.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Callout, Checkbox, ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, StatusBadge, Textarea, notify } from "@atiende/ui";
import { agregar, aItemsApi, avisos, cambiarCantidad, filtrarMenu, formatoPesos, hayAlcohol, nuevoIdSesion, propinaPermitida, subtotal, totalArticulos, type Carrito } from "./carrito.ts";
import { crearClienteStorefront, StorefrontError, type CategoriaMenu, type Canal, type MarcaPublica, type Cotizacion, type MetodoPago, type ProductoMenu, type SucursalPublica, type Tortilla } from "./storefront-client.ts";
import { textoApertura } from "./RestaurantePage.tsx";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";
import { usePantallaAncha } from "./use-pantalla-ancha.ts";

const REFRESCO_MENU_MS = 60_000;

function almacen(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Id del titulo de una categoria (destino del salto y del scroll-spy). */
function idCategoria(c: CategoriaMenu): string {
  return `cat-${c.id ?? "otros"}`;
}

/** Solo ids y cantidades: el carrito guardado nunca lleva datos personales. */
function leerCarritoGuardado(clave: string): Array<{ id: string; cantidad: number; tortilla: Tortilla | null }> {
  try {
    const raw = almacen()?.getItem(clave);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Array<{ id: string; cantidad: number; tortilla: Tortilla | null }>).filter((r) => typeof r?.id === "string" && Number.isFinite(r.cantidad)) : [];
  } catch {
    return [];
  }
}

function reconstruir(guardado: ReturnType<typeof leerCarritoGuardado>, categorias: readonly CategoriaMenu[]): Carrito {
  const porId = new Map(categorias.flatMap((c) => c.items).map((p) => [p.id, p]));
  let carrito: Carrito = [];
  for (const g of guardado) {
    const producto = porId.get(g.id);
    if (!producto) continue;
    carrito = agregar(carrito, producto, g.tortilla);
    if (g.cantidad > 1) carrito = cambiarCantidad(carrito, g.id, producto.requiresTortilla ? g.tortilla : null, g.cantidad);
  }
  return carrito;
}

interface FormularioCliente {
  nombre: string;
  telefono: string;
  correo: string;
  direccion: string;
  colonia: string;
  notas: string;
  codigoPromo: string;
  propina: string;
  mayorDeEdad: boolean;
  promociones: boolean;
  acepta: boolean;
}

const FORM_VACIO: FormularioCliente = { nombre: "", telefono: "", correo: "", direccion: "", colonia: "", notas: "", codigoPromo: "", propina: "", mayorDeEdad: false, promociones: false, acepta: false };

export function validarFormulario(f: FormularioCliente, canal: Canal, pago: MetodoPago | null, alcohol: boolean, hayZonas: boolean): Partial<Record<keyof FormularioCliente | "pago", string>> {
  const e: Partial<Record<keyof FormularioCliente | "pago", string>> = {};
  if (!f.nombre.trim()) e.nombre = "Escribe tu nombre.";
  const digitos = f.telefono.replace(/\D/g, "");
  if (!(digitos.length === 10 || (digitos.length === 12 && digitos.startsWith("52")) || (digitos.length === 13 && digitos.startsWith("521")))) e.telefono = "Escribe un teléfono de 10 dígitos.";
  if (f.correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.correo.trim())) e.correo = "Revisa tu correo (o déjalo vacío).";
  if (canal === "domicilio" && !f.direccion.trim()) e.direccion = "Escribe la dirección completa de entrega.";
  if (canal === "domicilio" && hayZonas && !f.colonia.trim()) e.colonia = "Elige tu colonia o zona.";
  if (canal === "domicilio" && !hayZonas && !f.colonia.trim()) e.colonia = "Escribe tu colonia.";
  if (!pago) e.pago = "Elige cómo vas a pagar en la sucursal.";
  if (alcohol && !f.mayorDeEdad) e.mayorDeEdad = "Confirma que quien recibe el pedido es mayor de edad.";
  if (!f.acepta) e.acepta = "Acepta el aviso de privacidad para continuar.";
  const propina = f.propina.trim() === "" ? 0 : Number(f.propina);
  if (!Number.isFinite(propina) || propina < 0) e.propina = "La propina debe ser un monto en pesos.";
  return e;
}

export function SucursalPage({ apiBaseUrl, orgSlug, branchSlug }: { apiBaseUrl: string; orgSlug: string; branchSlug: string }) {
  const navigate = useNavigate();
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const claveCarrito = `atiende.storefront.carrito.${orgSlug}.${branchSlug}`;
  const claveSesion = `atiende.storefront.sesion.${orgSlug}.${branchSlug}`;

  const [menu, setMenu] = useState<{ sucursal: SucursalPublica | null; categorias: CategoriaMenu[]; marca?: MarcaPublica } | "cargando" | { error: string }>("cargando");
  const [carrito, setCarrito] = useState<Carrito>([]);
  const [canal, setCanal] = useState<Canal>("recoger");
  const [pago, setPago] = useState<MetodoPago | null>(null);
  const [form, setForm] = useState<FormularioCliente>(FORM_VACIO);
  const [errores, setErrores] = useState<ReturnType<typeof validarFormulario>>({});
  const [tortillaElegida, setTortillaElegida] = useState<Record<string, Tortilla | "">>({});
  const [cotizacion, setCotizacion] = useState<Cotizacion | null>(null);
  const [cotizando, setCotizando] = useState(false);
  const [dialogoAbierto, setDialogoAbierto] = useState(false);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [hojaAbierta, setHojaAbierta] = useState(false);
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null);
  const ancha = usePantallaAncha();
  const sessionId = useRef<string>("");
  const carritoHidratado = useRef(false);

  if (!sessionId.current) {
    const guardada = almacen()?.getItem(claveSesion);
    sessionId.current = guardada && /^[A-Za-z0-9_-]{16,64}$/.test(guardada) ? guardada : nuevoIdSesion();
    try {
      almacen()?.setItem(claveSesion, sessionId.current);
    } catch {
      // sin almacenamiento: la sesion vive solo en memoria
    }
  }

  const cargarMenu = useCallback(
    (silencioso: boolean) => {
      if (!silencioso) setMenu("cargando");
      cliente
        .menu(branchSlug)
        .then((m) => {
          setMenu(m);
          setCarrito((actual) => {
            if (!carritoHidratado.current) {
              carritoHidratado.current = true;
              return reconstruir(leerCarritoGuardado(claveCarrito), m.categorias);
            }
            // Disponibilidad en vivo: lo que ya no hay sale del carrito y se avisa; los precios se refrescan.
            const vigentes = new Map(m.categorias.flatMap((c) => c.items).map((p) => [p.id, p]));
            const quitados = actual.filter((r) => !vigentes.get(r.producto.id)?.available);
            if (quitados.length > 0) notify.warning(`Hoy ya no hay: ${quitados.map((r) => r.producto.name).join(", ")}. Lo quitamos de tu carrito.`);
            return actual.filter((r) => vigentes.get(r.producto.id)?.available).map((r) => ({ ...r, producto: vigentes.get(r.producto.id)! }));
          });
        })
        .catch((e: unknown) => {
          if (!silencioso) setMenu({ error: e instanceof Error ? e.message : "No pudimos cargar el menú." });
        });
    },
    [cliente, branchSlug, claveCarrito],
  );
  useEffect(() => {
    cargarMenu(false);
    const t = setInterval(() => cargarMenu(true), REFRESCO_MENU_MS);
    return () => clearInterval(t);
  }, [cargarMenu]);

  // R-37: NO se precarga el chunk de rastreo al abrir la confirmación. El helper de precarga de Vite emite
  // `vite:preloadError` aunque el import tenga su propio .catch, y el manejador global recarga la página: con el
  // diálogo abierto se perderían nombre, teléfono y dirección (no se persisten) o se cortaría el POST del pedido.
  // Si el chunk de rastreo falla tras un despliegue, la recarga ocurre ya en la URL de rastreo, sin daño.

  useEffect(() => {
    if (!carritoHidratado.current) return;
    try {
      almacen()?.setItem(claveCarrito, JSON.stringify(carrito.map((r) => ({ id: r.producto.id, cantidad: r.cantidad, tortilla: r.tortilla }))));
    } catch {
      // ignorado
    }
  }, [carrito, claveCarrito]);

  const sucursal = typeof menu === "object" && "categorias" in menu ? menu.sucursal : null;
  const marca = typeof menu === "object" && "categorias" in menu ? menu.marca : undefined;
  useMetaPublica({
    titulo: sucursal ? `Menú de ${sucursal.name} · Pedir en línea` : "Menú · Pedir en línea",
    descripcion: sucursal ? `Menú y precios de la sucursal ${sucursal.name}${sucursal.address ? `, ${sucursal.address}` : ""}. Pide a domicilio o para recoger y paga en la sucursal.` : "Menú y precios.",
    indexable: true,
    imagen: marca?.portadaUrl ?? marca?.logoUrl,
  });

  const categoriasMenu = useMemo(() => (typeof menu === "object" && "categorias" in menu ? menu.categorias : []), [menu]);
  const categoriasFiltradas = useMemo(() => filtrarMenu(categoriasMenu, busqueda), [categoriasMenu, busqueda]);
  const idsCategorias = categoriasFiltradas.map((c) => idCategoria(c)).join("|");

  // Scroll-spy: la categoria cuyo titulo esta en la franja alta de la pantalla queda activa en la barra.
  useEffect(() => {
    const ids = idsCategorias ? idsCategorias.split("|") : [];
    setCategoriaActiva(ids[0] ?? null);
    if (ids.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observador = new IntersectionObserver(
      (entradas) => {
        const visible = entradas.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCategoriaActiva(visible.target.id);
      },
      { rootMargin: "-10% 0px -75% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observador.observe(el);
    }
    return () => observador.disconnect();
  }, [idsCategorias]);

  function irACategoria(id: string) {
    setCategoriaActiva(id);
    const el = document.getElementById(id);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const alcohol = hayAlcohol(carrito);
  const minimoDom = sucursal?.pedidoMinimoDomicilio ?? null;
  const minimoRec = sucursal?.pedidoMinimoRecoger ?? null;
  const avisosCanal = avisos(carrito, canal, minimoDom, minimoRec);
  const bloqueos = avisosCanal.filter((a) => a.bloquea);
  const puedePropina = propinaPermitida(sucursal?.propinaPolitica ?? null, pago);
  const zonas = sucursal?.zonasReparto ?? [];
  const cerrada = sucursal?.abiertoAhora === false;
  const sinDomicilio = sucursal?.aceptaDomicilio === false;

  const cambiar = <K extends keyof FormularioCliente>(campo: K, valor: FormularioCliente[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setCotizacion(null);
  };

  function datosPedido() {
    return { sessionId: sessionId.current, items: aItemsApi(carrito), canal, coloniaEntrega: canal === "domicilio" ? form.colonia.trim() : undefined, metodoPago: pago ?? undefined, mayorDeEdad: form.mayorDeEdad, codigoPromo: form.codigoPromo };
  }

  async function revisar(ev: FormEvent) {
    ev.preventDefault();
    setErrorServidor(null);
    const e = validarFormulario(form, canal, pago, alcohol, zonas.length > 0);
    setErrores(e);
    if (Object.keys(e).length > 0 || bloqueos.length > 0) return;
    setCotizando(true);
    try {
      const c = await cliente.cotizar(branchSlug, datosPedido());
      setCotizacion(c);
      setDialogoAbierto(true);
    } catch (err) {
      // La sesion ya tiene un pedido registrado (respuesta perdida en un intento anterior): se muestra ese pedido.
      if (err instanceof StorefrontError && err.rastreoToken) return irAlPedidoRegistrado(err.rastreoToken);
      setErrorServidor(err instanceof Error ? err.message : "No pudimos cotizar tu pedido.");
    } finally {
      setCotizando(false);
    }
  }

  function limpiarSesion() {
    try {
      almacen()?.removeItem(claveCarrito);
      almacen()?.removeItem(claveSesion);
    } catch {
      // ignorado
    }
  }

  function irAlPedidoRegistrado(rastreoToken: string) {
    limpiarSesion();
    setDialogoAbierto(false);
    notify.success("Tu pedido ya estaba registrado.");
    navigate(`/pedir/${orgSlug}/pedido/${encodeURIComponent(rastreoToken)}`);
  }

  async function confirmarPedido() {
    try {
      await cliente.confirmar(branchSlug, sessionId.current, cotizacion?.quote_hash ?? null);
      const propina = form.propina.trim() && puedePropina ? Number(form.propina) : undefined;
      const creado = await cliente.crearPedido(branchSlug, datosPedido(), { nombre: form.nombre, telefono: form.telefono, correo: form.correo, direccion: form.direccion, notas: form.notas, propina, aceptaAviso: form.acepta, aceptaPromociones: form.promociones }, cotizacion?.quote_hash ?? null);
      limpiarSesion();
      notify.success(creado.ya_registrado ? "Tu pedido ya estaba registrado." : "¡Pedido recibido!");
      navigate(`/pedir/${orgSlug}/pedido/${encodeURIComponent(creado.rastreo_token)}`);
    } catch (err) {
      if (err instanceof StorefrontError && err.rastreoToken) return irAlPedidoRegistrado(err.rastreoToken);
      const mensaje = err instanceof Error ? err.message : "No pudimos registrar tu pedido.";
      notify.error(mensaje);
      setErrorServidor(mensaje);
      if (err instanceof StorefrontError && err.motivo) setCotizacion(null);
      setDialogoAbierto(false);
    }
  }

  if (menu === "cargando") {
    return (
      <StorefrontLayout orgSlug={orgSlug}>
        <EstadoCargando variante="tarjeta" />
      </StorefrontLayout>
    );
  }
  if ("error" in menu) {
    return (
      <StorefrontLayout orgSlug={orgSlug}>
        <EstadoError mensaje={menu.error} onReintentar={() => cargarMenu(false)} />
      </StorefrontLayout>
    );
  }

  const formularioPedido = (conTitulo: boolean) => (
  <form onSubmit={revisar} noValidate className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
    {conTitulo && <h2 className="text-lg font-semibold">Tu pedido</h2>}
    {carrito.length === 0 ? (
      <p className="text-sm text-muted-foreground">Aún no agregas nada. Elige productos del menú.</p>
    ) : (
      <ul className="flex flex-col gap-2" aria-live="polite">
        {carrito.map((r) => (
          <li key={`${r.producto.id}|${r.tortilla ?? ""}`} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 flex-1">
              {r.producto.name}
              {r.tortilla ? ` (tortilla ${r.tortilla})` : ""}
            </span>
            <span className="flex items-center gap-1">
              <Button type="button" size="icon-sm" variant="outline" aria-label={`Quitar una unidad de ${r.producto.name}`} onClick={() => setCarrito((c) => cambiarCantidad(c, r.producto.id, r.tortilla, r.cantidad - 1))}>
                −
              </Button>
              <span aria-label={`Cantidad: ${r.cantidad}`} className="w-6 text-center tabular-nums">
                {r.cantidad}
              </span>
              <Button type="button" size="icon-sm" variant="outline" aria-label={`Agregar una unidad de ${r.producto.name}`} onClick={() => setCarrito((c) => cambiarCantidad(c, r.producto.id, r.tortilla, r.cantidad + 1))}>
                +
              </Button>
            </span>
            <span className="w-16 text-right tabular-nums">{formatoPesos(r.producto.price * r.cantidad)}</span>
          </li>
        ))}
        <li className="flex justify-between border-t border-border pt-2 font-semibold">
          <span>Subtotal</span>
          <span className="tabular-nums">{formatoPesos(subtotal(carrito))}</span>
        </li>
      </ul>
    )}

    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">¿Cómo lo quieres?</legend>
      <div className="flex gap-2">
        {(["recoger", "domicilio"] as const).map((c) => (
          <label key={c} className={`flex flex-1 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 ${c === "domicilio" && sinDomicilio ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
            <input
              type="radio"
              name="canal"
              value={c}
              disabled={c === "domicilio" && sinDomicilio}
              checked={canal === c}
              onChange={() => {
                setCanal(c);
                setCotizacion(null);
              }}
            />
            {c === "recoger" ? "Recoger en sucursal" : "A domicilio"}
          </label>
        ))}
      </div>
      {sinDomicilio && <p className="text-xs text-muted-foreground">Esta sucursal solo atiende pedidos para recoger.</p>}
      {!sinDomicilio && sucursal?.domicilioTexto && <p className="text-xs text-muted-foreground">{sucursal.domicilioTexto}.</p>}
    </fieldset>

    {avisosCanal
      .filter((a) => a.codigo !== "vacio")
      .map((a) => (
        <Callout key={a.codigo} tone="warning">
          {a.mensaje}
        </Callout>
      ))}

    <FormField label="Nombre" required error={errores.nombre}>
      <Input autoComplete="name" value={form.nombre} onChange={(e) => cambiar("nombre", e.target.value)} maxLength={160} />
    </FormField>
    <FormField label="Teléfono" required hint="10 dígitos, para avisarte de tu pedido." error={errores.telefono}>
      <Input type="tel" inputMode="tel" autoComplete="tel" value={form.telefono} onChange={(e) => cambiar("telefono", e.target.value)} maxLength={20} />
    </FormField>
    <FormField label="Correo (opcional)" hint="Solo si quieres la confirmación por correo." error={errores.correo}>
      <Input type="email" autoComplete="email" value={form.correo} onChange={(e) => cambiar("correo", e.target.value)} maxLength={320} />
    </FormField>

    {canal === "domicilio" && (
      <>
        <FormField label="Colonia o zona" required error={errores.colonia}>
          {zonas.length > 0 ? (
            <NativeSelect value={form.colonia} onChange={(e) => cambiar("colonia", e.target.value)}>
              <option value="">Elige tu zona</option>
              {zonas.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input value={form.colonia} onChange={(e) => cambiar("colonia", e.target.value)} maxLength={200} />
          )}
        </FormField>
        <FormField label="Dirección completa" required error={errores.direccion}>
          <Textarea autoComplete="street-address" rows={2} value={form.direccion} onChange={(e) => cambiar("direccion", e.target.value)} maxLength={1000} />
        </FormField>
      </>
    )}

    <fieldset className="grid gap-2" aria-describedby={errores.pago ? "error-pago" : undefined}>
      <legend className="text-sm font-medium">
        Forma de pago <span className="font-normal text-muted-foreground">(se paga en la sucursal{canal === "domicilio" ? " o al repartidor" : ""})</span>
      </legend>
      <div className="flex gap-2">
        {(["efectivo", "tarjeta"] as const).map((m) => (
          <label key={m} className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input
              type="radio"
              name="pago"
              value={m}
              checked={pago === m}
              onChange={() => {
                setPago(m);
                setCotizacion(null);
              }}
            />
            {m === "efectivo" ? "Efectivo" : "Tarjeta"}
          </label>
        ))}
      </div>
      {errores.pago && (
        <p id="error-pago" role="alert" className="text-xs text-destructive">
          {errores.pago}
        </p>
      )}
    </fieldset>

    {puedePropina && (
      <FormField label="Propina (opcional)" hint="Solo con tarjeta; se registra aparte y no suma al total." error={errores.propina}>
        <Input inputMode="decimal" value={form.propina} onChange={(e) => cambiar("propina", e.target.value)} />
      </FormField>
    )}
    {canal === "recoger" && (
      <FormField label="Código de promoción (opcional)" hint="Las promociones solo aplican al recoger en sucursal.">
        <Input value={form.codigoPromo} onChange={(e) => cambiar("codigoPromo", e.target.value)} maxLength={40} autoCapitalize="characters" />
      </FormField>
    )}
    <FormField label="Notas (opcional)">
      <Textarea rows={2} value={form.notas} onChange={(e) => cambiar("notas", e.target.value)} maxLength={500} />
    </FormField>

    {alcohol && (
      <FormField label="Mayoría de edad" error={errores.mayorDeEdad}>
        {(p) => (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...p} checked={form.mayorDeEdad} onChange={(e) => cambiar("mayorDeEdad", e.target.checked)} />
            Confirmo que quien recibe el pedido es mayor de edad (tu pedido incluye alcohol).
          </label>
        )}
      </FormField>
    )}
    <FormField label="Promociones (opcional)">
      {(p) => (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox {...p} checked={form.promociones} onChange={(e) => cambiar("promociones", e.target.checked)} />
          <span>Quiero recibir promociones por WhatsApp. Puedes darte de baja cuando quieras escribiendo BAJA.</span>
        </label>
      )}
    </FormField>

    <FormField label="Aviso de privacidad" error={errores.acepta}>
      {(p) => (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox {...p} checked={form.acepta} onChange={(e) => cambiar("acepta", e.target.checked)} />
          <span>
            Leí el{" "}
            <a href={`/pedir/${orgSlug}/privacidad`} target="_blank" rel="noreferrer" className="underline">
              aviso de privacidad
            </a>
            .
          </span>
        </label>
      )}
    </FormField>

    {errorServidor && (
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {errorServidor}
      </div>
    )}
    <Button type="submit" loading={cotizando} disabled={carrito.length === 0 || bloqueos.length > 0 || cerrada}>
      Revisar pedido
    </Button>
  </form>
  );

  const ap = sucursal ? textoApertura(sucursal) : null;

  return (
    <StorefrontLayout orgSlug={orgSlug} marca={marca} whatsappUrl={sucursal?.whatsappUrl}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{sucursal?.name ?? "Menú"}</h1>
          {sucursal?.address && <p className="text-sm text-muted-foreground">{sucursal.address}</p>}
        </div>
        {ap && <StatusBadge tone={ap.tone}>{ap.texto}</StatusBadge>}
      </div>
      {cerrada && (
        <Callout tone="warning" className="mt-4" titulo="Sucursal cerrada">
          Puedes revisar el menú, pero no se puede enviar el pedido hasta que abra.
        </Callout>
      )}

      <div className={`mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] ${!ancha && carrito.length > 0 ? "pb-24" : ""}`}>
        <div>
          {menu.categorias.length > 0 && (
            <>
              <div className="mb-3">
                <label htmlFor="buscar-menu" className="sr-only">
                  Buscar en el menú
                </label>
                <Input id="buscar-menu" type="search" placeholder="Buscar en el menú" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} maxLength={80} autoComplete="off" />
              </div>
              <nav aria-label="Categorías del menú" className="sticky top-0 z-20 -mx-4 mb-4 overflow-x-auto border-b border-border bg-background px-4 py-2 sm:-mx-6 sm:px-6">
                <ul className="flex gap-2">
                  {categoriasFiltradas.map((cat) => {
                    const id = idCategoria(cat);
                    return (
                      <li key={id} className="shrink-0">
                        <Button type="button" size="sm" variant={categoriaActiva === id ? "default" : "outline"} aria-current={categoriaActiva === id ? "true" : undefined} onClick={() => irACategoria(id)}>
                          {cat.name}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </>
          )}
          {menu.categorias.length === 0 && <EstadoVacio titulo="Menú no disponible" mensaje="Esta sucursal todavía no tiene productos publicados." />}
          {menu.categorias.length > 0 && categoriasFiltradas.length === 0 && <EstadoVacio titulo="Sin resultados" mensaje={`Ningún producto coincide con “${busqueda.trim()}”.`} />}
          {categoriasFiltradas.map((cat) => (
            <section key={cat.id ?? cat.name} aria-labelledby={idCategoria(cat)} className="mb-8">
              <h2 id={idCategoria(cat)} className="mb-3 scroll-mt-16 text-lg font-semibold">
                {cat.name}
              </h2>
              <ul className="grid gap-3">
                {cat.items.map((p) => (
                  <TarjetaProducto key={p.id} producto={p} tortilla={tortillaElegida[p.id] ?? ""} onTortilla={(t) => setTortillaElegida((m) => ({ ...m, [p.id]: t }))} onAgregar={(t) => setCarrito((c) => agregar(c, p, t))} />
                ))}
              </ul>
            </section>
          ))}
        </div>

        {ancha && (
          <aside aria-label="Tu pedido" className="lg:sticky lg:top-4 lg:self-start">
            {formularioPedido(true)}
          </aside>
        )}
      </div>

      {!ancha && carrito.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card px-4 pb-[calc(0.75rem+var(--safe-area-bottom,0px))] pt-3 shadow-elevated">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="text-sm" aria-live="polite">
              <span className="font-semibold tabular-nums">{totalArticulos(carrito)}</span> {totalArticulos(carrito) === 1 ? "producto" : "productos"} · <span className="font-semibold tabular-nums">{formatoPesos(subtotal(carrito))}</span>
            </p>
            <Button type="button" onClick={() => setHojaAbierta(true)}>
              Ver pedido
            </Button>
          </div>
        </div>
      )}
      {!ancha && (
        <Dialog open={hojaAbierta} onOpenChange={setHojaAbierta}>
          <DialogContent className="max-h-[90dvh]" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Tu pedido</DialogTitle>
            </DialogHeader>
            {formularioPedido(false)}
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={dialogoAbierto}
        onOpenChange={setDialogoAbierto}
        titulo="Confirma tu pedido"
        confirmar="Confirmar pedido"
        cancelar="Seguir editando"
        descripcion={cotizacion ? <ResumenCotizacion cotizacion={cotizacion} canal={canal} pago={pago} /> : undefined}
        onConfirm={confirmarPedido}
      />
    </StorefrontLayout>
  );
}

function ResumenCotizacion({ cotizacion, canal, pago }: { cotizacion: Cotizacion; canal: Canal; pago: MetodoPago | null }) {
  const promo = cotizacion.promo?.valida ? cotizacion.promo : null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ul className="flex flex-col gap-1">
        {cotizacion.quote.lines.map((l) => (
          <li key={`${l.product_id}|${l.tortilla ?? ""}`} className="flex justify-between gap-3">
            <span>
              {l.quantity} × {l.name}
              {l.tortilla ? ` (${l.tortilla})` : ""}
            </span>
            <span className="tabular-nums">{formatoPesos(l.line_total)}</span>
          </li>
        ))}
      </ul>
      {promo && (
        <p className="flex justify-between text-success">
          <span>Promoción {promo.codigo}</span>
          <span className="tabular-nums">−{formatoPesos(promo.descuento)}</span>
        </p>
      )}
      {cotizacion.promo && !cotizacion.promo.valida && <p className="text-warning">{cotizacion.promo.mensaje}</p>}
      <p className="flex justify-between border-t border-border pt-2 font-semibold text-foreground">
        <span>Total</span>
        <span className="tabular-nums">{formatoPesos(promo ? promo.totalConDescuento : cotizacion.quote.total)}</span>
      </p>
      <p className="text-muted-foreground">
        {canal === "recoger" ? "Recoges en la sucursal" : "Te lo llevamos a domicilio"} · pagas {pago === "tarjeta" ? "con tarjeta" : "en efectivo"} en la sucursal.
      </p>
    </div>
  );
}

function TarjetaProducto({ producto, tortilla, onTortilla, onAgregar }: { producto: ProductoMenu; tortilla: Tortilla | ""; onTortilla: (t: Tortilla | "") => void; onAgregar: (t: Tortilla | null) => void }) {
  const nota = [producto.packSize && producto.packSize > 1 ? `Orden de ${producto.packSize} piezas` : null, producto.noDomicilio ? "Solo para recoger" : null, producto.requiresAdultConfirmation ? "Solo mayores de edad" : null].filter(Boolean).join(" · ");
  return (
    <li className={`flex gap-3 rounded-xl border border-border bg-card p-3 ${producto.available ? "" : "opacity-70"}`}>
      {producto.imageUrl && <img src={producto.imageUrl} alt="" loading="lazy" className="size-20 shrink-0 rounded-md object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{producto.name}</h3>
          {producto.isPopular && <StatusBadge tone="info">Popular</StatusBadge>}
          {!producto.available && <StatusBadge tone="danger">Hoy no hay</StatusBadge>}
        </div>
        {producto.description && <p className="mt-0.5 text-sm text-muted-foreground">{producto.description}</p>}
        {nota && <p className="mt-0.5 text-xs text-muted-foreground">{nota}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-semibold tabular-nums">{formatoPesos(producto.price)}</span>
          {producto.requiresTortilla && producto.available && (
            <NativeSelect size="sm" wrapperClassName="w-40" aria-label={`Tortilla para ${producto.name}`} value={tortilla} onChange={(e) => onTortilla(e.target.value as Tortilla | "")}>
              <option value="">Tortilla…</option>
              <option value="maiz">Maíz</option>
              <option value="harina">Harina</option>
              <option value="mixta">Mixta</option>
            </NativeSelect>
          )}
          <Button type="button" size="sm" disabled={!producto.available || (producto.requiresTortilla && !tortilla)} aria-label={`Agregar ${producto.name} al carrito`} onClick={() => onAgregar(tortilla || null)}>
            Agregar
          </Button>
        </div>
      </div>
    </li>
  );
}
