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
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { createRateRange, createRoom, createRoomType, fetchAllRooms } from "../lib/catalogo-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomOption, RoomTypeOption } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function inputStyle(): CSSProperties {
  return { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
}

const sectionStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 480 };
const submitStyle: CSSProperties = { padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" };

export function CatalogoPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [roomTypes, setRoomTypes] = useState<readonly RoomTypeOption[] | null>(null);
  const [rooms, setRooms] = useState<readonly RoomOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

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
      setMensaje("Tipo de habitación creado.");
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
      setMensaje("Habitación creada.");
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
      setMensaje(`Tarifa sembrada: ${result.nochesSembradas} noche(s) a ${result.precio} ${result.moneda}.`);
    } catch (err) {
      setErrorTarifa(err instanceof Error ? err.message : "No se pudo crear la tarifa.");
    } finally {
      setCreandoTarifa(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Catálogo</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Tipos de habitación, habitaciones físicas y tarifas de esta property.</p>
      </header>

      {mensaje && (
        <p style={{ margin: 0, fontSize: 13, color: "#065f46" }} role="status">
          {mensaje}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tipos de habitación</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {roomTypes === null && <li style={{ color: "#6b7280", listStyle: "none", marginLeft: -18 }}>Cargando…</li>}
          {roomTypes?.length === 0 && <li style={{ color: "#6b7280", listStyle: "none", marginLeft: -18 }}>Sin tipos de habitación todavía.</li>}
          {roomTypes?.map((rt) => (
            <li key={rt.id}>
              {rt.nombre} (máx. {rt.capacidadMaxima} huéspedes)
            </li>
          ))}
        </ul>
        <form onSubmit={handleCrearTipo} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Nombre
            <input value={nombreTipo} onChange={(e) => setNombreTipo(e.target.value)} placeholder="Ej. Habitación Doble Vista al Mar" style={inputStyle()} />
          </label>
          <label style={{ fontSize: 13 }}>
            Capacidad máxima de huéspedes
            <input type="number" min="1" value={capacidadTipo} onChange={(e) => setCapacidadTipo(e.target.value)} style={inputStyle()} />
          </label>
          {errorTipo && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {errorTipo}
            </p>
          )}
          <button type="submit" disabled={creandoTipo} style={submitStyle}>
            {creandoTipo ? "Creando…" : "Crear tipo de habitación"}
          </button>
        </form>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Habitaciones físicas</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, maxHeight: 140, overflow: "auto" }}>
          {rooms === null && <li style={{ color: "#6b7280", listStyle: "none", marginLeft: -18 }}>Cargando…</li>}
          {rooms?.length === 0 && <li style={{ color: "#6b7280", listStyle: "none", marginLeft: -18 }}>Sin habitaciones todavía.</li>}
          {rooms?.map((r) => (
            <li key={r.id}>
              {r.codigo} — {roomTypes?.find((rt) => rt.id === r.roomTypeId)?.nombre ?? r.roomTypeId} ({r.estado})
            </li>
          ))}
        </ul>
        <form onSubmit={handleCrearHabitacion} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Tipo de habitación
            <select value={roomTypeIdHabitacion} onChange={(e) => setRoomTypeIdHabitacion(e.target.value)} style={inputStyle()}>
              <option value="" disabled>
                Selecciona un tipo de habitación
              </option>
              {roomTypes?.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.nombre}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Código / número de cuarto
            <input value={codigoHabitacion} onChange={(e) => setCodigoHabitacion(e.target.value)} placeholder="Ej. 101" style={inputStyle()} />
          </label>
          {errorHabitacion && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {errorHabitacion}
            </p>
          )}
          <button type="submit" disabled={creandoHabitacion} style={submitStyle}>
            {creandoHabitacion ? "Creando…" : "Crear habitación"}
          </button>
        </form>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tarifas</h2>
        <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
          Siembra el precio por noche de un rango de fechas para un tipo de habitación — sin esto, crear una reserva contra esas fechas falla con
          "sin tarifa". Un rango que traslapa fechas ya sembradas las sobreescribe.
        </p>
        <form onSubmit={handleCrearTarifa} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Tipo de habitación
            <select value={roomTypeIdTarifa} onChange={(e) => setRoomTypeIdTarifa(e.target.value)} style={inputStyle()}>
              <option value="" disabled>
                Selecciona un tipo de habitación
              </option>
              {roomTypes?.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.nombre}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ fontSize: 13, flex: 1 }}>
              Desde
              <input type="date" value={fechaInicio} onChange={(e) => setFechaInicio(e.target.value)} style={inputStyle()} />
            </label>
            <label style={{ fontSize: 13, flex: 1 }}>
              Hasta
              <input type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)} style={inputStyle()} />
            </label>
          </div>
          <label style={{ fontSize: 13 }}>
            Precio por noche (MXN)
            <input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} style={inputStyle()} />
          </label>
          {errorTarifa && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {errorTarifa}
            </p>
          )}
          <button type="submit" disabled={creandoTarifa} style={submitStyle}>
            {creandoTarifa ? "Sembrando…" : "Crear tarifa"}
          </button>
        </form>
      </section>
    </div>
  );
}
