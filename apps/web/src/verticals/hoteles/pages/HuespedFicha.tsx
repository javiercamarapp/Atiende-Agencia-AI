// Ficha de huesped (H-27) -- perfil, resumen e historial de estancias, notas y preferencias, solicitudes de contacto,
// consentimientos y estado de identidad/ARCO. Consume apps/api/.../hoteles/huespedes.ts. Privacidad: el documento del
// huesped NUNCA se muestra aqui (solo si ya hay identidad registrada; se captura y revela en Identidad); las notas rechazan
// numeros de tarjeta/documento; con una solicitud ARCO de cancelacion u oposicion en curso no se agregan notas. Lo que la
// base aun no tiene (migraciones 031/032/038) se dice como "no disponible aun", nunca como "sin datos".
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Archive, Download, MessagesSquare } from "lucide-react";
import { Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormField, NativeSelect, PageContainer, PageHeader, StatusBadge, Textarea } from "@atiende/ui";
import { formatMoney } from "@atiende/ui";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import { HUESPED_CRM_ROLES, HUESPED_EXPORT_ROLES, NOTA_MAX_LENGTH, NOTA_TIPO_LABELS, agregarNota, archivarNota, exportarDatosHuesped, fetchFicha, notaTieneDatoSensible } from "../lib/huespedes-client.ts";
import type { ExportFormato, Ficha, NotaTipo } from "../lib/huespedes-client.ts";
import { RESERVA_ESTADO_LABELS } from "../lib/recepcion-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ESTADO_ESTANCIA: Record<string, string> = { ...RESERVA_ESTADO_LABELS, cancelada: "Cancelada", no_show: "No se presentó", cotizada: "Cotizada" };

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{titulo}</h2>
        {children}
      </CardContent>
    </Card>
  );
}

export function HuespedFichaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const { guestId = "" } = useParams<{ guestId: string }>();
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorNota, setErrorNota] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tipo, setTipo] = useState<NotaTipo>("nota");
  const [texto, setTexto] = useState("");
  const [exportando, setExportando] = useState<ExportFormato | null>(null);
  const [errorExport, setErrorExport] = useState<string | null>(null);
  const puedeVer = HUESPED_CRM_ROLES.has(role);
  const puedeExportar = HUESPED_EXPORT_ROLES.has(role);

  const load = useCallback(async () => {
    if (!puedeVer) return;
    setError(null);
    try {
      setFicha(await fetchFicha(fetch, apiBaseUrl, token, propertyId, guestId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la ficha del huésped.");
    }
  }, [apiBaseUrl, token, propertyId, guestId, puedeVer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!puedeVer) {
    return (
      <PageContainer padding="none" className="gap-4">
        <EstadoVacio mensaje="Tu rol no tiene acceso a la ficha de huéspedes." />
      </PageContainer>
    );
  }

  async function guardarNota(e: FormEvent) {
    e.preventDefault();
    const limpio = texto.trim();
    if (!limpio) return;
    if (notaTieneDatoSensible(limpio)) {
      setErrorNota("No captures números de tarjeta ni de documento en una nota: la identidad se registra solo en Identidad.");
      return;
    }
    setBusy(true);
    setErrorNota(null);
    try {
      await agregarNota(fetch, apiBaseUrl, token, propertyId, guestId, tipo, limpio);
      setTexto("");
      await load();
    } catch (err) {
      setErrorNota(err instanceof Error ? err.message : "No se pudo guardar la nota.");
    } finally {
      setBusy(false);
    }
  }

  async function archivar(noteId: string) {
    setBusy(true);
    setErrorNota(null);
    try {
      await archivarNota(fetch, apiBaseUrl, token, propertyId, guestId, noteId);
      await load();
    } catch (err) {
      setErrorNota(err instanceof Error ? err.message : "No se pudo archivar la nota.");
    } finally {
      setBusy(false);
    }
  }

  const restringido = ficha?.arco?.restriccion === true;

  async function exportar(formato: ExportFormato) {
    setExportando(formato);
    setErrorExport(null);
    try {
      const blob = await exportarDatosHuesped(fetch, apiBaseUrl, token, propertyId, guestId, formato);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `datos-huesped-${guestId.slice(0, 8)}.${formato}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorExport(err instanceof Error ? err.message : "No se pudo exportar los datos del huésped.");
    } finally {
      setExportando(null);
    }
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo={ficha?.huesped.nombreCompleto ?? "Huésped"} atras={{ etiqueta: "Huéspedes", to: `/hoteles/${orgSlug}/huespedes` }} />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!ficha && !error && <EstadoCargando etiqueta="Cargando ficha…" />}

      {ficha && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Seccion titulo="Perfil">
            <p className="text-sm text-foreground">{ficha.huesped.email ?? "Sin correo"}</p>
            <p className="text-sm text-foreground">{ficha.huesped.telefono ?? "Sin teléfono"}</p>
            {ficha.huesped.telefono && (
              <Link to={`/hoteles/${orgSlug}/conversaciones?huesped=${guestId}`} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 w-fit">
                <MessagesSquare className="size-4" strokeWidth={1.75} />
                Ver conversaciones de WhatsApp
              </Link>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <StatusBadge tone={ficha.identidad === null ? "neutral" : ficha.identidad.registrada ? "success" : "warning"}>
                {ficha.identidad === null ? "Identidad: no disponible aún" : ficha.identidad.registrada ? "Identidad registrada" : "Sin identidad registrada"}
              </StatusBadge>
              {restringido && <StatusBadge tone="danger">ARCO en curso: sin notas nuevas</StatusBadge>}
            </div>
            {puedeExportar && (
              <div className="flex flex-col gap-1.5 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={exportando !== null} onClick={() => void exportar("json")}>
                    <Download className="size-3.5" strokeWidth={1.75} />
                    {exportando === "json" ? "Exportando…" : "Exportar datos (JSON)"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={exportando !== null} onClick={() => void exportar("csv")}>
                    <Download className="size-3.5" strokeWidth={1.75} />
                    {exportando === "csv" ? "Exportando…" : "Exportar datos (CSV)"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Incluye perfil, estancias, notas, consentimientos, contactos y conversaciones. El documento de identidad nunca se exporta. Cada exportación queda en la bitácora de privacidad.</p>
                {errorExport && (
                  <p role="alert" className="text-sm text-destructive">
                    {errorExport}
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {ficha.resumen.estancias} estancia(s) · {ficha.resumen.noches} noche(s)
              {ficha.resumen.ultimaEstancia ? ` · última: ${formatFechaSolo(ficha.resumen.ultimaEstancia)}` : ""}
              {ficha.resumen.proximaLlegada ? ` · próxima llegada: ${formatFechaSolo(ficha.resumen.proximaLlegada)}` : ""}
            </p>
          </Seccion>

          <Seccion titulo="Notas y preferencias">
            {!ficha.notas.disponible && <p className="text-sm text-muted-foreground">Las notas y preferencias aún no están activas en esta base de datos.</p>}
            {ficha.notas.disponible && ficha.notas.items.length === 0 && <p className="text-sm text-muted-foreground">Sin notas ni preferencias.</p>}
            {ficha.notas.items.map((n) => (
              <div key={n.id} className="flex items-start justify-between gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm text-foreground whitespace-pre-line">{n.texto}</p>
                  <p className="text-xs text-muted-foreground">
                    {NOTA_TIPO_LABELS[n.tipo]} · {formatFechaSolo(n.creadaEn.slice(0, 10))}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void archivar(n.id)} aria-label="Archivar nota">
                  <Archive className="size-3.5" strokeWidth={1.75} />
                </Button>
              </div>
            ))}
            {ficha.notas.disponible && !restringido && (
              <form onSubmit={(e) => void guardarNota(e)} className="flex flex-col gap-2 pt-1">
                <FormField label="Tipo">
                  <NativeSelect size="sm" value={tipo} onChange={(e) => setTipo(e.target.value as NotaTipo)}>
                    <option value="nota">Nota</option>
                    <option value="preferencia">Preferencia</option>
                  </NativeSelect>
                </FormField>
                <FormField label="Texto de la nota">
                  <Textarea value={texto} maxLength={NOTA_MAX_LENGTH} rows={3} onChange={(e) => setTexto(e.target.value)} placeholder="Prefiere piso alto, almohada extra…" />
                </FormField>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {texto.length}/{NOTA_MAX_LENGTH} · sin números de tarjeta ni de documento
                  </span>
                  <Button type="submit" size="sm" loading={busy} disabled={busy || texto.trim() === ""}>
                    Guardar
                  </Button>
                </div>
              </form>
            )}
            {errorNota && (
              <p role="alert" className="text-sm text-destructive">
                {errorNota}
              </p>
            )}
          </Seccion>

          <Seccion titulo="Historial de estancias">
            {ficha.estancias.length === 0 && <p className="text-sm text-muted-foreground">Sin estancias registradas.</p>}
            {ficha.estancias.map((s) => (
              <div key={s.reservaId} className="flex items-start justify-between gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {formatFechaSolo(s.entrada)} → {formatFechaSolo(s.salida)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.tipoHabitacion ?? "Sin tipo"}
                    {s.habitacion ? ` · Habitación ${s.habitacion}` : ""} · ${formatMoney(s.montoNetoCentavos / 100)} neto
                  </p>
                </div>
                <StatusBadge tone={s.estado === "cancelada" || s.estado === "no_show" ? "danger" : s.estado === "confirmada" ? "warning" : "info"}>{ESTADO_ESTANCIA[s.estado] ?? s.estado}</StatusBadge>
              </div>
            ))}
          </Seccion>

          <div className="flex flex-col gap-3">
            <Seccion titulo="Solicitudes de contacto">
              {ficha.contactos.length === 0 && <p className="text-sm text-muted-foreground">Sin solicitudes de contacto por voz o WhatsApp.</p>}
              {ficha.contactos.map((c) => (
                <div key={c.id} className="border-b border-border pb-2 last:border-b-0 last:pb-0">
                  <p className="text-sm text-foreground">{c.motivo}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.canal === "voz" ? "Voz" : "WhatsApp"} · {formatFechaSolo(c.creadoEn.slice(0, 10))}
                  </p>
                  {c.mensaje && <p className="text-xs text-muted-foreground whitespace-pre-line">{c.mensaje}</p>}
                </div>
              ))}
            </Seccion>

            <Seccion titulo="Consentimientos de privacidad">
              {ficha.consentimientos === null && <p className="text-sm text-muted-foreground">Los consentimientos aún no están activos en esta base de datos.</p>}
              {ficha.consentimientos?.length === 0 && <p className="text-sm text-muted-foreground">Sin consentimientos registrados.</p>}
              {ficha.consentimientos?.map((k) => (
                <div key={k.id} className="flex items-start justify-between gap-2">
                  <p className="text-sm text-foreground">
                    Aviso {k.aviso} · {formatFechaSolo(k.fecha.slice(0, 10))}
                    <span className="block text-xs text-muted-foreground">
                      {k.finalidadesOpcionales.length > 0 ? `Finalidades opcionales: ${k.finalidadesOpcionales.join(", ")}` : "Solo finalidades obligatorias"}
                    </span>
                  </p>
                  <StatusBadge tone={k.revocado ? "danger" : "success"}>{k.revocado ? "Revocado" : "Vigente"}</StatusBadge>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Las solicitudes ARCO y el acceso al documento se gestionan en{" "}
                <Link className="underline underline-offset-4" to={`/hoteles/${orgSlug}/identidad`}>
                  Identidad
                </Link>
                .
              </p>
            </Seccion>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
