// H-12 -- pestana "Lista de espera" de Reservas: cola de huespedes que quieren un tipo de habitacion y fechas sin cupo. Todo dato y
// toda accion salen del servidor (apps/api/.../hoteles/lista-espera.ts): agregar, ofrecer a mano, aceptar (crea la reserva con la
// cotizacion VIGENTE y guardia de precio) y cancelar. Las ofertas automaticas (al cancelar o acortar) llegan solas desde el servidor.
// "Cancelar"/"Volver" en un dialogo nunca ejecuta la accion. Base sin migrar: aviso honesto, sin controles que fallarian.
import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, StatusBadge, Textarea, useConfirm } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import {
  ESTADO_LISTA_ESPERA_LABELS,
  LISTA_ESPERA_ROLES,
  aceptarEntrada,
  agregarAListaEspera,
  cancelarEntrada,
  fetchListaEspera,
  ofrecerEntrada,
} from "../lib/lista-espera-client.ts";
import type { EntradaListaEspera, EstadoListaEspera, ListadoListaEspera } from "../lib/lista-espera-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

const TONOS: Readonly<Record<EstadoListaEspera, StatusTone>> = { activa: "info", ofrecida: "warning", aceptada: "success", expirada: "neutral", cancelada: "danger" };

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  /** El padre recarga sus reservas tras aceptar una oferta (se crea una reserva nueva). */
  readonly onReservaCreada?: () => void;
}

const VACIO = { tipo: "", entrada: "", salida: "", huespedes: "1", nombre: "", telefono: "", email: "", notas: "" };

function formatoVence(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

export function ListaEsperaPanel({ apiBaseUrl, token, propertyId, role, onReservaCreada }: Props) {
  const [listado, setListado] = useState<ListadoListaEspera | null>(null);
  const [tipos, setTipos] = useState<readonly RoomTypeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [form, setForm] = useState(VACIO);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const { confirmar, dialogo } = useConfirm();
  const puede = LISTA_ESPERA_ROLES.has(role);

  const cargar = useCallback(async () => {
    if (!puede) return;
    setError(null);
    try {
      // En secuencia: ambas lecturas comparten la sesion transaccional del servidor por request, no entre ellas, pero asi el error es claro.
      const lista = await fetchListaEspera(fetch, apiBaseUrl, token, propertyId);
      setListado(lista);
      setTipos(await fetchRoomTypes(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la lista de espera.");
    }
  }, [apiBaseUrl, token, propertyId, puede]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function ejecutar(clave: string, fn: () => Promise<string>) {
    setOcupado(clave);
    setError(null);
    setAviso(null);
    try {
      setAviso(await fn());
      await cargar();
    } catch (err) {
      // Recarga primero (el estado pudo cambiar: oferta vencida, cupo tomado) y DESPUES muestra el rechazo real del servidor:
      // `cargar` limpia el error al empezar y borraria el mensaje.
      await cargar();
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setOcupado(null);
    }
  }

  if (!puede) return <EstadoVacio mensaje="Tu rol no tiene acceso a la lista de espera." />;

  const nombreTipo = (id: string) => tipos.find((t) => t.id === id)?.nombre ?? "Tipo de habitación";

  async function guardar() {
    setGuardando(true);
    setErrorForm(null);
    try {
      const huespedes = Number.parseInt(form.huespedes, 10);
      const e = await agregarAListaEspera(fetch, apiBaseUrl, token, propertyId, {
        roomTypeId: form.tipo,
        checkInDate: form.entrada,
        checkOutDate: form.salida,
        huespedes: Number.isFinite(huespedes) ? huespedes : 0,
        nombre: form.nombre.trim(),
        ...(form.telefono.trim() ? { telefono: form.telefono.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.notas.trim() ? { notas: form.notas.trim() } : {}),
      });
      setAbierto(false);
      setForm(VACIO);
      setAviso(`${e.nombre} quedó en la lista de espera.`);
      await cargar();
    } catch (err) {
      setErrorForm(err instanceof Error ? err.message : "No se pudo agregar a la lista de espera.");
    } finally {
      setGuardando(false);
    }
  }

  async function cancelar(e: EntradaListaEspera) {
    if (!(await confirmar({ titulo: "Cancelar entrada", descripcion: `¿Quitar a ${e.nombre} de la lista de espera?`, tono: "danger", confirmar: "Sí, cancelar entrada", cancelar: "Volver" }))) return;
    await ejecutar(e.id, async () => {
      await cancelarEntrada(fetch, apiBaseUrl, token, propertyId, e.id);
      return `${e.nombre} salió de la lista de espera.`;
    });
  }

  async function aceptar(e: EntradaListaEspera) {
    const total = e.cotizacionVigente?.total;
    if (total === undefined) return;
    const ok = await confirmar({
      titulo: "Aceptar oferta",
      descripcion: `Se creará la reserva de ${e.nombre} del ${formatFechaSolo(e.entrada)} al ${formatFechaSolo(e.salida)} por ${dineroMx(total)} (cotización vigente, con impuestos).`,
      confirmar: "Crear reserva",
      cancelar: "Volver",
    });
    if (!ok) return;
    await ejecutar(e.id, async () => {
      await aceptarEntrada(fetch, apiBaseUrl, token, propertyId, e.id, total, newIdempotencyKey());
      onReservaCreada?.();
      return `Reserva creada para ${e.nombre}.`;
    });
  }

  const columnas = [
    {
      id: "huesped",
      encabezado: "Huésped",
      principal: true,
      celda: (e: EntradaListaEspera) => (
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{e.nombre}</span>
          <span className="text-xs text-muted-foreground">{[e.telefono, e.email].filter(Boolean).join(" · ")}</span>
        </div>
      ),
    },
    { id: "tipo", encabezado: "Tipo", celda: (e: EntradaListaEspera) => <span className="text-sm">{nombreTipo(e.tipoHabitacionId)}</span> },
    {
      id: "fechas",
      encabezado: "Fechas",
      valorOrden: (e: EntradaListaEspera) => e.entrada,
      celda: (e: EntradaListaEspera) => (
        <span className="text-sm">
          {formatFechaSolo(e.entrada)} → {formatFechaSolo(e.salida)} · {e.huespedes} huésped{e.huespedes === 1 ? "" : "es"}
        </span>
      ),
    },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (e: EntradaListaEspera) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge tone={TONOS[e.estado]}>{ESTADO_LISTA_ESPERA_LABELS[e.estado]}</StatusBadge>
          {e.estado === "ofrecida" && e.ofertaVenceEn && <span className="text-xs text-muted-foreground">Vence {formatoVence(e.ofertaVenceEn)}</span>}
        </div>
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      etiqueta: "Acciones",
      ocultarEnTarjeta: false,
      celda: (e: EntradaListaEspera) => (
        <div className="flex flex-wrap gap-2">
          {e.estado === "activa" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={ocupado === e.id}
              onClick={() =>
                void ejecutar(e.id, async () => {
                  await ofrecerEntrada(fetch, apiBaseUrl, token, propertyId, e.id);
                  return `Se ofreció lugar a ${e.nombre}. Contáctala/o: la oferta vence en 24 horas.`;
                })
              }
            >
              Ofrecer lugar
            </Button>
          )}
          {e.estado === "ofrecida" && (
            <Button type="button" size="sm" loading={ocupado === e.id} disabled={e.cotizacionVigente === null} title={e.cotizacionVigente === null ? "No se pudo cotizar: revisa las tarifas de esas fechas" : undefined} onClick={() => void aceptar(e)}>
              {e.cotizacionVigente ? `Aceptar · ${dineroMx(e.cotizacionVigente.total)}` : "Sin cotización"}
            </Button>
          )}
          {(e.estado === "activa" || e.estado === "ofrecida") && (
            <Button type="button" size="sm" variant="outline" className="text-destructive border-destructive/40 hover:border-destructive" disabled={ocupado === e.id} onClick={() => void cancelar(e)}>
              Cancelar
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">Cola por orden de llegada. Al cancelar una reserva o acortar fechas, el sistema ofrece el lugar a la primera entrada compatible y te avisa.</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" aria-label="Actualizar lista de espera" onClick={() => void cargar()}>
            <RefreshCw className="size-4" strokeWidth={1.75} />
          </Button>
          <Button type="button" disabled={listado?.disponible === false} onClick={() => { setForm(VACIO); setErrorForm(null); setAbierto(true); }}>
            <Plus className="size-4" strokeWidth={1.75} />
            Agregar a la lista
          </Button>
        </div>
      </div>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void cargar()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      {!listado && !error && <EstadoCargando etiqueta="Cargando lista de espera…" />}
      {listado && !listado.disponible && (
        <EstadoVacio mensaje="La lista de espera aún no está activa en esta base de datos: requiere aplicar la migración 041 de hoteles." />
      )}
      {listado?.disponible && (
        <DataTable
          etiqueta="Lista de espera"
          columnas={columnas}
          filas={listado.entradas}
          obtenerId={(e) => e.id}
          vacio={{ mensaje: "No hay nadie en la lista de espera." }}
        />
      )}

      <FormDialog
        open={abierto}
        onOpenChange={(v) => { if (!v && !guardando) setAbierto(false); }}
        titulo="Agregar a la lista de espera"
        subtitulo="Solo nombre y un contacto: sin documentos ni datos de pago."
        anchoClase="max-w-xl"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setAbierto(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-lista-espera" loading={guardando} disabled={guardando}>
              {guardando ? "Guardando…" : "Agregar"}
            </Button>
          </>
        }
      >
        <form id="form-lista-espera" className="flex flex-col gap-3" onSubmit={(ev) => { ev.preventDefault(); void guardar(); }}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="le-tipo">Tipo de habitación</Label>
            <NativeSelect id="le-tipo" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })} required>
              <option value="" disabled>Selecciona un tipo</option>
              {tipos.map((t) => (
                <option key={t.id} value={t.id}>{t.nombre} (máx. {t.capacidadMaxima})</option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="le-entrada">Llegada</Label>
              <Input id="le-entrada" type="date" value={form.entrada} onChange={(e) => setForm({ ...form, entrada: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="le-salida">Salida</Label>
              <Input id="le-salida" type="date" value={form.salida} onChange={(e) => setForm({ ...form, salida: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="le-huespedes">Huéspedes</Label>
              <Input id="le-huespedes" type="number" min={1} max={20} value={form.huespedes} onChange={(e) => setForm({ ...form, huespedes: e.target.value })} required />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="le-nombre">Nombre</Label>
            <Input id="le-nombre" value={form.nombre} maxLength={120} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="le-telefono">Teléfono</Label>
              <Input id="le-telefono" value={form.telefono} maxLength={20} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="le-email">Correo</Label>
              <Input id="le-email" type="email" value={form.email} maxLength={160} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Captura al menos un teléfono o un correo.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="le-notas">Notas (opcional)</Label>
            <Textarea id="le-notas" rows={2} maxLength={300} value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
          </div>
          {errorForm && <p role="alert" className="text-sm text-destructive">{errorForm}</p>}
        </form>
      </FormDialog>
      {dialogo}
    </div>
  );
}
