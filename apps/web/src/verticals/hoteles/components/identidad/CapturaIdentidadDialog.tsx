// Captura cifrada de una identidad con consentimiento ligado (H-01/H-02). UNI-C gestion: extraida de Identidad.tsx; pasa de
// tarjeta con formulario inline a FormDialog con FormField. Misma logica y mismas llamadas (captureIdentidad, avisos, huespedes).
import { useEffect, useMemo, useState } from "react";
import { Callout, Checkbox, FormDialog, FormField, Input, NativeSelect, notify } from "@atiende/ui";
import { DOCUMENT_TYPE_LABELS, IMAGEN_RETENCION_DIAS_DEFECTO, IMAGEN_RETENCION_DIAS_MAX, IMAGEN_RETENCION_DIAS_MIN, captureIdentidad, planRetencionImagen } from "../../lib/identidad-client.ts";
import type { DocumentType } from "../../lib/identidad-client.ts";
import { CONSENT_CANALES, CONSENT_METODOS_ESCRITOS, CONSENT_METODO_LABELS, fetchAvisos } from "../../lib/privacidad-client.ts";
import type { AvisoSummary } from "../../lib/privacidad-client.ts";
import { fetchReservations, searchGuests } from "../../lib/reservas-client.ts";
import type { GuestOption, ReservationSummary } from "../../lib/reservas-client.ts";
import { errorMessage } from "./comun.ts";
import type { TabProps } from "./comun.ts";

export interface CapturaIdentidadDialogProps extends TabProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCaptured: () => void;
}

function toggle(set: ReadonlySet<string>, value: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

export function CapturaIdentidadDialog({ apiBaseUrl, token, propertyId, open, onClose, onCaptured }: CapturaIdentidadDialogProps) {
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

  async function handleSubmit() {
    if (!plan.valido) {
      setError(plan.mensaje);
      return;
    }
    if (consentIncompleto) {
      setError("El consentimiento exige aceptar todas las finalidades obligatorias del aviso y, con datos sensibles, firma o mecanismo de autenticación.");
      return;
    }
    if (!guestId || !fullName.trim() || !documentNumber.trim()) {
      setError("Selecciona al huésped y captura el nombre y el número de documento.");
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
      notify.success(
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
      onClose();
    } catch (err) {
      setError(errorMessage(err, "No se pudo capturar la identidad."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(abierto) => {
        if (!abierto && !saving) onClose();
      }}
      titulo="Capturar identidad"
      subtitulo="El documento se cifra antes de guardarse; nada se guarda sin cifrar."
      anchoClase="max-w-4xl"
      onGuardar={() => void handleSubmit()}
      guardando={saving}
      guardarDeshabilitado={!guestId || !plan.valido || consentIncompleto}
      textoBotonGuardar="Capturar identidad"
      bloquearCierre={saving}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Huésped" required>
          <NativeSelect
            id="ident-huesped"
            value={guestId}
            onChange={(e) => {
              setGuestId(e.target.value);
              setReservationId("");
            }}
          >
            <option value="">{guests ? "Selecciona un huésped…" : "Cargando…"}</option>
            {guests?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombreCompleto}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Reserva (opcional)">
          <NativeSelect id="ident-reserva" value={reservationId} onChange={(e) => setReservationId(e.target.value)} disabled={!guestId}>
            <option value="">Sin reserva</option>
            {guestReservations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.checkInDate} → {r.checkOutDate}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Tipo de documento">
          <NativeSelect id="ident-tipo" value={documentType} onChange={(e) => setDocumentType(e.target.value as DocumentType)}>
            {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Nacionalidad (ISO-3, ej. MEX)">
          <Input id="ident-nacionalidad" value={nationality} maxLength={3} onChange={(e) => setNationality(e.target.value.toUpperCase())} />
        </FormField>
        <FormField label="Nombre completo" required>
          <Input id="ident-nombre" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" />
        </FormField>
        <FormField label="Número de documento" required>
          <Input id="ident-numero" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} autoComplete="off" />
        </FormField>
        <FormField label="Fecha de nacimiento">
          <Input id="ident-nacimiento" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        </FormField>
        <FormField label="Días de conservación tras el check-out (opcional)">
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
        </FormField>
        <div className="sm:col-span-2 rounded-lg border border-border bg-canvas p-3 text-xs text-muted-foreground" role="note" aria-label="Plazo de conservación y aviso de privacidad">
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
              <Checkbox label={`Registrar el consentimiento del huésped (aviso ${aviso.version})`} checked={registrarConsent} onChange={(e) => setRegistrarConsent(e.target.checked)} />
              {registrarConsent && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2 text-xs text-muted-foreground" data-testid="aviso-simplificado">
                    {aviso.textoSimplificado}
                    {aviso.urlIntegral ? ` Aviso integral: ${aviso.urlIntegral}` : ""}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-foreground">Finalidades obligatorias (todas)</span>
                    {aviso.finalidadesObligatorias.map((f) => (
                      <Checkbox key={f} label={f} checked={aceptadasObl.has(f)} onChange={(e) => setAceptadasObl(toggle(aceptadasObl, f, e.target.checked))} />
                    ))}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-foreground">Finalidades opcionales (casilla distinta, sin marcar)</span>
                    {aviso.finalidadesOpcionales.length === 0 && <span className="text-xs text-muted-foreground">Este aviso no tiene finalidades opcionales.</span>}
                    {aviso.finalidadesOpcionales.map((f) => (
                      <Checkbox key={f} label={f} checked={aceptadasOpc.has(f)} onChange={(e) => setAceptadasOpc(toggle(aceptadasOpc, f, e.target.checked))} />
                    ))}
                  </div>
                  <FormField label="Canal">
                    <NativeSelect id="consent-canal" value={canal} onChange={(e) => setCanal(e.target.value)}>
                      {CONSENT_CANALES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField label="Evidencia del consentimiento">
                    <NativeSelect id="consent-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)}>
                      {Object.keys(CONSENT_METODO_LABELS).map((m) => (
                        <option key={m} value={m}>
                          {CONSENT_METODO_LABELS[m]}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <Checkbox
                    wrapperClassName="sm:col-span-2"
                    label="Incluye datos sensibles (p. ej. biométricos): exige consentimiento expreso y por escrito (firma o mecanismo de autenticación)"
                    checked={sensibles}
                    onChange={(e) => setSensibles(e.target.checked)}
                  />
                  {consentIncompleto && (
                    <p className="sm:col-span-2 text-xs text-destructive" role="alert">
                      Falta aceptar todas las finalidades obligatorias o usar firma/autenticación con datos sensibles.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </fieldset>
        {error && (
          <Callout tone="danger" titulo="No se pudo capturar" className="sm:col-span-2">
            {error}
          </Callout>
        )}
      </div>
    </FormDialog>
  );
}
