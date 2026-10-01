// Identidad — bóveda de identidad cifrada, registro migratorio y purga con doble control
// (H-01, P0). Consume apps/api/src/routes/verticals/hoteles/identidad.ts. Mismo shell y
// mismos componentes de @atiende/ui que el resto del panel de hoteles (Fraude/Catálogo).
//
// Reglas de la pantalla (el servidor es la barrera real, esto solo ordena la UX):
//   - La lista muestra metadatos (tipo, ****últimos4, nacionalidad, retención); el documento
//     completo solo aparece tras "Revelar" (motivo obligatorio, queda en la bitácora) y se
//     descarta con "Ocultar" o al cambiar de pestaña/hotel (vive solo en estado local).
//   - Purga con doble control: quien solicita no puede aprobar su propia solicitud.
//   - Base sin migrar / sin llave: estado honesto "no disponible aún", nunca una pantalla rota.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Fingerprint } from "lucide-react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@atiende/ui";
import {
  ADMIN_ROLES,
  DOCUMENT_TYPE_LABELS,
  IMAGEN_RETENCION_DIAS_DEFECTO,
  IMAGEN_RETENCION_DIAS_MAX,
  IMAGEN_RETENCION_DIAS_MIN,
  MIGRATORIO_ESTADO_LABELS,
  PURGA_ESTADO_LABELS,
  REVEAL_ROLES,
  captureIdentidad,
  createMigratorio,
  decidePurga,
  fetchIdentidades,
  fetchMigratorios,
  fetchPurgas,
  planRetencionImagen,
  reportMigratorio,
  requestPurga,
  revealIdentidad,
  verifyIdentidad,
} from "../lib/identidad-client.ts";
import type { DocumentoRevelado, DocumentType, IdentidadList, IdentidadSummary, MigratorioSummary, PurgaSummary } from "../lib/identidad-client.ts";
import { fetchReservations, searchGuests } from "../lib/reservas-client.ts";
import type { GuestOption, ReservationSummary } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type Tab = "boveda" | "purgas" | "migratorio";

const SELECT_CLASS = "block w-full rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] text-foreground";

function NoDisponible({ mensaje }: { mensaje: string }) {
  return <EstadoVacio mensaje={mensaje} />;
}

export function IdentidadPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const canReveal = REVEAL_ROLES.has(role);
  const isAdmin = ADMIN_ROLES.has(role);
  const [tab, setTab] = useState<Tab>("boveda");

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Fingerprint className="w-5 h-5 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-xl font-display font-semibold text-foreground">Identidad y registro migratorio</h1>
      </header>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="boveda">Bóveda</TabsTrigger>
          {isAdmin && <TabsTrigger value="purgas">Purgas</TabsTrigger>}
          <TabsTrigger value="migratorio">Registro migratorio</TabsTrigger>
        </TabsList>
        <TabsContent value="boveda" className="mt-4">
          <BovedaTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} canReveal={canReveal} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="purgas" className="mt-4">
            <PurgasTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
          </TabsContent>
        )}
        <TabsContent value="migratorio" className="mt-4">
          <MigratorioTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface TabProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// Bóveda
// ---------------------------------------------------------------------------
function BovedaTab({ apiBaseUrl, token, propertyId, canReveal, isAdmin }: TabProps & { canReveal: boolean; isAdmin: boolean }) {
  const [list, setList] = useState<IdentidadList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ readonly id: string; readonly doc: DocumentoRevelado } | null>(null);

  async function load() {
    setError(null);
    try {
      setList(await fetchIdentidades(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar la bóveda de identidad."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleReveal(item: IdentidadSummary) {
    const motivo = window.prompt("Motivo para ver el documento completo (queda en la bitácora, mínimo 10 caracteres):");
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      setRevealed({ id: item.id, doc: await revealIdentidad(fetch, apiBaseUrl, token, propertyId, item.id, motivo) });
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo revelar el documento."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerify(item: IdentidadSummary) {
    setBusyId(item.id);
    try {
      await verifyIdentidad(fetch, apiBaseUrl, token, propertyId, item.id);
      toast.success("Identidad verificada.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo verificar la identidad."));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurgeRequest(item: IdentidadSummary) {
    const motivo = window.prompt("Motivo de la solicitud de purga (mínimo 10 caracteres). Otra persona con rol owner/gm deberá aprobarla:");
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await requestPurga(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      toast.success("Solicitud de purga creada; falta la aprobación de otra persona.");
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo solicitar la purga."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!list && !error && <EstadoCargando etiqueta="Cargando identidades…" />}
      {list && !list.disponible && <NoDisponible mensaje="La bóveda de identidad aún no está disponible en esta base (migración pendiente de aplicar)." />}
      {list && list.disponible && !list.llaveConfigurada && (
        <EstadoError titulo="Falta la llave de cifrado" mensaje="No se pueden capturar ni revelar documentos hasta configurar HOTELES_IDENTITY_KEY en la API. Nada se guarda sin cifrar." />
      )}
      {list && list.disponible && list.llaveConfigurada && <CaptureForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onCaptured={() => void load()} />}

      {list && list.disponible && list.items.length === 0 && <EstadoVacio mensaje="Todavía no hay identidades capturadas en este hotel." />}
      <div className="flex flex-col gap-3">
        {list?.items.map((it) => (
          <Card key={it.id}>
            <CardContent className="p-4 flex flex-col gap-2">
              <div className="flex justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-medium text-foreground">
                    {DOCUMENT_TYPE_LABELS[it.tipoDocumento]} {it.ultimos4 ? `****${it.ultimos4}` : ""} {it.nacionalidad ? `· ${it.nacionalidad}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Huésped: {it.huespedId} · Retención hasta {it.retencionHasta} · {it.verificadaEn ? "Verificada" : "Sin verificar"}
                  </p>
                </div>
                <Badge variant={it.estado === "activo" ? "default" : "secondary"} className="self-start">
                  {it.estado === "activo" ? "Activa" : "Purgada"}
                </Badge>
              </div>
              {revealed?.id === it.id && (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm flex flex-col gap-1" data-testid="documento-revelado">
                  <p>
                    <span className="text-muted-foreground">Nombre:</span> {revealed.doc.nombreCompleto}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Documento:</span> {revealed.doc.numeroDocumento}
                  </p>
                  {revealed.doc.fechaNacimiento && (
                    <p>
                      <span className="text-muted-foreground">Nacimiento:</span> {revealed.doc.fechaNacimiento}
                    </p>
                  )}
                  {revealed.doc.vigenciaHasta && (
                    <p>
                      <span className="text-muted-foreground">Vigencia:</span> {revealed.doc.vigenciaHasta}
                    </p>
                  )}
                  {revealed.doc.mrz && <pre className="text-[11px] whitespace-pre-wrap">{revealed.doc.mrz}</pre>}
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(null)}>
                      Ocultar
                    </Button>
                  </div>
                </div>
              )}
              {it.estado === "activo" && (
                <div className="flex gap-2 flex-wrap mt-1">
                  {canReveal && (
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleReveal(it)} disabled={busyId === it.id}>
                      Revelar
                    </Button>
                  )}
                  {canReveal && !it.verificadaEn && (
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleVerify(it)} disabled={busyId === it.id}>
                      Marcar verificada
                    </Button>
                  )}
                  {isAdmin && (
                    <Button type="button" size="sm" variant="destructive" onClick={() => void handlePurgeRequest(it)} disabled={busyId === it.id}>
                      Solicitar purga
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CaptureForm({ apiBaseUrl, token, propertyId, onCaptured }: TabProps & { onCaptured: () => void }) {
  const [guests, setGuests] = useState<readonly GuestOption[] | null>(null);
  const [reservations, setReservations] = useState<readonly ReservationSummary[]>([]);
  const [guestId, setGuestId] = useState("");
  const [reservationId, setReservationId] = useState("");
  const [documentType, setDocumentType] = useState<DocumentType>("ine");
  const [nationality, setNationality] = useState("MEX");
  const [fullName, setFullName] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [g, r] = await Promise.all([searchGuests(fetch, apiBaseUrl, token, propertyId), fetchReservations(fetch, apiBaseUrl, token, propertyId)]);
        if (!cancelado) {
          setGuests(g);
          setReservations(r);
        }
      } catch (err) {
        if (!cancelado) setError(errorMessage(err, "No se pudieron cargar huéspedes y reservas."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const guestReservations = useMemo(() => reservations.filter((r) => r.guestId === guestId), [reservations, guestId]);
  const checkOutDate = guestReservations.find((r) => r.id === reservationId)?.checkOutDate ?? null;
  const plan = planRetencionImagen(retentionDays, checkOutDate);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!plan.valido) {
      setError(plan.mensaje);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await captureIdentidad(fetch, apiBaseUrl, token, propertyId, {
        guestId,
        reservationId: reservationId || undefined,
        documentType,
        nationality: nationality || undefined,
        fullName,
        documentNumber,
        birthDate: birthDate || undefined,
        retentionDays: retentionDays.trim() === "" ? undefined : Number(retentionDays),
      });
      toast.success("Identidad capturada y cifrada.");
      setFullName("");
      setDocumentNumber("");
      setBirthDate("");
      onCaptured();
    } catch (err) {
      setError(errorMessage(err, "No se pudo capturar la identidad."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-3 sm:grid-cols-2" aria-label="Capturar identidad">
          <div>
            <Label htmlFor="ident-huesped">Huésped</Label>
            <select id="ident-huesped" className={SELECT_CLASS} value={guestId} onChange={(e) => { setGuestId(e.target.value); setReservationId(""); }} required>
              <option value="">{guests ? "Selecciona un huésped…" : "Cargando…"}</option>
              {guests?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nombreCompleto}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ident-reserva">Reserva (opcional)</Label>
            <select id="ident-reserva" className={SELECT_CLASS} value={reservationId} onChange={(e) => setReservationId(e.target.value)} disabled={!guestId}>
              <option value="">Sin reserva</option>
              {guestReservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.checkInDate} → {r.checkOutDate}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ident-tipo">Tipo de documento</Label>
            <select id="ident-tipo" className={SELECT_CLASS} value={documentType} onChange={(e) => setDocumentType(e.target.value as DocumentType)}>
              {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ident-nacionalidad">Nacionalidad (ISO-3, ej. MEX)</Label>
            <Input id="ident-nacionalidad" value={nationality} maxLength={3} onChange={(e) => setNationality(e.target.value.toUpperCase())} />
          </div>
          <div>
            <Label htmlFor="ident-nombre">Nombre completo</Label>
            <Input id="ident-nombre" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="ident-numero">Número de documento</Label>
            <Input id="ident-numero" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} required autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="ident-nacimiento">Fecha de nacimiento</Label>
            <Input id="ident-nacimiento" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ident-retencion">Días de conservación tras el check-out (opcional)</Label>
            <Input
              id="ident-retencion"
              type="number"
              inputMode="numeric"
              min={IMAGEN_RETENCION_DIAS_MIN}
              max={IMAGEN_RETENCION_DIAS_MAX}
              step={1}
              placeholder={String(IMAGEN_RETENCION_DIAS_DEFECTO)}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" role="note" aria-label="Plazo de conservación y aviso de privacidad">
            <p className="font-medium text-foreground" data-testid="plazo-retencion">
              {plan.valido
                ? plan.hasta
                  ? `El documento cifrado se conservará ${plan.dias} día(s) después del check-out y se purgará después del ${plan.hasta}.`
                  : `Sin reserva ligada: el documento cifrado se conservará ${plan.dias} día(s) contados desde hoy y se purgará después.`
                : plan.mensaje}
            </p>
            <p className="mt-1">
              El registro de huéspedes sin imagen (nacionalidad, fechas de llegada y salida) se conserva por separado, 365 días por defecto, y no se purga junto con el documento.
            </p>
            <p className="mt-1">
              Antes de capturar, el huésped debe haber recibido el aviso de privacidad y su consentimiento debe quedar registrado. Esta pantalla aún no lo registra: el consentimiento formal está pendiente (H-02). Estos plazos son una decisión de producto, no una asesoría legal: confírmalos con tu abogado.
            </p>
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={saving || !guestId || !plan.valido}>
              {saving ? "Cifrando…" : "Capturar identidad"}
            </Button>
          </div>
          {error && (
            <div className="sm:col-span-2">
              <EstadoError titulo="No se pudo capturar" mensaje={error} />
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Purgas (doble control)
// ---------------------------------------------------------------------------
function PurgasTab({ apiBaseUrl, token, propertyId }: TabProps) {
  const [data, setData] = useState<{ readonly disponible: boolean; readonly items: readonly PurgaSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setData(await fetchPurgas(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar las solicitudes de purga."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleDecide(p: PurgaSummary, aprobar: boolean) {
    const nota = window.prompt(aprobar ? "Nota de aprobación (opcional). La purga es irreversible:" : "Motivo del rechazo (opcional):");
    if (nota === null) return;
    setBusyId(p.id);
    try {
      const r = await decidePurga(fetch, apiBaseUrl, token, propertyId, p.id, aprobar, nota || undefined);
      toast.success(r === "ejecutada" ? "Purga ejecutada." : "Solicitud rechazada.");
      await load();
    } catch (err) {
      // Doble control: si quien decide es quien solicitó, el servidor responde 403 con el motivo.
      toast.error(errorMessage(err, "No se pudo resolver la solicitud."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">Doble control: quien solicita una purga no puede aprobarla; debe decidirla otra persona con rol owner/gm. La purga borra el documento cifrado y es irreversible.</p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando solicitudes…" />}
      {data && !data.disponible && <NoDisponible mensaje="Las solicitudes de purga aún no están disponibles en esta base (migración pendiente de aplicar)." />}
      {data && data.disponible && data.items.length === 0 && <EstadoVacio mensaje="No hay solicitudes de purga." />}
      {data?.items.map((p) => (
        <Card key={p.id}>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium text-foreground">Identidad {p.identidadId}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.motivo}</p>
              </div>
              <Badge variant={p.estado === "pendiente" ? "default" : "secondary"} className="self-start">
                {PURGA_ESTADO_LABELS[p.estado]}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">Solicitada por {p.solicitadaPor} · {p.creadaEn}</p>
            {p.notaDecision && <p className="text-xs text-muted-foreground">Nota: {p.notaDecision}</p>}
            {p.estado === "pendiente" && (
              <div className="flex gap-2 mt-1">
                <Button type="button" size="sm" variant="destructive" onClick={() => void handleDecide(p, true)} disabled={busyId === p.id}>
                  Aprobar purga
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void handleDecide(p, false)} disabled={busyId === p.id}>
                  Rechazar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registro migratorio
// ---------------------------------------------------------------------------
function MigratorioTab({ apiBaseUrl, token, propertyId }: TabProps) {
  const [data, setData] = useState<{ readonly disponible: boolean; readonly items: readonly MigratorioSummary[] } | null>(null);
  const [candidates, setCandidates] = useState<readonly IdentidadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [m, ids] = await Promise.all([fetchMigratorios(fetch, apiBaseUrl, token, propertyId), fetchIdentidades(fetch, apiBaseUrl, token, propertyId, "activo")]);
      setData(m);
      setCandidates(ids.items);
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar el registro migratorio."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  // Identidades de extranjeros ligadas a una reserva que aún no tienen registro.
  const registrables = useMemo(() => {
    const registered = new Set((data?.items ?? []).map((r) => `${r.reservaId}|${r.huespedId}`));
    return candidates.filter((c) => c.reservaId && c.nacionalidad && c.nacionalidad !== "MEX" && !registered.has(`${c.reservaId}|${c.huespedId}`));
  }, [candidates, data]);

  async function handleCreate(c: IdentidadSummary) {
    setBusyId(c.id);
    try {
      await createMigratorio(fetch, apiBaseUrl, token, propertyId, { reservaId: c.reservaId!, huespedId: c.huespedId, identidadId: c.id });
      toast.success("Registro migratorio creado.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo crear el registro migratorio."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReport(r: MigratorioSummary) {
    const constancia = window.prompt("Folio o referencia de la constancia obtenida al reportar (este sistema no envía nada al INM):");
    if (constancia === null || constancia.trim() === "") return;
    setBusyId(r.id);
    try {
      await reportMigratorio(fetch, apiBaseUrl, token, propertyId, r.id, constancia.trim());
      toast.success("Registro marcado como reportado.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo marcar como reportado."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">Este registro lleva el estado y la constancia de cada huésped extranjero. No envía información al INM: el reporte se hace por el canal oficial y aquí se captura su folio.</p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando registro migratorio…" />}
      {data && !data.disponible && <NoDisponible mensaje="El registro migratorio aún no está disponible en esta base (migración pendiente de aplicar)." />}

      {registrables.length > 0 && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Por registrar ({registrables.length})</p>
            {registrables.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 flex-wrap text-sm">
                <span>
                  {DOCUMENT_TYPE_LABELS[c.tipoDocumento]} {c.ultimos4 ? `****${c.ultimos4}` : ""} · {c.nacionalidad} · reserva {c.reservaId}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCreate(c)} disabled={busyId === c.id}>
                  Crear registro
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data && data.disponible && data.items.length === 0 && <EstadoVacio mensaje="No hay registros migratorios." />}
      {data?.items.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium text-foreground">
                  {r.nacionalidad ?? "—"} · {r.llegada} → {r.salida}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Reserva {r.reservaId} · Huésped {r.huespedId}{r.retencionRegistroHasta ? ` · Registro conservado hasta ${r.retencionRegistroHasta}` : ""}</p>
              </div>
              <Badge variant={r.estado === "pendiente" ? "default" : "secondary"} className="self-start">
                {MIGRATORIO_ESTADO_LABELS[r.estado]}
              </Badge>
            </div>
            {r.constancia && <p className="text-xs text-muted-foreground">Constancia: {r.constancia}</p>}
            {r.estado === "pendiente" && (
              <div>
                <Button type="button" size="sm" variant="outline" onClick={() => void handleReport(r)} disabled={busyId === r.id}>
                  Marcar como reportado
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
