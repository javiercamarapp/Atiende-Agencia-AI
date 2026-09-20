// Catálogo — Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-
// habitación/tarifas/huéspedes imposible sin SQL directo -- POST /reservas
// depende de tarifas sembradas manualmente"): pantalla mínima real para que
// owner/gm den de alta tipos de habitación, habitaciones físicas y tarifas por
// rango de fechas SIN necesitar SQL directo — hasta este cambio ninguna de las 3
// tenía forma de crearse desde el producto, así que `POST .../reservas` solo
// funcionaba si alguien había sembrado `hoteles.rate_plan` a mano.
//
// Fuera de esta pantalla (deliberadamente, ver comentario de cabecera de
// admin-catalogo.ts / migrations/018_admin_catalogo_alta.sql): alta de
// organización/property nueva -- decisión de plataforma, `core.organization`/
// `core.property` compartidas por las 6 verticales, `service_role` no
// aprovisionado en este monorepo. Alta de huésped y asignación de habitación al
// reservar viven en Reservas.tsx (acciones de front-of-house cotidianas, no de
// catálogo administrativo).
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// las 3 secciones de estilos inline por Card/Input/Label/Button reales — mismo
// criterio ya aplicado en HotelesShell.tsx/Login.tsx; los mensajes de éxito
// transitorios ("Tipo de habitación creado.", etc.) ahora usan `toast` en vez de
// un banner persistente, ya que son avisos de un solo uso, no estado de página.
//
// FASE 3 (producto) — ZONA HORARIA POR NEGOCIO: agrega la sección "Zona horaria"
// (mismo Card/rol que el resto de esta pantalla, owner/gm vía CATALOGO_NAV_ROLES en
// HotelesShell.tsx -- configurar la zona horaria es la MISMA decisión
// administrativa que gestionar el catálogo, ver migrations/
// 030_zona_horaria_property.sql). El `<select>` solo ofrece los 6 timezones IANA
// más comunes de México (CONVENIENCIA de UI) -- el backend
// (property-config.ts::requireTimeZoneOrNull) valida CUALQUIER timezone IANA real,
// nunca restringe a esta lista.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoError, Input, Label, toast } from "@atiende/ui";
import { createRateRange, createRoom, createRoomType, fetchAllRooms } from "../lib/catalogo-client.ts";
import { fetchPropertyConfig, updatePropertyTimezone } from "../lib/property-config-client.ts";
import type { PropertyConfigResult } from "../lib/property-config-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomOption, RoomTypeOption } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const selectClass =
  "mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const TIMEZONES_MEXICO_COMUNES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "America/Mexico_City", label: "Ciudad de México (centro, sur, sureste)" },
  { value: "America/Cancun", label: "Cancún / Quintana Roo" },
  { value: "America/Tijuana", label: "Tijuana / Baja California" },
  { value: "America/Chihuahua", label: "Chihuahua" },
  { value: "America/Hermosillo", label: "Hermosillo / Sonora" },
  { value: "America/Mazatlan", label: "Mazatlán / Baja California Sur, Sinaloa" },
];
const ZONA_HORARIA_SIN_CONFIGURAR = "";

export function CatalogoPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [roomTypes, setRoomTypes] = useState<readonly RoomTypeOption[] | null>(null);
  const [rooms, setRooms] = useState<readonly RoomOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setError(null);
    try {
      const [tipos, habitaciones] = await Promise.all([fetchRoomTypes(fetch, apiBaseUrl, token, propertyId), fetchAllRooms(fetch, apiBaseUrl, token, propertyId)]);
      setRoomTypes(tipos);
      setRooms(habitaciones);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
    }
  }

  useEffect(() => {
    void reload();
  }, [apiBaseUrl, token, propertyId]);

  // ---- FASE 3 (producto) — zona horaria por negocio ----
  const [propertyConfig, setPropertyConfig] = useState<PropertyConfigResult | null>(null);
  const [zonaSeleccionada, setZonaSeleccionada] = useState<string>(ZONA_HORARIA_SIN_CONFIGURAR);
  const [guardandoZona, setGuardandoZona] = useState(false);
  const [errorZona, setErrorZona] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchPropertyConfig(fetch, apiBaseUrl, token, propertyId)
      .then((config) => {
        if (cancelado) return;
        setPropertyConfig(config);
        setZonaSeleccionada(config.timezone ?? ZONA_HORARIA_SIN_CONFIGURAR);
      })
      .catch((err) => {
        if (!cancelado) setErrorZona(err instanceof Error ? err.message : "No se pudo cargar la zona horaria.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  async function handleGuardarZona(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorZona(null);
    setGuardandoZona(true);
    try {
      const timezone = zonaSeleccionada === ZONA_HORARIA_SIN_CONFIGURAR ? null : zonaSeleccionada;
      const config = await updatePropertyTimezone(fetch, apiBaseUrl, token, propertyId, timezone);
      setPropertyConfig(config);
      toast.success(timezone ? `Zona horaria guardada: ${timezone}.` : "Zona horaria limpiada -- vuelve a usar el default de plataforma.");
    } catch (err) {
      setErrorZona(err instanceof Error ? err.message : "No se pudo guardar la zona horaria.");
    } finally {
      setGuardandoZona(false);
    }
  }

  // ---- Formulario: crear tipo de habitación ----
  const [nombreTipo, setNombreTipo] = useState("");
  const [capacidadTipo, setCapacidadTipo] = useState("2");
  const [creandoTipo, setCreandoTipo] = useState(false);
  const [errorTipo, setErrorTipo] = useState<string | null>(null);

  async function handleCrearTipo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorTipo(null);
    if (!nombreTipo.trim()) return setErrorTipo("El nombre es requerido.");
    setCreandoTipo(true);
    try {
      await createRoomType(fetch, apiBaseUrl, token, propertyId, nombreTipo.trim(), Number(capacidadTipo) || undefined);
      setNombreTipo("");
      setCapacidadTipo("2");
      toast.success("Tipo de habitación creado.");
      await reload();
    } catch (err) {
      setErrorTipo(err instanceof Error ? err.message : "No se pudo crear el tipo de habitación.");
    } finally {
      setCreandoTipo(false);
    }
  }

  // ---- Formulario: crear habitación física ----
  const [roomTypeIdHabitacion, setRoomTypeIdHabitacion] = useState("");
  const [codigoHabitacion, setCodigoHabitacion] = useState("");
  const [creandoHabitacion, setCreandoHabitacion] = useState(false);
  const [errorHabitacion, setErrorHabitacion] = useState<string | null>(null);

  async function handleCrearHabitacion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorHabitacion(null);
    if (!roomTypeIdHabitacion) return setErrorHabitacion("Selecciona un tipo de habitación.");
    if (!codigoHabitacion.trim()) return setErrorHabitacion("El código/número de cuarto es requerido.");
    setCreandoHabitacion(true);
    try {
      await createRoom(fetch, apiBaseUrl, token, propertyId, roomTypeIdHabitacion, codigoHabitacion.trim());
      setCodigoHabitacion("");
      toast.success("Habitación creada.");
      await reload();
    } catch (err) {
      setErrorHabitacion(err instanceof Error ? err.message : "No se pudo crear la habitación.");
    } finally {
      setCreandoHabitacion(false);
    }
  }

  // ---- Formulario: crear tarifa (la pieza que de verdad desbloquea POST /reservas) ----
  const [roomTypeIdTarifa, setRoomTypeIdTarifa] = useState("");
  const [fechaInicio, setFechaInicio] = useState("");
  const [fechaFin, setFechaFin] = useState("");
  const [precio, setPrecio] = useState("");
  const [creandoTarifa, setCreandoTarifa] = useState(false);
  const [errorTarifa, setErrorTarifa] = useState<string | null>(null);

  async function handleCrearTarifa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorTarifa(null);
    if (!roomTypeIdTarifa) return setErrorTarifa("Selecciona un tipo de habitación.");
    if (!fechaInicio || !fechaFin) return setErrorTarifa("Fecha inicio y fecha fin son requeridas.");
    const precioNum = Number(precio);
    if (!Number.isFinite(precioNum) || precioNum < 0) return setErrorTarifa("El precio debe ser un número >= 0.");
    setCreandoTarifa(true);
    try {
      const result = await createRateRange(fetch, apiBaseUrl, token, propertyId, { roomTypeId: roomTypeIdTarifa, fechaInicio, fechaFin, precio: precioNum });
      setFechaInicio("");
      setFechaFin("");
      setPrecio("");
      toast.success(`Tarifa sembrada: ${result.nochesSembradas} noche(s) a ${result.precio} ${result.moneda}.`);
    } catch (err) {
      setErrorTarifa(err instanceof Error ? err.message : "No se pudo crear la tarifa.");
    } finally {
      setCreandoTarifa(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-display font-semibold text-foreground">Catálogo</h1>
        <p className="mt-1 text-sm text-muted-foreground">Tipos de habitación, habitaciones físicas y tarifas de esta property.</p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void reload()} />}

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Zona horaria</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Decide qué día calendario es "hoy" para el night-audit, vencimientos y el motor de recomendaciones de tarifa de esta property. Sin
            configurar, se usa el default de plataforma ({propertyConfig?.timezonePorDefecto ?? "America/Mexico_City"}) — un hotel en Cancún,
            Tijuana o Los Cabos debería configurar la suya.
          </p>
          {propertyConfig && (
            <p className="text-xs text-foreground">
              Zona en uso hoy: <strong>{propertyConfig.timezoneEfectiva}</strong>
              {propertyConfig.timezone === null && " (sin configurar, default de plataforma)"}
            </p>
          )}
          <form onSubmit={handleGuardarZona} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="cat-zona-horaria">Zona horaria IANA</Label>
              <select id="cat-zona-horaria" value={zonaSeleccionada} onChange={(e) => setZonaSeleccionada(e.target.value)} className={selectClass}>
                <option value={ZONA_HORARIA_SIN_CONFIGURAR}>Sin configurar (usa el default de plataforma)</option>
                {TIMEZONES_MEXICO_COMUNES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
            {errorZona && <p role="alert" className="text-sm text-destructive">{errorZona}</p>}
            <Button type="submit" disabled={guardandoZona}>
              {guardandoZona ? "Guardando…" : "Guardar zona horaria"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Tipos de habitación</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="text-sm space-y-1">
            {roomTypes === null && <li className="text-muted-foreground">Cargando…</li>}
            {roomTypes?.length === 0 && <li className="text-muted-foreground">Sin tipos de habitación todavía.</li>}
            {roomTypes?.map((rt) => (
              <li key={rt.id} className="text-foreground">
                {rt.nombre} (máx. {rt.capacidadMaxima} huéspedes)
              </li>
            ))}
          </ul>
          <form onSubmit={handleCrearTipo} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="cat-nombre-tipo">Nombre</Label>
              <Input id="cat-nombre-tipo" value={nombreTipo} onChange={(e) => setNombreTipo(e.target.value)} placeholder="Ej. Habitación Doble Vista al Mar" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="cat-capacidad-tipo">Capacidad máxima de huéspedes</Label>
              <Input id="cat-capacidad-tipo" type="number" min="1" value={capacidadTipo} onChange={(e) => setCapacidadTipo(e.target.value)} className="mt-1" />
            </div>
            {errorTipo && <p role="alert" className="text-sm text-destructive">{errorTipo}</p>}
            <Button type="submit" disabled={creandoTipo}>
              {creandoTipo ? "Creando…" : "Crear tipo de habitación"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Habitaciones físicas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="text-sm space-y-1 max-h-36 overflow-auto">
            {rooms === null && <li className="text-muted-foreground">Cargando…</li>}
            {rooms?.length === 0 && <li className="text-muted-foreground">Sin habitaciones todavía.</li>}
            {rooms?.map((r) => (
              <li key={r.id} className="text-foreground">
                {r.codigo} — {roomTypes?.find((rt) => rt.id === r.roomTypeId)?.nombre ?? r.roomTypeId} ({r.estado})
              </li>
            ))}
          </ul>
          <form onSubmit={handleCrearHabitacion} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="cat-tipo-habitacion">Tipo de habitación</Label>
              <select id="cat-tipo-habitacion" value={roomTypeIdHabitacion} onChange={(e) => setRoomTypeIdHabitacion(e.target.value)} className={selectClass}>
                <option value="" disabled>
                  Selecciona un tipo de habitación
                </option>
                {roomTypes?.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.nombre}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="cat-codigo-habitacion">Código / número de cuarto</Label>
              <Input id="cat-codigo-habitacion" value={codigoHabitacion} onChange={(e) => setCodigoHabitacion(e.target.value)} placeholder="Ej. 101" className="mt-1" />
            </div>
            {errorHabitacion && <p role="alert" className="text-sm text-destructive">{errorHabitacion}</p>}
            <Button type="submit" disabled={creandoHabitacion}>
              {creandoHabitacion ? "Creando…" : "Crear habitación"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Tarifas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Siembra el precio por noche de un rango de fechas para un tipo de habitación — sin esto, crear una reserva contra esas fechas falla con
            "sin tarifa". Un rango que traslapa fechas ya sembradas las sobreescribe.
          </p>
          <form onSubmit={handleCrearTarifa} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="cat-tipo-tarifa">Tipo de habitación</Label>
              <select id="cat-tipo-tarifa" value={roomTypeIdTarifa} onChange={(e) => setRoomTypeIdTarifa(e.target.value)} className={selectClass}>
                <option value="" disabled>
                  Selecciona un tipo de habitación
                </option>
                {roomTypes?.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.nombre}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <Label htmlFor="cat-fecha-inicio">Desde</Label>
                <Input id="cat-fecha-inicio" type="date" value={fechaInicio} onChange={(e) => setFechaInicio(e.target.value)} className="mt-1" />
              </div>
              <div className="flex-1">
                <Label htmlFor="cat-fecha-fin">Hasta</Label>
                <Input id="cat-fecha-fin" type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)} className="mt-1" />
              </div>
            </div>
            <div>
              <Label htmlFor="cat-precio">Precio por noche (MXN)</Label>
              <Input id="cat-precio" type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} className="mt-1" />
            </div>
            {errorTarifa && <p role="alert" className="text-sm text-destructive">{errorTarifa}</p>}
            <Button type="submit" disabled={creandoTarifa}>
              {creandoTarifa ? "Sembrando…" : "Crear tarifa"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
