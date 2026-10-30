#!/usr/bin/env python3
"""Genera packages/ui/src/lib/logos-marca.generated.ts a partir del tarball npm de `simple-icons` (CC0 sobre el
archivo; la MARCA sigue siendo de su titular, ver LICENCIAS-MARCAS.md).

Garantias de procedencia (ds3 / 2.4):
  * Solo Python estandar (3.9+), sin Node. NO se instala el paquete ni se ejecuta ningun script suyo: se descarga el
    .tgz, se verifica su sha1 y sha512 contra los valores FIJADOS aqui (y contra los que publica el registro npm), y se
    LEEN en memoria unicamente los .svg listados en MARCAS_SIMPLE_ICONS (mas LICENSE.md y data/simple-icons.json).
  * Cada SVG se valida: un solo <path d="...">, viewBox 0 0 24 24, sin script/style/href/on*. Si algo no cuadra, aborta.
  * No hay datos inventados: una marca sin asset verificado va a PENDIENTES_MARCA con su motivo.
  * Salida determinista (la fecha de la fuente esta fijada abajo, no se lee el reloj).

Uso:
  python3 scripts/marcas/generar-logos.py                  # descarga, verifica y escribe el .generated.ts
  python3 scripts/marcas/generar-logos.py --tarball RUTA   # sin red: usa un tarball ya descargado (se verifica igual)
  python3 scripts/marcas/generar-logos.py --check          # exit 1 si el .generated.ts no coincide con lo que se generaria
  python3 scripts/marcas/generar-logos.py --pendientes     # solo imprime PENDIENTES_MARCA (no necesita red)
Para subir de version: cambia VERSION, SHA1, SHA512 (copialos de `https://registry.npmjs.org/simple-icons/<version>`,
campos dist.shasum y dist.integrity), FECHA_FUENTE, regenera y revisa el diff.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.error
import urllib.request

PAQUETE = "simple-icons"
VERSION = "16.36.0"
SHA1 = "45f50dc2ec8fa7a14b68b6eb1b8ac1c1e4340772"
SHA512_B64 = "+VNPPkqSOLidFeSgBKUWX4n50WPpDC09hav+BgS26anIF1oQOlGBb8LvwGR+6fYRjo+B6CiKzNBceMPkSVXANQ=="
FECHA_FUENTE = "2026-10-26"
LICENCIA = "CC0-1.0"
URL_TARBALL = "https://registry.npmjs.org/%s/-/%s-%s.tgz" % (PAQUETE, PAQUETE, VERSION)
URL_META = "https://registry.npmjs.org/%s/%s" % (PAQUETE, VERSION)

# marca de Atiende -> (slug en simple-icons, titulo legible)
MARCAS_SIMPLE_ICONS = [
    ("whatsapp", "whatsapp", "WhatsApp"),
    ("google-calendar", "googlecalendar", "Google Calendar"),
    ("stripe", "stripe", "Stripe"),
    ("airbnb", "airbnb", "Airbnb"),
    ("expedia", "expedia", "Expedia"),
]

# Marcas SIN asset oficial verificado (o que se decide no mostrar como logo). Nunca se rellenan con dibujos propios.
#   tipo: "pendiente-asset" (el dueño debe aportarlo) | "restringida" (marca con uso restringido) | "solo-texto" (decision de diseno)
PENDIENTES = [
    ("google", "Google", "pendiente-asset",
     "La «G» multicolor oficial NO sale de simple-icons (es monocroma). Falta copiar el SVG del kit de identidad de Google; "
     "mientras tanto el login sigue con GoogleIcon (redibujo existente) y LogoMarca muestra icono neutro + nombre."),
    ("booking", "Booking.com", "restringida",
     "Marca de uso restringido (REDISENO §9-P6): aunque simple-icons trae «bookingdotcom», se deja en texto + icono neutro "
     "hasta que el dueño del producto decida. La decision queda registrada cambiando el tipo/motivo de esta entrada y regenerando, en un PR."),
    ("vrbo", "Vrbo", "pendiente-asset",
     "simple-icons %s no incluye «vrbo». Falta el asset oficial del titular." % VERSION),
    ("tripadvisor", "Tripadvisor", "solo-texto",
     "Licencia obligatoria para usar el «Ojo» (REDISENO §2.10): solo texto + icono neutro."),
    ("meta", "Meta", "solo-texto",
     "Solo texto (plantillas de WhatsApp); sin decir «partner» de Meta (REDISENO §9-P6)."),
    ("openstreetmap", "OpenStreetMap", "solo-texto",
     "No es logo: atribucion de texto con enlace OBLIGATORIA (ODbL) en el mapa; no se pinta como marca."),
    ("softrestaurant", "SoftRestaurant", "pendiente-asset",
     "Sin asset oficial ni permiso de uso nominativo. El dueño aporta el SVG/PNG claro y oscuro (REDISENO §9-P6)."),
]

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SALIDA = os.path.join(RAIZ, "packages", "ui", "src", "lib", "logos-marca.generated.ts")

RE_PATH_D = re.compile(r'^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$')
RE_SVG = re.compile(
    r'^<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>([^<]+)</title>'
    r'<path d="([^"]+)"/></svg>\s*$')


def aborta(msg):
    sys.stderr.write("ERROR: %s\n" % msg)
    sys.exit(2)


class _SoloRegistro(urllib.request.HTTPRedirectHandler):
    """Solo sigue redirecciones que se queden en registry.npmjs.org (https)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://registry.npmjs.org/"):
            raise urllib.error.URLError("redireccion fuera de registry.npmjs.org: %s" % newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def descargar(url, intentos=4):
    if not url.startswith("https://registry.npmjs.org/"):
        aborta("host no permitido: %s" % url)
    abridor = urllib.request.build_opener(_SoloRegistro)
    ultimo = None
    for n in range(intentos):
        try:
            with abridor.open(url, timeout=120) as r:
                return r.read()
        except Exception as e:  # red inestable: espera (2, 4, 8 s) y reintenta
            ultimo = e
            if n < intentos - 1:
                time.sleep(2 ** (n + 1))
    aborta("no se pudo descargar %s (%s). Sin red: usa --tarball RUTA o --pendientes." % (url, ultimo))


def verificar(datos):
    sha1 = hashlib.sha1(datos).hexdigest()
    sha512 = base64.b64encode(hashlib.sha512(datos).digest()).decode("ascii")
    if sha1 != SHA1:
        aborta("sha1 del tarball (%s) != fijado (%s)" % (sha1, SHA1))
    if sha512 != SHA512_B64:
        aborta("sha512 del tarball (%s) != fijado (%s)" % (sha512, SHA512_B64))


def verificar_contra_registro():
    meta = json.loads(descargar(URL_META).decode("utf-8"))
    d = meta.get("dist", {})
    if d.get("shasum") != SHA1 or d.get("integrity") != "sha512-" + SHA512_B64:
        aborta("los hashes fijados no coinciden con los del registro npm (dist.shasum / dist.integrity)")
    if meta.get("license") != LICENCIA:
        aborta("licencia del paquete = %r, se esperaba %s" % (meta.get("license"), LICENCIA))


def leer(tf, nombre):
    try:
        m = tf.getmember("package/" + nombre)
    except KeyError:
        return None
    if not m.isfile() or m.size > 2_000_000:
        aborta("miembro inesperado en el tarball: %s" % nombre)
    return tf.extractfile(m).read()


def extraer(datos):
    tf = tarfile.open(fileobj=io.BytesIO(datos), mode="r:gz")
    lic = leer(tf, "LICENSE.md")
    if lic is None or b"CC0 1.0 Universal" not in lic:
        aborta("LICENSE.md del paquete no es CC0 1.0")
    catalogo = json.loads(leer(tf, "data/simple-icons.json").decode("utf-8"))
    por_slug = {}
    for it in catalogo:
        slug = it.get("slug")
        if slug is None:
            # misma regla que simple-icons: titulo en minusculas sin signos
            slug = re.sub(r"[^a-z0-9]", "", it["title"].lower())
        por_slug[slug] = it
    activos = []
    for marca, slug, titulo in MARCAS_SIMPLE_ICONS:
        raw = leer(tf, "icons/%s.svg" % slug)
        if raw is None:
            aborta("simple-icons %s no incluye %s.svg: muevela a PENDIENTES" % (VERSION, slug))
        m = RE_SVG.match(raw.decode("utf-8"))
        if not m:
            aborta("%s.svg no tiene la forma esperada (un solo <path>, viewBox 0 0 24 24)" % slug)
        if not RE_PATH_D.match(m.group(2)):
            aborta("%s.svg: el atributo d contiene caracteres inesperados" % slug)
        if slug not in por_slug:
            aborta("%s no esta en data/simple-icons.json" % slug)
        hexa = por_slug[slug]["hex"].upper()
        if not re.match(r"^[0-9A-F]{6}$", hexa):
            aborta("hex invalido para %s: %r" % (slug, hexa))
        activos.append((marca, slug, titulo, m.group(2), "#" + hexa))
    return activos


def constante(marca):
    return "LOGO_" + marca.upper().replace("-", "_")


def generar_ts(activos):
    o = []
    w = o.append
    w("// ARCHIVO GENERADO por scripts/marcas/generar-logos.py -- NO EDITAR A MANO (regenera y revisa el diff).")
    w("// Fuente: paquete npm `%s` %s (tarball verificado: sha1 %s; sha512 %s)." % (PAQUETE, VERSION, SHA1, SHA512_B64))
    w("// Fecha de la fuente: %s. Licencia del ARCHIVO: %s (los SVG de simple-icons)." % (FECHA_FUENTE, LICENCIA))
    w("// La MARCA de cada logo sigue siendo de su titular; uso nominativo para referenciar integraciones (ver LICENCIAS-MARCAS.md).")
    w("// Unico archivo de packages/ui con hex de marca permitido. `simple-icons` NO es una dependencia del repo.")
    w("")
    w("export interface LogoMarcaAsset {")
    w("  readonly titulo: string;")
    w("  readonly viewBox: string;")
    w("  /** Atributo `d` del unico <path> del SVG oficial (viewBox 0 0 24 24). */")
    w("  readonly path: string;")
    w("  /** Color de marca (hex) segun simple-icons. */")
    w("  readonly hex: string;")
    w("}")
    w("")
    w("export const FUENTE_LOGOS_MARCA = {")
    w('  paquete: "%s",' % PAQUETE)
    w('  version: "%s",' % VERSION)
    w('  sha1: "%s",' % SHA1)
    w('  integrity: "sha512-%s",' % SHA512_B64)
    w('  fecha: "%s",' % FECHA_FUENTE)
    w('  licencia: "%s",' % LICENCIA)
    w("} as const;")
    w("")
    for marca, slug, titulo, d, hexa in activos:
        w("export const %s: LogoMarcaAsset = {" % constante(marca))
        w("  titulo: %s," % json.dumps(titulo, ensure_ascii=False))
        w('  viewBox: "0 0 24 24",')
        w("  path: %s," % json.dumps(d))
        w('  hex: "%s",' % hexa)
        w("};")
        w("")
    w("/** Marcas con asset verificado, por clave de `LogoMarca`. */")
    w("export const LOGOS_MARCA_GENERADOS = {")
    for marca, _s, _t, _d, _h in activos:
        w("  %s: %s," % (json.dumps(marca), constante(marca)))
    w("} as const satisfies Record<string, LogoMarcaAsset>;")
    w("")
    w("export type MarcaConAsset = keyof typeof LOGOS_MARCA_GENERADOS;")
    w("")
    w('export type TipoPendienteMarca = "pendiente-asset" | "restringida" | "solo-texto";')
    w("")
    w("/** Marcas SIN asset oficial verificado: se muestran con icono neutro + nombre. Nunca se rellenan con dibujos propios. */")
    w("export const PENDIENTES_MARCA = [")
    for marca, nombre, tipo, motivo in PENDIENTES:
        w("  {")
        w("    marca: %s," % json.dumps(marca))
        w("    nombre: %s," % json.dumps(nombre, ensure_ascii=False).replace(".", "\\u002e"))
        w("    tipo: %s," % json.dumps(tipo))
        w("    motivo: %s," % json.dumps(motivo, ensure_ascii=False))
        w("  },")
    w("] as const satisfies ReadonlyArray<{ marca: string; nombre: string; tipo: TipoPendienteMarca; motivo: string }>;")
    w("")
    w("export type MarcaPendiente = (typeof PENDIENTES_MARCA)[number][\"marca\"];")
    w("")
    w("/** Solo las claves (sin los motivos): lo que importa `LogoMarca`, para no arrastrar el texto de PENDIENTES_MARCA al bundle. */")
    w("export const CLAVES_PENDIENTES_MARCA = [%s] as const satisfies ReadonlyArray<MarcaPendiente>;" % ", ".join(json.dumps(p[0]) for p in PENDIENTES))
    w("")
    return "\n".join(o)


def imprimir_pendientes():
    print("PENDIENTES_MARCA (%d):" % len(PENDIENTES))
    for marca, nombre, tipo, motivo in PENDIENTES:
        print("  - %-15s [%s] %s" % (marca, tipo, motivo))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tarball", help="ruta a simple-icons-%s.tgz ya descargado (sin red)" % VERSION)
    ap.add_argument("--check", action="store_true", help="no escribe; falla si el archivo generado esta desactualizado")
    ap.add_argument("--pendientes", action="store_true", help="solo imprime PENDIENTES_MARCA")
    ap.add_argument("--sin-registro", action="store_true", help="no consulta el registro npm (los hashes fijados se siguen exigiendo)")
    a = ap.parse_args()
    if a.pendientes:
        imprimir_pendientes()
        return 0
    if a.tarball:
        with open(a.tarball, "rb") as f:
            datos = f.read()
    else:
        datos = descargar(URL_TARBALL)
    verificar(datos)
    if not a.sin_registro and not a.tarball:
        verificar_contra_registro()
    ts = generar_ts(extraer(datos))
    if a.check:
        actual = open(SALIDA, encoding="utf-8").read() if os.path.exists(SALIDA) else ""
        if actual != ts:
            sys.stderr.write("logos-marca.generated.ts desactualizado: corre generar-logos.py\n")
            return 1
        print("OK: %s esta al dia" % os.path.relpath(SALIDA, RAIZ))
        return 0
    with open(SALIDA, "w", encoding="utf-8", newline="\n") as f:
        f.write(ts)
    print("escrito %s (%d marcas con asset)" % (os.path.relpath(SALIDA, RAIZ), len(MARCAS_SIMPLE_ICONS)))
    imprimir_pendientes()
    return 0


if __name__ == "__main__":
    sys.exit(main())
