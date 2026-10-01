// Identidad — bóveda de identidad cifrada, registro migratorio y purga con doble control
// (H-01, P0) + pestaña "Privacidad" (H-02: aviso, consentimientos, ARCO, bloqueo previo a la
// purga, retención legal e incidentes; ver Privacidad.tsx). Consume apps/api/src/routes/verticals/hoteles/identidad.ts. Mismo shell y
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
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@atiende/ui";
import {
  ADMIN_ROLES,
  DOCUMENT_TYPE_LABELS,
  IMAGEN_RETENCION_DIAS_DEFECTO,
  IMAGEN_RETENCION_DIAS_MAX,
  IMAGEN_RETENCION_DIAS_MIN,
  MIGRATORIO_ESTADO_LABELS,
  MOTIVO_BLOQUEO_LABELS,
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
import { CONSENT_CANALES, CONSENT_METODOS_ESCRITOS, CONSENT_METODO_LABELS, blockIdentidad, fetchAvisos, placeRetencion, requestAccesoExcepcional } from "../lib/privacidad-client.ts";
import type { AvisoSummary } from "../lib/privacidad-client.ts";
import { PrivacidadTab } from "./Privacidad.tsx";
import { fetchReservations, searchGuests } from "../lib/reservas-client.ts";
import type { GuestOption, ReservationSummary } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type Tab = "boveda" | "purgas" | "migratorio" | "privacidad";

function NoDisponible({ mensaje }: { mensaje: string }) {
  return <EstadoVacio mensaje={mensaje} />;
}

export function IdentidadPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const canReveal = REVEAL_ROLES.has(role);
  const isAdmin = ADMIN_ROLES.has(role);
  const [tab, setTab] = useState<Tab>("boveda");

  return (
    <PageContainer padding="none" className="gap-4">
      <header className="flex items-center gap-2">
        <Fingerprint className="w-5 h-5 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-xl font-display font-semibold text-foreground">Identidad y registro migratorio</h1>
      </header>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="boveda">Bóveda</TabsTrigger>
          {isAdmin && <TabsTrigger value="purgas">Purgas</TabsTrigger>}
          <TabsTrigger value="migratorio">Registro migratorio</TabsTrigger>
          <TabsTrigger value="privacidad">Privacidad</TabsTrigger>
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
        <TabsContent value="privacidad" className="mt-4">
          <PrivacidadTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </PageContainer>
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
      toast.success("Solicitud de purga creada; falta la aprobación de otra persona (al aprobarla, la identidad se bloquea antes de purgarse).");
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo solicitar la purga."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleBlock(item: IdentidadSummary) {
    const motivo = window.prompt("Motivo del bloqueo (mínimo 10 caracteres). La identidad pierde el acceso operativo y se purgará al vencer la ventana, salvo retención legal:");
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await blockIdentidad(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      toast.success("Identidad bloqueada.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo bloquear la identidad."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleHold(item: IdentidadSummary) {
    const folio = window.prompt("Folio del caso (carpeta de investigación, expediente o folio de incidente):");
    if (folio === null) return;
    const motivo = window.prompt("Motivo de la retención legal (10 a 300 caracteres). Impide la purga mientras dure el caso:");
    if (motivo === null) return;
    const autorizacion = window.prompt("Quién autoriza la retención (oficio, área jurídica o dirección):");
    if (autorizacion === null) return;
    setBusyId(item.id);
    try {
      await placeRetencion(fetch, apiBaseUrl, token, propertyId, item.id, { folio, motivo, autorizacion });
      toast.success("Retención legal aplicada: la identidad no se purgará mientras dure el caso.");
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo aplicar la retención legal."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleExceptionalAccess(item: IdentidadSummary) {
    const motivo = window.prompt("Motivo del acceso excepcional (10 a 300 caracteres). Otra persona con rol owner/gm deberá aprobarlo:");
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await requestAccesoExcepcional(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      toast.success("Acceso excepcional solicitado; falta la aprobación de otra persona (pestaña Privacidad > Retención y bloqueo).");
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo solicitar el acceso excepcional."));
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
                <StatusBadge tone={it.estado === "activo" ? "success" : "neutral"} className="self-start">
                  {it.estado === "activo" ? "Activa" : it.estado === "bloqueada" ? "Bloqueada" : "Purgada"}
                </StatusBadge>
              </div>
              {it.estado === "bloqueada" && (
                <p className="text-xs text-muted-foreground" data-testid="identidad-bloqueada">
                  Bloqueada{it.motivoBloqueo ? ` (${MOTIVO_BLOQUEO_LABELS[it.motivoBloqueo]})` : ""}: sin acceso operativo; se purgará después del {it.bloqueadaHasta ?? "fin de la ventana"}, salvo retención legal. Solo hay acceso excepcional con doble control.
                </p>
              )}
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
                  {revealed.doc.mrz && <pre className="text-xs whitespace-pre-wrap">{revealed.doc.mrz}</pre>}
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(null)}>
                      Ocultar
                    </Button>
                  </div>
                </div>
              )}
              {it.estado === "bloqueada" && isAdmin && (
                <div className="flex gap-2 flex-wrap mt-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleExceptionalAccess(it)} disabled={busyId === it.id}>
                    Acceso excepcional
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleHold(it)} disabled={busyId === it.id}>
                    Retención legal
                  </Button>
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
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleHold(it)} disabled={busyId === it.id}>
                      Retención legal
                    </Button>
                  )}
                  {isAdmin && (
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleBlock(it)} disabled={busyId === it.id}>
                      Bloquear
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
  // Consentimiento ligado a la captura (H-02): aviso vigente + finalidades + canal + evidencia.
  const [aviso, setAviso] = useState<AvisoSummary | null>(null);
  const [registrarConsent, setRegistrarConsent] = useState(false);
  const [aceptadasObl, setAceptadasObl] = useState<ReadonlySet<string>>(new Set());
  const [aceptadasOpc, setAceptadasOpc] = useState<ReadonlySet<string>>(new Set());
  const [canal, setCanal] = useState("mostrador");
  const [metodo, setMetodo] = useState("casilla_electronica");
  const [sensibles, setSensibles] = useState(false);

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

  useEffect(() => {
    let cancelado = false;
    fetchAvisos(fetch, apiBaseUrl, token, propertyId)
      .then((r) => {
        if (cancelado) return;
        const vigente = r.disponible ? (r.items.find((a) => a.vigente) ?? null) : null;
        setAviso(vigente);
        setRegistrarConsent(vigente !== null);
      })
      .catch(() => undefined); // sin aviso/ledger la captura sigue como antes (el consentimiento es opcional)
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const guestReservations = useMemo(() => reservations.filter((r) => r.guestId === guestId), [reservations, guestId]);
  const checkOutDate = guestReservations.find((r) => r.id === reservationId)?.checkOutDate ?? null;
  const plan = planRetencionImagen(retentionDays, checkOutDate);
  const faltanObligatorias = aviso !== null && aviso.finalidadesObligatorias.some((f) => !aceptadasObl.has(f));
  const consentIncompleto = registrarConsent && aviso !== null && (faltanObligatorias || (sensibles && !CONSENT_METODOS_ESCRITOS.has(metodo)));

  function toggle(set: ReadonlySet<string>, value: string, on: boolean): ReadonlySet<string> {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!plan.valido) {
      setError(plan.mensaje);
      return;
    }
    if (consentIncompleto) {
      setError("El consentimiento exige aceptar todas las finalidades obligatorias del aviso y, con datos sensibles, firma o mecanismo de autenticación.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resultado = await captureIdentidad(fetch, apiBaseUrl, token, propertyId, {
        guestId,
        reservationId: reservationId || undefined,
        documentType,
        nationality: nationality || undefined,
        fullName,
        documentNumber,
        birthDate: birthDate || undefined,
        retentionDays: retentionDays.trim() === "" ? undefined : Number(retentionDays),
        consentimiento:
          registrarConsent && aviso
            ? { avisoId: aviso.id, finalidadesObligatorias: [...aceptadasObl], finalidadesOpcionales: [...aceptadasOpc], canal, metodo, datosSensibles: sensibles || undefined }
            : undefined,
      });
      toast.success(
        resultado.consentimiento?.estado === "registrado"
          ? `Identidad capturada y cifrada; consentimiento registrado (aviso ${resultado.consentimiento.versionAviso ?? aviso?.version}).`
          : resultado.consentimiento?.estado === "no_disponible"
            ? "Identidad capturada y cifrada; el ledger de consentimientos aún no está disponible en esta base."
            : "Identidad capturada y cifrada.",
      );
      setAceptadasObl(new Set());
      setAceptadasOpc(new Set());
      setSensibles(false);
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
            <NativeSelect id="ident-huesped" value={guestId} onChange={(e) => { setGuestId(e.target.value); setReservationId(""); }} required>
              <option value="">{guests ? "Selecciona un huésped…" : "Cargando…"}</option>
              {guests?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nombreCompleto}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="ident-reserva">Reserva (opcional)</Label>
            <NativeSelect id="ident-reserva" value={reservationId} onChange={(e) => setReservationId(e.target.value)} disabled={!guestId}>
              <option value="">Sin reserva</option>
              {guestReservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.checkInDate} → {r.checkOutDate}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="ident-tipo">Tipo de documento</Label>
            <NativeSelect id="ident-tipo" value={documentType} onChange={(e) => setDocumentType(e.target.value as DocumentType)}>
              {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
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
              Antes de capturar, el huésped debe haber recibido el aviso de privacidad; registra su consentimiento aquí abajo (queda ligado a esta captura, con la versión del aviso, finalidades, canal y quién lo capturó). Estos plazos son una decisión de producto, no una asesoría legal: confírmalos con tu abogado.
            </p>
          </div>
          <fieldset className="sm:col-span-2 rounded-lg border border-border p-3 flex flex-col gap-2" aria-label="Consentimiento y aviso de privacidad">
            <legend className="px-1 text-xs font-medium text-foreground">Consentimiento y aviso de privacidad</legend>
            {!aviso && <p className="text-xs text-muted-foreground">No hay un aviso de privacidad vigente (o el ledger aún no está disponible): publícalo en Privacidad &gt; Aviso y consentimientos para registrar el consentimiento junto con la captura.</p>}
            {aviso && (
              <>
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <Checkbox checked={registrarConsent} onChange={(e) => setRegistrarConsent(e.target.checked)} />
                  Registrar el consentimiento del huésped (aviso {aviso.version})
                </label>
                {registrarConsent && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="sm:col-span-2 text-xs text-muted-foreground" data-testid="aviso-simplificado">
                      {aviso.textoSimplificado}
                      {aviso.urlIntegral ? ` Aviso integral: ${aviso.urlIntegral}` : ""}
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-foreground">Finalidades obligatorias (todas)</span>
                      {aviso.finalidadesObligatorias.map((f) => (
                        <label key={f} className="flex items-center gap-2 text-xs text-foreground">
                          <Checkbox checked={aceptadasObl.has(f)} onChange={(e) => setAceptadasObl(toggle(aceptadasObl, f, e.target.checked))} />
                          {f}
                        </label>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-foreground">Finalidades opcionales (casilla distinta, sin marcar)</span>
                      {aviso.finalidadesOpcionales.length === 0 && <span className="text-xs text-muted-foreground">Este aviso no tiene finalidades opcionales.</span>}
                      {aviso.finalidadesOpcionales.map((f) => (
                        <label key={f} className="flex items-center gap-2 text-xs text-foreground">
                          <Checkbox checked={aceptadasOpc.has(f)} onChange={(e) => setAceptadasOpc(toggle(aceptadasOpc, f, e.target.checked))} />
                          {f}
                        </label>
                      ))}
                    </div>
                    <div>
                      <Label htmlFor="consent-canal">Canal</Label>
                      <NativeSelect id="consent-canal" value={canal} onChange={(e) => setCanal(e.target.value)}>
                        {CONSENT_CANALES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div>
                      <Label htmlFor="consent-metodo">Evidencia del consentimiento</Label>
                      <NativeSelect id="consent-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)}>
                        {Object.keys(CONSENT_METODO_LABELS).map((m) => (
                          <option key={m} value={m}>
                            {CONSENT_METODO_LABELS[m]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <label className="sm:col-span-2 flex items-center gap-2 text-xs text-foreground">
                      <Checkbox checked={sensibles} onChange={(e) => setSensibles(e.target.checked)} />
                      Incluye datos sensibles (p. ej. biométricos): exige consentimiento expreso y por escrito (firma o mecanismo de autenticación)
                    </label>
                    {consentIncompleto && <p className="sm:col-span-2 text-xs text-destructive" role="alert">Falta aceptar todas las finalidades obligatorias o usar firma/autenticación con datos sensibles.</p>}
                  </div>
                )}
              </>
            )}
          </fieldset>
          <div className="flex items-end">
            <Button type="submit" disabled={saving || !guestId || !plan.valido || consentIncompleto}>
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
    const nota = window.prompt(aprobar ? "Nota de aprobación (opcional). La identidad quedará bloqueada y se purgará (irreversible) al vencer la ventana:" : "Motivo del rechazo (opcional):");
    if (nota === null) return;
    setBusyId(p.id);
    try {
      const r = await decidePurga(fetch, apiBaseUrl, token, propertyId, p.id, aprobar, nota || undefined);
      toast.success(r === "ejecutada" ? "Purga ejecutada." : r === "en_bloqueo" ? "Purga aprobada: la identidad quedó bloqueada y se purgará al vencer la ventana." : "Solicitud rechazada.");
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
      <p className="text-xs text-muted-foreground">Doble control: quien solicita una purga no puede aprobarla; debe decidirla otra persona con rol owner/gm. Aprobarla bloquea la identidad (sin acceso operativo, con la ventana configurada); la purga borra el documento cifrado, es irreversible y ocurre solo al vencer la ventana y si no hay retención legal.</p>
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
              <StatusBadge tone={p.estado === "pendiente" || p.estado === "en_bloqueo" ? "warning" : "neutral"} className="self-start">
                {PURGA_ESTADO_LABELS[p.estado]}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">Solicitada por {p.solicitadaPor} · {p.creadaEn}</p>
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
              <StatusBadge tone={r.estado === "pendiente" ? "warning" : "neutral"} className="self-start">
                {MIGRATORIO_ESTADO_LABELS[r.estado]}
              </StatusBadge>
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
