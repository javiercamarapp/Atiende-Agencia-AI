// Rn-P3-08 -- Pre-check-in PUBLICO del huesped (sin login ni shell de panel). El huesped de una OTA (Airbnb, Booking, Vrbo) escribe su codigo de
// confirmacion y los ultimos 4 digitos de su telefono; si coinciden con una reserva confirmada y proxima de esta propiedad, deja su correo (y WhatsApp
// opcional) y acepta el aviso de privacidad y el reglamento de la casa. Con el correo, la siguiente corrida de liberacion le envia el acceso.
// Los errores no revelan si la reserva existe; contra una base sin la migracion 036 dice "aun no disponible" en lugar de romperse.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, ClipboardCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, Label } from "@atiende/ui";
import { PrecheckinError, capturarPrecheckin, fetchInfoPrecheckin, verificarReserva } from "../lib/precheckin-client.ts";
import type { InfoPrecheckin } from "../lib/precheckin-client.ts";

type Paso =
  | { readonly tipo: "verificar" }
  | { readonly tipo: "capturar"; readonly token: string; readonly unidad: string; readonly checkIn: string; readonly checkOut: string }
  | { readonly tipo: "listo"; readonly mensaje: string };

function fechaLarga(fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${fecha}T00:00:00Z`));
}

export function PreCheckinPage({ apiBaseUrl, propertyId }: { apiBaseUrl: string; propertyId: string }) {
  const [info, setInfo] = useState<InfoPrecheckin | "cargando" | "no_encontrado" | { error: string; sinMigrar: boolean }>("cargando");
  const [paso, setPaso] = useState<Paso>({ tipo: "verificar" });
  const [codigo, setCodigo] = useState("");
  const [ultimos4, setUltimos4] = useState("");
  const [correo, setCorreo] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [aceptaPrivacidad, setAceptaPrivacidad] = useState(false);
  const [aceptaReglamento, setAceptaReglamento] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setInfo("cargando");
    fetchInfoPrecheckin(fetch, apiBaseUrl, propertyId)
      .then((r) => !cancelado && setInfo(r))
      .catch((e: unknown) => {
        if (cancelado) return;
        if (e instanceof PrecheckinError && e.status === 404) setInfo("no_encontrado");
        else setInfo({ error: e instanceof Error ? e.message : "No pudimos cargar el pre-check-in.", sinMigrar: e instanceof PrecheckinError && e.status === 503 });
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, propertyId, recarga]);

  const reglamento = useMemo(() => (typeof info === "object" && "reglamento" in info ? info.reglamento : null), [info]);

  async function verificar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const r = await verificarReserva(fetch, apiBaseUrl, propertyId, codigo, ultimos4);
      if (r.estado === "invalido") {
        setError(r.mensaje);
      } else if (r.yaCapturado) {
        setPaso({ tipo: "listo", mensaje: "Ya recibimos tus datos para esta reserva. Si necesitas cambiarlos, escribe a tu anfitrión." });
      } else {
        setPaso({ tipo: "capturar", token: r.token, unidad: r.unidad, checkIn: r.checkIn, checkOut: r.checkOut });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos validar tus datos.");
    } finally {
      setEnviando(false);
    }
  }

  async function capturar(e: FormEvent) {
    e.preventDefault();
    if (paso.tipo !== "capturar") return;
    setEnviando(true);
    setError(null);
    try {
      const r = await capturarPrecheckin(fetch, apiBaseUrl, propertyId, { token: paso.token, correo, whatsapp, aceptaPrivacidad, aceptaReglamento });
      setPaso({ tipo: "listo", mensaje: r.mensaje });
    } catch (err) {
      if (err instanceof PrecheckinError && err.status === 400 && /expir|volver|usó/i.test(err.message)) {
        // El token vencio o ya se uso: se vuelve al primer paso sin conservar nada.
        setPaso({ tipo: "verificar" });
        setCodigo("");
        setUltimos4("");
      }
      setError(err instanceof Error ? err.message : "No pudimos guardar tus datos.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <ClipboardCheck className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <h1 className="text-xl font-display font-semibold text-foreground">Pre-check-in</h1>
          {typeof info === "object" && "propiedad" in info && <span className="truncate text-sm text-muted-foreground">· {info.propiedad}</span>}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 sm:px-6" aria-live="polite">
        {info === "cargando" && <EstadoCargando etiqueta="Cargando…" />}
        {info === "no_encontrado" && <EstadoVacio titulo="Enlace no válido" mensaje="No encontramos esta propiedad. Revisa que el enlace esté completo o pídele uno nuevo a tu anfitrión." />}
        {typeof info === "object" && "error" in info && (info.sinMigrar ? <EstadoVacio titulo="Aún no disponible" mensaje="El pre-check-in todavía no está disponible para esta propiedad. Escribe a tu anfitrión." /> : <EstadoError titulo="Ocurrió un problema" mensaje={info.error} onReintentar={() => setRecarga((n) => n + 1)} />)}

        {typeof info === "object" && "propiedad" in info && paso.tipo === "verificar" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Encuentra tu reserva</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={(e) => void verificar(e)} noValidate>
                <p className="m-0 text-sm text-muted-foreground">Escribe el código de confirmación de tu reserva (por ejemplo, el que empieza con HM en Airbnb) y los últimos 4 dígitos del teléfono con el que reservaste.</p>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Código de confirmación
                  <Input type="text" value={codigo} maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} required onChange={(e) => setCodigo(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Últimos 4 dígitos de tu teléfono
                  <Input type="text" inputMode="numeric" pattern="[0-9]{4}" value={ultimos4} maxLength={4} autoComplete="off" required onChange={(e) => setUltimos4(e.target.value.replace(/\D/g, ""))} />
                </Label>
                {error && <Callout tone="danger" role="alert">{error}</Callout>}
                <Button type="submit" size="sm" disabled={enviando || codigo.trim() === "" || ultimos4.length !== 4} className="self-start">
                  {enviando ? "Buscando…" : "Continuar"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {typeof info === "object" && "propiedad" in info && paso.tipo === "capturar" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tus datos de contacto</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={(e) => void capturar(e)} noValidate>
                <p className="m-0 text-sm text-muted-foreground">
                  Encontramos tu reserva en <strong className="text-foreground">{paso.unidad}</strong>: llegada {fechaLarga(paso.checkIn)}, salida {fechaLarga(paso.checkOut)}. Te enviaremos las instrucciones de acceso por correo antes de tu llegada.
                </p>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Correo electrónico
                  <Input type="email" value={correo} maxLength={254} autoComplete="email" required onChange={(e) => setCorreo(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  WhatsApp (opcional)
                  <Input type="tel" value={whatsapp} maxLength={24} autoComplete="tel" onChange={(e) => setWhatsapp(e.target.value)} />
                </Label>
                <section aria-label="Aviso de privacidad" className="rounded-lg border border-border bg-muted px-2.5 py-2 text-xs text-muted-foreground">
                  <p className="m-0 mb-1 font-medium text-foreground">{info.aviso.titulo}</p>
                  {info.aviso.parrafos.map((p) => (
                    <p key={p} className="m-0 mb-1">{p}</p>
                  ))}
                </section>
                <Checkbox checked={aceptaPrivacidad} onChange={(e) => setAceptaPrivacidad(e.target.checked)} label="Acepto el aviso de privacidad" />
                {reglamento && (
                  <>
                    <section aria-label="Reglamento de la casa" className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted px-2.5 py-2 text-xs text-foreground">
                      {reglamento}
                    </section>
                    <Checkbox checked={aceptaReglamento} onChange={(e) => setAceptaReglamento(e.target.checked)} label="Acepto el reglamento de la casa" />
                  </>
                )}
                {error && <Callout tone="danger" role="alert">{error}</Callout>}
                <Button type="submit" size="sm" disabled={enviando || correo.trim() === "" || !aceptaPrivacidad || (reglamento !== null && !aceptaReglamento)} className="self-start">
                  {enviando ? "Guardando…" : "Enviar"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {paso.tipo === "listo" && (
          <Card>
            <CardContent>
              <div className="flex items-start gap-2 py-1">
                <CheckCircle2 className="mt-0.5 size-5 text-success" strokeWidth={1.75} />
                <div>
                  <p className="m-0 text-sm font-medium text-foreground">Listo</p>
                  <p className="m-0 text-sm text-muted-foreground">{paso.mensaje}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
