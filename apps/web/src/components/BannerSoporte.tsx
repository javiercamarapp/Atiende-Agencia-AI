// Banner PERMANENTE de la sesión de soporte (superadmin dentro del panel de un cliente). Se monta en `VerticalShellConectado`,
// común a las 6 verticales, y se pinta SOLO si el token del shell lleva el claim `soporte` (ver lib/soporte.ts): un login normal
// nunca lo ve. Muestra «Estás viendo como <organización> — sesión de soporte, caduca en hh:mm», el estado (solo lectura / edición
// habilitada), «Permitir edición» (segundo motivo registrado) y «Salir». Sondea /soporte/estado cada 30 s; si la sesión terminó
// o venció, cierra la sesión local y vuelve a la consola de plataforma. La autoridad real es la guarda de la API, no este banner.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Button, ConfirmDialog, notify } from "@atiende/ui";
import {
  MOTIVO_SOPORTE_MAXIMO,
  MOTIVO_SOPORTE_MINIMO,
  PERSISTIR_POR_VERTICAL,
  consultarEstadoSoporte,
  elevarSoporte,
  formatearRestante,
  leerNombreOrganizacion,
  leerSoporteDelToken,
  limpiarSesionSoporteLocal,
  salirDeSoporte,
} from "../lib/soporte.ts";
import type { LoginSession } from "../lib/auth-client.ts";

const POLL_MS = 30_000;
const TICK_MS = 15_000;
const DESTINO_AL_SALIR = "/superadmin/organizaciones";

export interface BannerSoporteProps {
  readonly apiBaseUrl: string;
  /** Token que está usando el shell. Sin claim `soporte` el banner no existe. */
  readonly token: string;
  /** Inyectables para pruebas con reloj fijo y sin recargar la página. */
  readonly ahora?: () => number;
  readonly recargar?: () => void;
  readonly fetchImpl?: typeof fetch;
}

export function BannerSoporte(props: BannerSoporteProps) {
  const soporte = leerSoporteDelToken(props.token);
  if (!soporte) return null;
  return <BannerSoporteActivo {...props} />;
}

function BannerSoporteActivo({ apiBaseUrl, token, ahora = Date.now, recargar = () => window.location.reload(), fetchImpl }: BannerSoporteProps) {
  const navigate = useNavigate();
  const soporte = leerSoporteDelToken(token)!;
  const doFetch = useCallback<typeof fetch>((...a) => (fetchImpl ?? fetch)(...a), [fetchImpl]);
  const [now, setNow] = useState(ahora());
  const [saliendo, setSaliendo] = useState(false);
  const [elevando, setElevando] = useState(false);
  const nombre = leerNombreOrganizacion(window.localStorage, soporte.sid) ?? "esta organización";
  const restanteMs = soporte.expiresAtMs - now;

  const terminarLocal = useCallback(
    (mensaje?: string) => {
      limpiarSesionSoporteLocal(window.localStorage, soporte.vertical);
      if (mensaje) notify.error(mensaje);
      navigate(DESTINO_AL_SALIR, { replace: true });
    },
    [navigate, soporte.vertical],
  );

  // Cuenta regresiva y vencimiento local.
  useEffect(() => {
    const id = window.setInterval(() => setNow(ahora()), TICK_MS);
    return () => window.clearInterval(id);
  }, [ahora]);
  useEffect(() => {
    if (restanteMs <= 0) terminarLocal("La sesión de soporte venció.");
  }, [restanteMs, terminarLocal]);

  // Estado verificado en el servidor (por si la terminaron desde la consola).
  useEffect(() => {
    let cancelado = false;
    const consultar = async () => {
      const estado = await consultarEstadoSoporte(doFetch, apiBaseUrl, token);
      if (!cancelado && estado && !estado.active) terminarLocal("La sesión de soporte terminó.");
    };
    const id = window.setInterval(() => void consultar(), POLL_MS);
    return () => {
      cancelado = true;
      window.clearInterval(id);
    };
  }, [apiBaseUrl, token, doFetch, terminarLocal]);

  async function salir() {
    setSaliendo(true);
    await salirDeSoporte(doFetch, apiBaseUrl, token);
    limpiarSesionSoporteLocal(window.localStorage, soporte.vertical);
    navigate(DESTINO_AL_SALIR, { replace: true });
  }

  async function elevar(motivo?: string) {
    try {
      const nuevoToken = await elevarSoporte(doFetch, apiBaseUrl, token, motivo);
      const raw = window.localStorage.getItem(sessionKeyDe(soporte.vertical));
      const actual = raw ? (JSON.parse(raw) as LoginSession) : null;
      const persistir = PERSISTIR_POR_VERTICAL[soporte.vertical];
      if (!actual || !persistir) throw new Error("No se encontró la sesión del panel.");
      persistir(window.localStorage, { ...actual, token: nuevoToken });
      notify.success("Edición habilitada en esta sesión de soporte. Queda registrada.");
      recargar();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo habilitar la edición.");
      throw err;
    }
  }

  return (
    <div role="alert" data-testid="banner-soporte" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="w-4 h-4 text-destructive shrink-0" strokeWidth={1.75} />
        <span className="text-destructive font-medium">
          Estás viendo como {nombre} — sesión de soporte, caduca en {formatearRestante(soporte.expiresAtMs, now)}
        </span>
        <span className="text-muted-foreground shrink-0">{soporte.soloLectura ? "Solo lectura" : "Edición habilitada"}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {soporte.soloLectura && (
          <Button variant="outline" size="sm" onClick={() => setElevando(true)}>
            Permitir edición
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void salir()} disabled={saliendo}>
          {saliendo ? "Saliendo…" : "Salir"}
        </Button>
      </div>
      <ConfirmDialog
        open={elevando}
        onOpenChange={setElevando}
        titulo="Permitir edición"
        descripcion="La sesión pasa de solo lectura a edición. Queda en la bitácora con tu motivo. Pagos, contraseñas, privacidad, mensajes reales a clientes y borrados siguen bloqueados."
        confirmar="Permitir edición"
        campo={{
          etiqueta: "Motivo",
          multilinea: true,
          minLength: MOTIVO_SOPORTE_MINIMO,
          maxLength: MOTIVO_SOPORTE_MAXIMO,
          ayuda: `Obligatorio, mínimo ${MOTIVO_SOPORTE_MINIMO} caracteres.`,
          placeholder: "Ej. Corregir el precio mal capturado de un producto.",
        }}
        onConfirm={elevar}
      />
    </div>
  );
}

// Las llaves de sesión de cada vertical viven en su auth-client.ts; se reconstruyen aquí para releer la sesión persistida sin
// importar siete módulos de lectura: `atiende.<vertical>.session` es el formato común (ver SESSION_KEY de cada uno).
function sessionKeyDe(vertical: string): string {
  return `atiende.${vertical}.session`;
}
