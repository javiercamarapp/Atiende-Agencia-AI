// Bandeja de aprobación de mensajería (cierra el hallazgo de auditoría ALTA
// "Mensajería con aprobación humana obligatoria: la cola de aprobación no tiene botón
// de aprobar"): mensajeria-conversaciones.ts/mensajeria-borradores.ts ya exponían
// GET/POST generar borrador, POST aprobar y POST rechazar desde antes de esta fase,
// pero ningún cliente web los consumía -- en la práctica nadie podía aprobar nada, el
// principio de diseño "un agente redacta y no sale hasta que alguien lo aprueba"
// vivía solo en el backend.
//
// Vista real: agrega, con `fetchBandejaAprobacion` (lib/mensajeria-client.ts), cada
// conversación de la property con sus borradores todavía `pendiente_aprobacion` --
// las que sí tienen algo por revisar aparecen primero. Cada tarjeta trae Aprobar
// (POST .../aprobar, sin confirmación adicional: el texto ya está a la vista) y
// Rechazar (revela un textarea de motivo, obligatorio -- mismo criterio de
// confirmación inline que "Modificar fechas" en Calendario.tsx). Aprobar/Rechazar se
// gatean en el CLIENTE por `MENSAJERIA_ESCRITURA_ROLES`
// (packages/domain-rentas/src/roles.ts), mismo patrón que
// `PRICING_ESCRITURA_ROLES` en Precios.tsx -- el servidor SIEMPRE re-valida con
// `assertVerticalRole`, este gate es solo UX para no ofrecer un botón que el
// servidor rechazaría con 403.
//
// Nota honesta (fuera de alcance de esta fase, NO se oculta): aprobar un borrador
// hoy dispara `SimuladorCanalMensajeria`, no un adaptador real de WhatsApp/Airbnb/
// Vrbo -- ver el aviso fijo debajo del encabezado y README.md de este vertical.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { aprobarBorrador, CANAL_LABELS, fetchBandejaAprobacion, rechazarBorrador } from "../lib/mensajeria-client.ts";
import type { BorradorRecord, ItemBandeja } from "../lib/mensajeria-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const MENSAJERIA_ESCRITURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

const cardStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 10 };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const secondaryButtonStyle: CSSProperties = { padding: "5px 12px", borderRadius: 8, border: "1px solid #6b7280", background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer" };
const dangerButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const textareaStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box", fontFamily: "inherit", fontSize: 13 };
const noticeStyle: CSSProperties = { margin: 0, fontSize: 13, color: "#065f46", background: "#d1fae5", padding: "8px 12px", borderRadius: 8 };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };
const badgeStyle = (bg: string, fg: string): CSSProperties => ({ fontSize: 11, padding: "3px 9px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

function contextoLinea(item: ItemBandeja): string {
  const partes: string[] = [item.unidad.nombre, CANAL_LABELS[item.conversacion.canal]];
  if (item.conversacion.huespedNombre) partes.push(`huésped: ${item.conversacion.huespedNombre}`);
  if (item.conversacion.fechaCheckIn || item.conversacion.fechaCheckOut) {
    partes.push(`${item.conversacion.fechaCheckIn ?? "?"} → ${item.conversacion.fechaCheckOut ?? "?"}`);
  }
  if (item.conversacion.reservaConfirmada) partes.push("reserva confirmada");
  return partes.join(" · ");
}

function historialBadge(b: BorradorRecord): { bg: string; fg: string; label: string } {
  if (b.estado === "enviado") return { bg: "#dbeafe", fg: "#1e40af", label: "Enviado" };
  if (b.estado === "rechazado") return { bg: "#fee2e2", fg: "#b91c1c", label: "Rechazado" };
  return { bg: "#f3f4f6", fg: "#6b7280", label: "Aprobado" };
}

interface BorradorCardProps {
  readonly item: ItemBandeja;
  readonly borrador: BorradorRecord;
  readonly puedeEscribir: boolean;
  readonly busy: boolean;
  readonly onAprobar: (borradorId: string) => void;
  readonly onRechazar: (borradorId: string, motivo: string) => void;
}

function BorradorPendienteCard({ item, borrador, puedeEscribir, busy, onAprobar, onRechazar }: BorradorCardProps) {
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [motivoError, setMotivoError] = useState<string | null>(null);

  function confirmarRechazo() {
    if (!motivo.trim()) {
      setMotivoError("El motivo es requerido para rechazar un borrador.");
      return;
    }
    onRechazar(borrador.id, motivo.trim());
  }

  return (
    <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#92400e" }}>
          {borrador.generadoPor === "agente_llm" ? "Generado por agente IA" : "Generado por motor de plantillas"} · {new Date(borrador.creadoEn).toLocaleString("es-MX")}
        </span>
        <span style={badgeStyle("#fef3c7", "#92400e")}>Pendiente de aprobación</span>
      </div>
      <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap" }}>{borrador.texto}</p>
      {puedeEscribir ? (
        rechazando ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12 }}>
              Motivo del rechazo
              <textarea
                value={motivo}
                onChange={(e) => {
                  setMotivo(e.target.value);
                  setMotivoError(null);
                }}
                rows={2}
                style={textareaStyle}
                placeholder="Por qué se rechaza este borrador"
              />
            </label>
            {motivoError && (
              <p role="alert" style={{ ...errorStyle, fontSize: 12 }}>
                {motivoError}
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={confirmarRechazo} disabled={busy} style={dangerButtonStyle}>
                {busy ? "Rechazando…" : "Confirmar rechazo"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRechazando(false);
                  setMotivo("");
                  setMotivoError(null);
                }}
                disabled={busy}
                style={secondaryButtonStyle}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => onAprobar(borrador.id)} disabled={busy} style={primaryButtonStyle}>
              {busy ? "Aprobando…" : "Aprobar y enviar"}
            </button>
            <button type="button" onClick={() => setRechazando(true)} disabled={busy} style={dangerButtonStyle}>
              Rechazar
            </button>
          </div>
        )
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>Tu rol no puede aprobar ni rechazar mensajería. Contacta a un admin_gestora u operador con acceso a calendario/mensajería. (Conversación: {item.conversacion.id})</p>
      )}
    </div>
  );
}

export function AprobacionesPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? MENSAJERIA_ESCRITURA_ROLES.has(org.rol) : false;

  const [items, setItems] = useState<readonly ItemBandeja[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandidoHistorial, setExpandidoHistorial] = useState<Record<string, boolean>>({});

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const bandeja = await fetchBandejaAprobacion(fetch, apiBaseUrl, token, propertyId);
      setItems(bandeja);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la bandeja de aprobación.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    setItems(null);
    void cargar();
  }, [cargar]);

  async function handleAprobar(borradorId: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await aprobarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId);
      setNotice("Borrador aprobado y enviado (canal simulado, ver nota abajo).");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo aprobar el borrador.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRechazar(borradorId: string, motivo: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await rechazarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId, motivo);
      setNotice("Borrador rechazado.");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo rechazar el borrador.");
    } finally {
      setBusyId(null);
    }
  }

  const totalPendientes = items?.reduce((acc, item) => acc + item.pendientes.length, 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Bandeja de aprobación de mensajería</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>
          Todo borrador generado para un huésped queda en <strong>pendiente_aprobacion</strong> hasta que alguien lo aprueba o lo rechaza aquí — ningún proceso automático puede enviarlo (ver
          POST .../intento-automatico, que siempre es rechazado).
        </p>
      </header>

      <p style={{ margin: 0, fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px" }}>
        Nota honesta: aprobar un borrador aquí lo envía a través de un <strong>simulador de canal</strong> (SimuladorCanalMensajeria) — todavía no hay un adaptador real de WhatsApp, Airbnb ni
        Vrbo conectado en este vertical. El mensaje queda registrado como enviado en este panel, pero el huésped real no lo recibe.
      </p>

      {notice && <p style={noticeStyle}>{notice}</p>}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
      {!items && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {items && items.length === 0 && <p style={{ color: "#6b7280" }}>No hay ninguna conversación con mensajería en esta propiedad todavía.</p>}
      {items && items.length > 0 && (
        <p style={{ margin: 0, fontSize: 13, color: totalPendientes > 0 ? "#92400e" : "#065f46" }}>
          {totalPendientes > 0 ? `${totalPendientes} borrador(es) esperando aprobación.` : "No hay ningún borrador pendiente de aprobación en este momento."}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items?.map((item) => (
          <div key={item.conversacion.id} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{contextoLinea(item)}</p>
              {item.pendientes.length === 0 && <span style={badgeStyle("#f3f4f6", "#6b7280")}>Sin pendientes</span>}
            </div>

            {item.pendientes.map((borrador) => (
              <BorradorPendienteCard
                key={borrador.id}
                item={item}
                borrador={borrador}
                puedeEscribir={puedeEscribir}
                busy={busyId === borrador.id}
                onAprobar={handleAprobar}
                onRechazar={handleRechazar}
              />
            ))}

            {item.historial.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandidoHistorial((prev) => ({ ...prev, [item.conversacion.id]: !prev[item.conversacion.id] }))}
                  style={{ ...secondaryButtonStyle, padding: "3px 8px" }}
                >
                  {expandidoHistorial[item.conversacion.id] ? "Ocultar historial" : `Ver historial (${item.historial.length})`}
                </button>
                {expandidoHistorial[item.conversacion.id] && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {item.historial.map((b) => {
                      const badge = historialBadge(b);
                      return (
                        <div key={b.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, color: "#6b7280" }}>{new Date(b.creadoEn).toLocaleString("es-MX")}</span>
                            <span style={badgeStyle(badge.bg, badge.fg)}>{badge.label}</span>
                          </div>
                          <p style={{ margin: "4px 0 0", fontSize: 13, whiteSpace: "pre-wrap" }}>{b.texto}</p>
                          {b.estado === "rechazado" && b.motivoRechazo && (
                            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#b91c1c" }}>Motivo: {b.motivoRechazo}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
