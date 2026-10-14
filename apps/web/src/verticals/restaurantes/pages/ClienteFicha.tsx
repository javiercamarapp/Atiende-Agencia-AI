// Ficha del cliente (Cliente 360, migracion 049): datos, domicilios, gustos, historial de pedidos, conversaciones
// (WhatsApp y llamadas), reincidencia de "no recogido" / pedido falso, notas del staff y derechos ARCO. Todo sale de
// `GET .../admin/customers/:id/ficha` y cada control escribe por su endpoint (rol, organizacion y bitacora en el servidor).
// Contra una base sin la migracion 049 la ficha completa responde 503 "no disponible aun": se muestra ese estado honesto
// y la ficha basica de siempre (nivel, direcciones, lo que mas pide), nunca datos inventados.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  Selector,
  PageContainer,
  StatusBadge,
  Textarea,
  formatMoney,
  statusTone,
  useConfirm,
} from "@atiende/ui";
import { ArrowLeft } from "lucide-react";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import {
  ETIQUETA_TIPO_GUSTO,
  accionGusto,
  actualizarPerfilCliente,
  borrarDomicilio,
  borrarMemoriaCliente,
  exportarDatosCliente,
  fetchCustomerDetail,
  fetchFichaCliente,
  fetchPoliticaReincidencia,
  guardarDomicilio,
  guardarPoliticaReincidencia,
  marcarPedidoFalso,
} from "../lib/customers-client.ts";
import type { CustomerDetail, DomicilioFicha, FichaCliente, GustoFicha, PoliticaReincidencia, TipoGusto } from "../lib/customers-client.ts";
import { CUSTOMER_TIER_META, CUSTOMER_TIER_TONES, ORDER_STATUS_TONES, tierBadgeClase } from "../lib/status-tones.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export interface ClienteFichaPageProps extends RestaurantesShellContext {
  readonly customerId: string;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
const TIPOS_GUSTO = Object.keys(ETIQUETA_TIPO_GUSTO) as TipoGusto[];
const MENSAJE_NO_DISPONIBLE = "Ficha completa no disponible aún: requiere aplicar la migración 049 de restaurantes. Mientras tanto se muestra la ficha básica.";

function mensajeDeError(err: unknown, porDefecto: string): string {
  return err instanceof Error && err.message ? err.message : porDefecto;
}

function Seccion({ titulo, accion, children }: { readonly titulo: string; readonly accion?: ReactNode; readonly children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-4 pb-2">
        <CardTitle>{titulo}</CardTitle>
        {accion}
      </CardHeader>
      <CardContent className="p-4 pt-0">{children}</CardContent>
    </Card>
  );
}

export function ClienteFichaPage({ apiBaseUrl, token, propertyId, orgSlug, role, customerId }: ClienteFichaPageProps) {
  const [ficha, setFicha] = useState<FichaCliente | null>(null);
  const [basica, setBasica] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);
  const [aviso, setAviso] = useState<{ tono: "success" | "danger"; texto: string } | null>(null);
  const [recarga, setRecarga] = useState(0);
  // QA-restaurantes-R2-botones-08: una sola escritura de la ficha a la vez (candado en ref contra el doble clic + estado para deshabilitar los botones).
  const [ocupado, setOcupado] = useState(false);
  const enCursoRef = useRef(false);
  const puedeAdministrar = role === "owner" || role === "admin";

  const recargar = useCallback(() => setRecarga((n) => n + 1), []);
  // QA-restaurantes-R2-botones-05: la falla de carga ofrece Reintentar (limpia el error y vuelve a pedir la ficha).
  const reintentarCarga = useCallback(() => {
    setError(null);
    setNoDisponible(false);
    setRecarga((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelado = false;
    fetchFichaCliente(fetch, apiBaseUrl, token, propertyId, customerId)
      .then((f) => {
        if (cancelado) return;
        setFicha(f);
        setNoDisponible(false);
        setError(null);
      })
      .catch(async (err: unknown) => {
        if (cancelado) return;
        const texto = mensajeDeError(err, "No se pudo cargar el cliente.");
        // 503 = base sin la migracion 049: ficha basica + aviso honesto. Cualquier otro error se muestra tal cual.
        if (/no disponible a[uú]n/i.test(texto)) {
          setNoDisponible(true);
          try {
            const detalle = await fetchCustomerDetail(fetch, apiBaseUrl, token, propertyId, customerId);
            if (!cancelado) setBasica(detalle);
          } catch (e) {
            if (!cancelado) setError(mensajeDeError(e, "No se pudo cargar el cliente."));
          }
        } else {
          setError(texto);
        }
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, customerId, recarga]);

  const ejecutar = useCallback(
    async (tarea: () => Promise<unknown>, exito: string, alFallar?: (mensaje: string) => void): Promise<boolean> => {
      if (enCursoRef.current) return false;
      enCursoRef.current = true;
      setOcupado(true);
      setAviso(null);
      try {
        await tarea();
        setAviso({ tono: "success", texto: exito });
        recargar();
        return true;
      } catch (err) {
        const mensaje = mensajeDeError(err, "No se pudo guardar el cambio.");
        // Con `alFallar` el error se muestra junto al formulario que lo origino (no arriba de la pagina).
        if (alFallar) alFallar(mensaje);
        else setAviso({ tono: "danger", texto: mensaje });
        return false;
      } finally {
        enCursoRef.current = false;
        setOcupado(false);
      }
    },
    [recargar],
  );

  return (
    <PageContainer padding="none">
      <Button asChild variant="ghost" size="sm" className="self-start px-2 text-muted-foreground">
        <Link to={`/restaurantes/${orgSlug}/clientes`}>
          <ArrowLeft />
          Volver a clientes
        </Link>
      </Button>

      {error && <EstadoError mensaje={error} onReintentar={reintentarCarga} />}
      {!ficha && !basica && !error && <EstadoCargando etiqueta="Cargando cliente…" />}
      {noDisponible && <Callout tone="warning">{MENSAJE_NO_DISPONIBLE}</Callout>}
      {aviso && (
        <p role={aviso.tono === "danger" ? "alert" : "status"} className={`m-0 text-ui ${aviso.tono === "danger" ? "text-destructive" : "text-success"}`}>
          {aviso.texto}
        </p>
      )}

      {noDisponible && basica && <FichaBasica detalle={basica} />}
      {ficha && (
        <OcupadoContext.Provider value={ocupado}>
          <FichaCompleta
            ficha={ficha}
            puedeAdministrar={puedeAdministrar}
            ejecutar={ejecutar}
            api={{ apiBaseUrl, token, propertyId, customerId }}
          />
        </OcupadoContext.Provider>
      )}
    </PageContainer>
  );
}

type Api = { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly customerId: string };
type Ejecutar = (tarea: () => Promise<unknown>, exito: string, alFallar?: (mensaje: string) => void) => Promise<boolean>;
/** true mientras una escritura de la ficha esta en curso: los botones que escriben se deshabilitan (anti doble clic). */
const OcupadoContext = createContext(false);

/** Ficha de siempre (nivel, direcciones, lo que mas pide): es la que se muestra mientras la migracion 049 no esta aplicada. */
function FichaBasica({ detalle }: { readonly detalle: CustomerDetail }) {
  if (detalle.isNew) return <EstadoVacio mensaje="Este cliente todavía no tiene ningún pedido registrado." />;
  return (
    <>
      <div className="flex items-center gap-2.5">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">{detalle.name ?? "Sin nombre"}</h1>
        {detalle.tier && (
          <StatusBadge dot={false} tone={statusTone(CUSTOMER_TIER_TONES, detalle.tier)} className={`gap-1.5 px-2.5 py-1 ${tierBadgeClase(detalle.tier) ?? ""}`}>
            <span aria-hidden>{CUSTOMER_TIER_META[detalle.tier].glyph}</span>
            {CUSTOMER_TIER_META[detalle.tier].label}
          </StatusBadge>
        )}
      </div>
      <Seccion titulo="Direcciones guardadas">
        {detalle.addresses.length === 0 ? (
          <p className="m-0 text-ui text-muted-foreground">Sin direcciones guardadas.</p>
        ) : (
          <ul className="m-0 list-disc pl-5 text-ui text-foreground">
            {detalle.addresses.map((a, i) => (
              <li key={i}>
                {a.address} {a.isDefault && <span className="text-muted-foreground">(principal)</span>}
              </li>
            ))}
          </ul>
        )}
      </Seccion>
      {detalle.notes && (
        <Seccion titulo="Nota del cliente">
          <p className="m-0 text-ui text-foreground" data-testid="cliente-nota">
            {detalle.notes}
          </p>
        </Seccion>
      )}
      <Seccion titulo="Lo que más pide">
        {detalle.frequentItems.length === 0 ? (
          <p className="m-0 text-ui text-muted-foreground">Sin historial suficiente todavía.</p>
        ) : (
          <ul className="m-0 list-disc pl-5 text-ui text-foreground">
            {detalle.frequentItems.map((item, i) => (
              <li key={i}>
                {item.quantity}× {item.name}
              </li>
            ))}
          </ul>
        )}
      </Seccion>
    </>
  );
}

function FichaCompleta({ ficha, puedeAdministrar, ejecutar, api }: { readonly ficha: FichaCliente; readonly puedeAdministrar: boolean; readonly ejecutar: Ejecutar; readonly api: Api }) {
  const { confirmar, dialogo } = useConfirm();
  const { customer, reliability } = ficha;
  const reincidente = reliability.umbral > 0 && reliability.noRecogidos90d + reliability.pedidosFalsos >= reliability.umbral;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">{customer.name ?? "Sin nombre"}</h1>
        {ficha.tier && (
          <StatusBadge dot={false} tone={statusTone(CUSTOMER_TIER_TONES, ficha.tier)} className={`gap-1.5 px-2.5 py-1 ${tierBadgeClase(ficha.tier) ?? ""}`}>
            <span aria-hidden>{CUSTOMER_TIER_META[ficha.tier].glyph}</span>
            {CUSTOMER_TIER_META[ficha.tier].label}
          </StatusBadge>
        )}
        {reincidente && (
          <StatusBadge tone="warning">
            El siguiente pedido lo confirma la sucursal
          </StatusBadge>
        )}
      </div>

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-ui">
        <dt className="text-muted-foreground">Teléfono</dt>
        <dd className="m-0 text-foreground">{customer.phone}</dd>
        <dt className="text-muted-foreground">Pedidos totales</dt>
        <dd className="m-0 text-foreground">{customer.orderCount}</dd>
        <dt className="text-muted-foreground">Último pedido</dt>
        <dd className="m-0 text-foreground">{customer.lastOrderAt ? fechaHoraEsMx(customer.lastOrderAt) : "—"}</dd>
        <dt className="text-muted-foreground">No recogidos ({reliability.ventanaDias} días)</dt>
        <dd className="m-0 text-foreground" data-testid="no-recogidos">
          {reliability.noRecogidos90d}
        </dd>
        <dt className="text-muted-foreground">Pedidos falsos marcados</dt>
        <dd className="m-0 text-foreground" data-testid="pedidos-falsos">
          {reliability.pedidosFalsos}
        </dd>
      </dl>

      {ficha.notes && (
        <Seccion titulo="Nota del cliente">
          <p className="m-0 text-ui text-foreground" data-testid="cliente-nota">
            {ficha.notes}
          </p>
        </Seccion>
      )}
      <PerfilForm ficha={ficha} ejecutar={ejecutar} api={api} />
      <Domicilios domicilios={ficha.addresses} ejecutar={ejecutar} api={api} confirmar={confirmar} />
      <Gustos gustos={ficha.preferences} ejecutar={ejecutar} api={api} confirmar={confirmar} />
      <Pedidos pedidos={ficha.orders} ejecutar={ejecutar} api={api} />

      <Seccion titulo="Conversaciones">
        <p className="m-0 text-ui text-foreground">
          WhatsApp: {ficha.whatsapp.conversaciones === 0 ? "sin conversación registrada" : `${ficha.whatsapp.mensajes} mensaje${ficha.whatsapp.mensajes === 1 ? "" : "s"} guardados`}
          {ficha.whatsapp.ultimaActividad ? ` · última actividad ${fechaHoraEsMx(ficha.whatsapp.ultimaActividad)}` : ""}
        </p>
        {ficha.llamadas.length === 0 ? (
          <p className="mt-2 text-ui text-muted-foreground">Sin llamadas registradas para este número.</p>
        ) : (
          <ul className="mt-2 list-disc pl-5 text-ui text-foreground">
            {ficha.llamadas.map((l) => (
              <li key={l.id}>
                {fechaHoraEsMx(l.startedAt)} · {l.durationS === null ? "en curso" : `${Math.max(1, Math.round(l.durationS / 60))} min`} · {l.resultado ?? "sin resultado"}
              </li>
            ))}
          </ul>
        )}
      </Seccion>

      <Politica puedeAdministrar={puedeAdministrar} api={api} />
      {puedeAdministrar && <Arco api={api} ejecutar={ejecutar} confirmar={confirmar} />}
      {dialogo}
    </>
  );
}

function PerfilForm({ ficha, ejecutar, api }: { readonly ficha: FichaCliente; readonly ejecutar: Ejecutar; readonly api: Api }) {
  const c = ficha.customer;
  const [nombre, setNombre] = useState(c.name ?? "");
  const [notas, setNotas] = useState(c.staffNotes ?? "");
  const [dia, setDia] = useState(c.fechaNacimientoDia === null ? "" : String(c.fechaNacimientoDia));
  const [mes, setMes] = useState(c.fechaNacimientoMes === null ? "" : String(c.fechaNacimientoMes));
  const ocupado = useContext(OcupadoContext);

  const guardar = (e: FormEvent) => {
    e.preventDefault();
    const tieneFecha = dia !== "" || mes !== "";
    return ejecutar(
      () =>
        actualizarPerfilCliente(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, {
          name: nombre.trim() === "" ? null : nombre.trim(),
          staffNotes: notas.trim() === "" ? null : notas.trim(),
          ...(tieneFecha || c.fechaNacimientoDia !== null ? { fechaNacimientoDia: dia === "" ? null : Number(dia), fechaNacimientoMes: mes === "" ? null : Number(mes) } : {}),
        }),
      "Datos del cliente guardados.",
    );
  };

  return (
    <Seccion titulo="Datos y notas">
      <form onSubmit={guardar} className="grid gap-3">
        <FormField label="Nombre">
          <Input value={nombre} maxLength={160} onChange={(e) => setNombre(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Cumpleaños: día (opcional)" hint="Solo si el cliente lo da.">
            <Input inputMode="numeric" value={dia} maxLength={2} onChange={(e) => setDia(e.target.value.replace(/\D/g, ""))} />
          </FormField>
          <FormField label="Cumpleaños: mes">
            <Selector value={mes} onChange={(e) => setMes(e.target.value)}>
              <option value="">—</option>
              {MESES.map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </Selector>
          </FormField>
        </div>
        <FormField label="Notas del restaurante" hint="Solo las ve el personal; no las lee el agente.">
          <Textarea value={notas} maxLength={1000} rows={3} onChange={(e) => setNotas(e.target.value)} />
        </FormField>
        <Button type="submit" size="sm" className="self-start" disabled={ocupado}>
          Guardar datos
        </Button>
      </form>
    </Seccion>
  );
}

type Confirmar = ReturnType<typeof useConfirm>["confirmar"];

function Domicilios({ domicilios, ejecutar, api, confirmar }: { readonly domicilios: readonly DomicilioFicha[]; readonly ejecutar: Ejecutar; readonly api: Api; readonly confirmar: Confirmar }) {
  const [editando, setEditando] = useState<string | "nuevo" | null>(null);
  const actual = domicilios.find((d) => d.id === editando) ?? null;
  const [form, setForm] = useState({ address: "", label: "", access: "", maps: "", colonia: "" });
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const ocupado = useContext(OcupadoContext);

  const abrir = (id: string | "nuevo", d: DomicilioFicha | null) => {
    setErrorForm(null);
    setForm({ address: d?.address ?? "", label: d?.label ?? "", access: d?.accessNotes ?? "", maps: d?.mapsUrl ?? "", colonia: d?.colonia ?? "" });
    setEditando(id);
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setErrorForm(null);
    // QA-restaurantes-R2-botones-04: el formulario solo se cierra si se guardo; si falla queda abierto con lo tecleado y el error a su lado.
    const guardado = await ejecutar(
      () =>
        guardarDomicilio(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, editando === "nuevo" ? null : editando, {
          address: form.address,
          label: form.label.trim() === "" ? null : form.label.trim(),
          access_notes: form.access.trim() === "" ? null : form.access.trim(),
          maps_url: form.maps.trim() === "" ? null : form.maps.trim(),
          colonia: form.colonia.trim() === "" ? null : form.colonia.trim(),
        }),
      "Domicilio guardado.",
      setErrorForm,
    );
    if (guardado) setEditando(null);
  };

  return (
    <Seccion
      titulo="Domicilios"
      accion={
        <Button size="sm" variant="outline" onClick={() => abrir("nuevo", null)}>
          Agregar domicilio
        </Button>
      }
    >
      {domicilios.length === 0 && editando === null && <p className="m-0 text-ui text-muted-foreground">Sin domicilios guardados. Se guardan solos al confirmar un pedido a domicilio.</p>}
      <ul className="m-0 grid list-none gap-3 p-0">
        {domicilios.map((d) => (
          <li key={d.id} className="rounded-lg border border-border p-3 text-ui">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">{d.label ?? "Sin etiqueta"}</span>
              {d.isDefault && <StatusBadge tone="info">Principal</StatusBadge>}
              {d.branchSlug && <span className="text-muted-foreground">Sucursal {d.branchSlug}</span>}
            </div>
            <p className="m-0 mt-1 text-foreground">{d.address}</p>
            {d.colonia && <p className="m-0 text-muted-foreground">Colonia: {d.colonia}</p>}
            {d.accessNotes && <p className="m-0 text-muted-foreground">Referencias: {d.accessNotes}</p>}
            {d.mapsUrl && (
              <a href={d.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-foreground underline">
                Ver en el mapa
              </a>
            )}
            <p className="m-0 mt-1 text-muted-foreground">
              Usado {d.timesUsed} {d.timesUsed === 1 ? "vez" : "veces"}
              {d.lastUsedAt ? ` · último uso ${fechaHoraEsMx(d.lastUsedAt)}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {!d.isDefault && (
                <Button size="sm" variant="outline" disabled={ocupado} onClick={() => ejecutar(() => guardarDomicilio(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, d.id, { is_default: true }), "Domicilio principal actualizado.")}>
                  Hacer principal
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => abrir(d.id, d)}>
                Editar
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={ocupado}
                onClick={async () => {
                  if (await confirmar({ titulo: "Eliminar este domicilio", descripcion: "El cliente podrá volver a darlo en su próximo pedido.", tono: "danger", confirmar: "Eliminar" })) {
                    await ejecutar(() => borrarDomicilio(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, d.id), "Domicilio eliminado.");
                  }
                }}
              >
                Eliminar
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {editando !== null && (
        <form onSubmit={guardar} className="mt-3 grid gap-3 rounded-lg border border-border p-3">
          <FormField label="Dirección completa" required>
            <Input value={form.address} maxLength={1000} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Etiqueta" hint="casa, oficina…">
              <Input value={form.label} maxLength={60} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </FormField>
            <FormField label="Colonia">
              <Input value={form.colonia} maxLength={120} onChange={(e) => setForm({ ...form, colonia: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Referencias de acceso">
            <Input value={form.access} maxLength={300} onChange={(e) => setForm({ ...form, access: e.target.value })} />
          </FormField>
          <FormField label="Enlace de mapa" hint="Solo si el cliente lo mandó; debe empezar con https://">
            <Input value={form.maps} maxLength={500} onChange={(e) => setForm({ ...form, maps: e.target.value })} />
          </FormField>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={ocupado || (form.address.trim() === "" && actual === null)}>
              Guardar domicilio
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={ocupado} onClick={() => setEditando(null)}>
              Cancelar
            </Button>
          </div>
          {errorForm && (
            <p role="alert" className="m-0 text-ui text-destructive">
              {errorForm}
            </p>
          )}
        </form>
      )}
    </Seccion>
  );
}

function Gustos({ gustos, ejecutar, api, confirmar }: { readonly gustos: readonly GustoFicha[]; readonly ejecutar: Ejecutar; readonly api: Api; readonly confirmar: Confirmar }) {
  const [kind, setKind] = useState<TipoGusto>("tortilla");
  const [value, setValue] = useState("");
  const ocupado = useContext(OcupadoContext);
  const agregar = async (e: FormEvent) => {
    e.preventDefault();
    // Solo se limpia el campo si el gusto se guardo: ante una falla se conserva lo tecleado para reintentar.
    const ok = await ejecutar(() => accionGusto(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, { accion: "agregar", kind, value: value.trim() }), "Gusto agregado.");
    if (ok) setValue("");
  };
  return (
    <Seccion titulo="Gustos">
      <p className="m-0 mb-2 text-ui text-muted-foreground">Se aprenden de pedidos confirmados. El agente solo los propone desde la segunda vez; los descartados no se vuelven a proponer.</p>
      {gustos.length === 0 ? (
        <p className="m-0 text-ui text-muted-foreground">Sin gustos registrados todavía.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {gustos.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 text-ui">
              <span className="text-muted-foreground">{ETIQUETA_TIPO_GUSTO[g.kind]}:</span>
              <span className={g.status === "descartada" ? "text-muted-foreground line-through" : "text-foreground"}>{g.value.replace(/_/g, " ")}</span>
              <span className="text-muted-foreground">
                {g.source === "staff" ? "anotado por el restaurante" : `${g.timesSeen} ${g.timesSeen === 1 ? "vez" : "veces"} · última ${fechaHoraEsMx(g.lastSeenAt)}`}
              </span>
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ocupado}
                  onClick={() => ejecutar(() => accionGusto(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, { accion: g.status === "activa" ? "descartar" : "reactivar", prefId: g.id }), g.status === "activa" ? "Gusto descartado." : "Gusto reactivado.")}
                >
                  {g.status === "activa" ? "Descartar" : "Reactivar"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={ocupado}
                  onClick={async () => {
                    if (await confirmar({ titulo: "Eliminar este gusto", tono: "danger", confirmar: "Eliminar" })) {
                      await ejecutar(() => accionGusto(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, { accion: "eliminar", prefId: g.id }), "Gusto eliminado.");
                    }
                  }}
                >
                  Eliminar
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={agregar} className="mt-3 grid grid-cols-[auto_1fr_auto] items-end gap-2">
        <FormField label="Tipo">
          <Selector value={kind} onChange={(e) => setKind(e.target.value as TipoGusto)}>
            {TIPOS_GUSTO.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_GUSTO[t]}
              </option>
            ))}
          </Selector>
        </FormField>
        <FormField label="Valor">
          <Input value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
        </FormField>
        <Button type="submit" size="sm" disabled={ocupado || value.trim() === ""}>
          Agregar
        </Button>
      </form>
    </Seccion>
  );
}

function Pedidos({ pedidos, ejecutar, api }: { readonly pedidos: FichaCliente["orders"]; readonly ejecutar: Ejecutar; readonly api: Api }) {
  const ocupado = useContext(OcupadoContext);
  return (
    <Seccion titulo="Historial de pedidos">
      {pedidos.length === 0 ? (
        <p className="m-0 text-ui text-muted-foreground">Sin pedidos registrados.</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {pedidos.map((p) => (
            <li key={p.id} className="rounded-lg border border-border p-3 text-ui">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">{p.orderNumber === null ? "Pedido" : `Pedido ${p.orderNumber}`}</span>
                <StatusBadge tone={statusTone(ORDER_STATUS_TONES, p.status)}>{p.status.replace(/_/g, " ")}</StatusBadge>
                {p.pedidoFalso && <StatusBadge tone="danger">Marcado como falso</StatusBadge>}
                <span className="ml-auto text-foreground">{formatMoney(p.total)}</span>
              </div>
              <p className="m-0 mt-1 text-muted-foreground">
                {fechaHoraEsMx(p.createdAt)} · {p.branch ?? "sin sucursal"} · {p.source}
              </p>
              {p.items.length > 0 && <p className="m-0 text-foreground">{p.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</p>}
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={ocupado}
                onClick={() => ejecutar(() => marcarPedidoFalso(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId, p.id, !p.pedidoFalso), p.pedidoFalso ? "Se quitó la marca de pedido falso." : "Pedido marcado como falso.")}
              >
                {p.pedidoFalso ? "Quitar marca de falso" : "Marcar como falso"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Seccion>
  );
}

function Politica({ puedeAdministrar, api }: { readonly puedeAdministrar: boolean; readonly api: Api }) {
  const [politica, setPolitica] = useState<PoliticaReincidencia | null>(null);
  const [umbral, setUmbral] = useState("2");
  const [ventana, setVentana] = useState("90");
  const [estado, setEstado] = useState<{ tono: "success" | "danger"; texto: string } | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchPoliticaReincidencia(fetch, api.apiBaseUrl, api.token, api.propertyId)
      .then((p) => {
        if (cancelado) return;
        setPolitica(p);
        setUmbral(String(p.umbralNoRecogidos));
        setVentana(String(p.ventanaDias));
      })
      .catch((err: unknown) => !cancelado && setEstado({ tono: "danger", texto: mensajeDeError(err, "No se pudo cargar la política.") }));
    return () => {
      cancelado = true;
    };
  }, [api.apiBaseUrl, api.token, api.propertyId]);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const nueva = await guardarPoliticaReincidencia(fetch, api.apiBaseUrl, api.token, api.propertyId, { umbralNoRecogidos: Number(umbral), ventanaDias: Number(ventana) });
      setPolitica(nueva);
      setEstado({ tono: "success", texto: "Política guardada." });
    } catch (err) {
      setEstado({ tono: "danger", texto: mensajeDeError(err, "No se pudo guardar la política.") });
    }
  };

  return (
    <Seccion titulo="Política de reincidentes">
      <p className="m-0 mb-2 text-ui text-muted-foreground">
        {politica === null
          ? "Cargando política…"
          : politica.umbralNoRecogidos === 0
            ? "Apagada: ningún pedido se retiene por historial."
            : `Con ${politica.umbralNoRecogidos} o más pedidos no recogidos o falsos en ${politica.ventanaDias} días, el siguiente pedido por WhatsApp o llamada lo confirma la sucursal (el agente solo dice que la sucursal lo confirma).`}
      </p>
      {puedeAdministrar && politica && (
        <form onSubmit={guardar} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <FormField label="Umbral (0 = apagada)">
            <Input inputMode="numeric" value={umbral} maxLength={2} onChange={(e) => setUmbral(e.target.value.replace(/\D/g, ""))} />
          </FormField>
          <FormField label="Ventana (días)">
            <Input inputMode="numeric" value={ventana} maxLength={3} onChange={(e) => setVentana(e.target.value.replace(/\D/g, ""))} />
          </FormField>
          <Button type="submit" size="sm" disabled={umbral === "" || ventana === ""}>
            Guardar
          </Button>
        </form>
      )}
      {estado && (
        <p role={estado.tono === "danger" ? "alert" : "status"} className={`m-0 mt-2 text-ui ${estado.tono === "danger" ? "text-destructive" : "text-success"}`}>
          {estado.texto}
        </p>
      )}
    </Seccion>
  );
}

function Arco({ api, ejecutar, confirmar }: { readonly api: Api; readonly ejecutar: Ejecutar; readonly confirmar: Confirmar }) {
  const ocupado = useContext(OcupadoContext);
  const exportar = () =>
    ejecutar(async () => {
      const datos = await exportarDatosCliente(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId);
      const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `datos-del-cliente-${api.customerId}.json`;
      enlace.click();
      URL.revokeObjectURL(url);
    }, "Exportación lista: se descargó el archivo con todo lo que se guarda de este cliente.");

  const borrar = async () => {
    const ok = await confirmar({
      titulo: "Borrar la memoria de este cliente",
      descripcion: "Se eliminan sus domicilios, gustos, notas, nombre y fecha de nacimiento. Los pedidos ya cumplidos se conservan. No se puede deshacer.",
      tono: "danger",
      confirmar: "Borrar memoria",
    });
    if (ok) await ejecutar(() => borrarMemoriaCliente(fetch, api.apiBaseUrl, api.token, api.propertyId, api.customerId), "Memoria del cliente borrada.");
  };

  return (
    <Seccion titulo="Privacidad (ARCO)">
      <p className="m-0 mb-2 text-ui text-muted-foreground">Acceso: exporta todo lo que se guarda del titular, incluidos sus gustos. Cancelación: borra su memoria.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={ocupado} onClick={exportar}>
          Exportar datos del cliente
        </Button>
        <Button size="sm" variant="outline" disabled={ocupado} onClick={borrar}>
          Borrar memoria del cliente
        </Button>
      </div>
    </Seccion>
  );
}
