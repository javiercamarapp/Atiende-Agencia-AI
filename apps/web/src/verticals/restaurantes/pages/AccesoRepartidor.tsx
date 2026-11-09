// Acceso del REPARTIDOR con su celular + codigo de 6 digitos por WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md). Pantalla movil: dos pasos
// (celular -> codigo), controles de >= 56 px, estados de carga / no disponible / error, foco y lectores de pantalla atendidos.
// Backend real: POST /auth/login-telefono/solicitar|verificar (apps/api/src/routes/auth-login-telefono.ts). La respuesta de "solicitar" es
// identica exista o no la cuenta, asi que el aviso de envio es siempre condicional ("si el numero esta registrado...").
// Encargado, cajero y administradores siguen entrando con correo (/restaurantes/login).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, EstadoCargando, EstadoVacio, FormField, Input, useT } from "@atiende/ui";
import { restaurantesAccesoChofer } from "@atiende/ui/i18n/restaurantes/accesoChofer";
import { MarcoPublico } from "../../../components/MarcoPublico.tsx";
import { decideLandingPath, persistSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";
import { consultarDisponibilidadLoginCelular, formatearCelular, normalizarCelular, normalizarCodigo, solicitarCodigoCelular, verificarCodigoCelular } from "../lib/login-telefono-client.ts";

/** Segundos antes de poder pedir otro codigo (el servidor ademas limita 3 envios / 15 min por numero). */
export const ESPERA_REENVIO_SEGUNDOS = 30;

export interface AccesoRepartidorProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
  /** Solo pruebas. */
  readonly fetchImpl?: typeof fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

type Fase = "comprobando" | "no_disponible" | "celular" | "codigo";

export function AccesoRepartidorPage({ apiBaseUrl, onLoggedIn, fetchImpl, storage }: AccesoRepartidorProps) {
  const t = useT(restaurantesAccesoChofer);
  useDocumentTitle(t("restaurantes.accesoChofer.tituloDocumento"));
  const f = fetchImpl ?? fetch;
  const [fase, setFase] = useState<Fase>("comprobando");
  const [celularTexto, setCelularTexto] = useState("");
  const [celular, setCelular] = useState<string | null>(null);
  const [codigoTexto, setCodigoTexto] = useState("");
  const [errorCelular, setErrorCelular] = useState<string | null>(null);
  const [errorCodigo, setErrorCodigo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const [espera, setEspera] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const campoCodigo = useRef<HTMLInputElement | null>(null);
  const campoCelular = useRef<HTMLInputElement | null>(null);
  const idAyudaCodigo = useId();

  useEffect(() => {
    let vivo = true;
    void consultarDisponibilidadLoginCelular(f, apiBaseUrl).then((ok) => {
      if (vivo) setFase(ok ? "celular" : "no_disponible");
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, f]);

  // Cuenta regresiva del reenvio.
  useEffect(() => {
    if (espera <= 0) return;
    const t = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  // Al cambiar de paso, el foco va al campo nuevo (teclado numerico listo en el celular).
  useEffect(() => {
    if (fase === "codigo") campoCodigo.current?.focus();
    if (fase === "celular") campoCelular.current?.focus();
  }, [fase]);

  const pedirCodigo = useCallback(
    async (nacional: string): Promise<boolean> => {
      setEnviando(true);
      setErrorCelular(null);
      setErrorCodigo(null);
      setAviso(null);
      const r = await solicitarCodigoCelular(f, apiBaseUrl, nacional);
      setEnviando(false);
      if (!r.ok) {
        if (r.motivo === "no_disponible") setFase("no_disponible");
        else if (fase === "codigo") setErrorCodigo(r.mensaje);
        else setErrorCelular(r.mensaje);
        return false;
      }
      setEspera(ESPERA_REENVIO_SEGUNDOS);
      return true;
    },
    [apiBaseUrl, f, fase],
  );

  async function enviarCelular(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    const nacional = normalizarCelular(celularTexto);
    if (!nacional) {
      setErrorCelular(t("restaurantes.accesoChofer.celularInvalido"));
      return;
    }
    setCelular(nacional);
    if (await pedirCodigo(nacional)) {
      setCodigoTexto("");
      setFase("codigo");
    }
  }

  async function reenviar() {
    if (!celular || enviando || espera > 0) return;
    if (await pedirCodigo(celular)) setAviso(t("restaurantes.accesoChofer.reenviado"));
  }

  async function entrar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verificando || !celular) return;
    const codigo = normalizarCodigo(codigoTexto);
    if (!codigo) {
      setErrorCodigo(t("restaurantes.accesoChofer.codigoInvalido"));
      return;
    }
    setVerificando(true);
    setErrorCodigo(null);
    setAviso(null);
    const r = await verificarCodigoCelular(f, apiBaseUrl, celular, codigo);
    setVerificando(false);
    if (!r.ok) {
      if (r.motivo === "no_disponible") setFase("no_disponible");
      else {
        setErrorCodigo(r.mensaje);
        setCodigoTexto("");
        campoCodigo.current?.focus();
      }
      return;
    }
    persistSession(storage ?? window.localStorage, r.session);
    onLoggedIn(r.session, decideLandingPath(r.session));
  }

  if (fase === "comprobando") {
    return (
      <MarcoPublico titulo={t("restaurantes.accesoChofer.titulo")}>
        <EstadoCargando etiqueta={t("restaurantes.accesoChofer.unMomento")} />
      </MarcoPublico>
    );
  }

  if (fase === "no_disponible") {
    return (
      <MarcoPublico titulo={t("restaurantes.accesoChofer.titulo")}>
        <EstadoVacio
          titulo={t("restaurantes.accesoChofer.noDisponibleTitulo")}
          mensaje={t("restaurantes.accesoChofer.noDisponibleTexto")}
          accion={
            <Button asChild variant="outline" className="h-14 w-full text-base">
              <Link to="/restaurantes/login">{t("restaurantes.accesoChofer.entrarCorreo")}</Link>
            </Button>
          }
        />
      </MarcoPublico>
    );
  }

  if (fase === "celular") {
    return (
      <MarcoPublico titulo={t("restaurantes.accesoChofer.titulo")} descripcion={t("restaurantes.accesoChofer.descripcion")}>
        <form onSubmit={(e) => void enviarCelular(e)} className="flex flex-col gap-4" noValidate>
          <FormField label={t("restaurantes.accesoChofer.celular")} hint={t("restaurantes.accesoChofer.celularAyuda")} error={errorCelular ?? undefined} required>
            <Input
              ref={campoCelular}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="999 123 4567"
              value={celularTexto}
              onChange={(e) => setCelularTexto(e.target.value)}
              className="h-14 text-lg"
            />
          </FormField>
          <Button type="submit" loading={enviando} className="h-14 w-full text-base">
            {t("restaurantes.accesoChofer.enviarCodigo")}
          </Button>
        </form>
        <Link to="/restaurantes/login" className="inline-flex min-h-14 items-center justify-center text-sm underline underline-offset-2 text-foreground">
          {t("restaurantes.accesoChofer.soyEncargado")}
        </Link>
      </MarcoPublico>
    );
  }

  return (
    <MarcoPublico
      titulo={t("restaurantes.accesoChofer.codigoTitulo")}
      descripcion={celular ? t("restaurantes.accesoChofer.codigoDescripcion", { celular: formatearCelular(celular) }) : undefined}
    >
      <form onSubmit={(e) => void entrar(e)} className="flex flex-col gap-4" noValidate>
        <FormField label={t("restaurantes.accesoChofer.codigo")} error={errorCodigo ?? undefined} required>
          <Input
            ref={campoCodigo}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="000000"
            aria-describedby={idAyudaCodigo}
            value={codigoTexto}
            onChange={(e) => setCodigoTexto(e.target.value.replace(/[^\d\s]/g, ""))}
            className="h-14 text-center text-2xl tracking-[0.4em]"
          />
        </FormField>
        <p id={idAyudaCodigo} className="sr-only">
          {t("restaurantes.accesoChofer.codigoAyuda")}
        </p>
        <Button type="submit" loading={verificando} className="h-14 w-full text-base">
          {t("restaurantes.accesoChofer.entrar")}
        </Button>
      </form>
      <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {aviso}
      </div>
      <div className="flex flex-col gap-1">
        <Button type="button" variant="outline" onClick={() => void reenviar()} disabled={enviando || espera > 0} className="h-14 w-full text-base">
          {espera > 0 ? t("restaurantes.accesoChofer.reenviarEn", { s: espera }) : t("restaurantes.accesoChofer.reenviar")}
        </Button>
        <button
          type="button"
          onClick={() => {
            setFase("celular");
            setErrorCodigo(null);
            setAviso(null);
          }}
          className="inline-flex min-h-14 items-center justify-center text-sm underline underline-offset-2 text-foreground"
        >
          {t("restaurantes.accesoChofer.cambiarNumero")}
        </button>
      </div>
    </MarcoPublico>
  );
}
