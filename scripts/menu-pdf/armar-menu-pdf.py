#!/usr/bin/env python3
"""Arma los PDF del menu por sucursal (uno por pagina oficial, una imagen por pagina de 612x792 pt) para apps/web/public/menu-pdf.

Uso: python3 scripts/menu-pdf/armar-menu-pdf.py <carpeta> <salida> [slug ...]
  <carpeta>  contiene fotos/<slug>/NN.jpg|jpeg (las imagenes oficiales de https://www.lostaquitosdepm.com, 8 o 9 por sucursal)
  <salida>   donde se escriben menu-<slug>.pdf
  slugs      por omision: montejo-altabrisa-victory fco-montejo galerias playa (Pensiones y los menus en ingles NO se publican; ver docs/restaurantes/menu-pdf-por-sucursal.md)

Cada imagen se reescala a 1700/1600/1500 px de ancho (la mayor que quepa) y se recomprime en JPEG 4:2:0 (sin EXIF) bajando la calidad de 82 a 40 de 2 en 2
hasta que el PDF pese <= 2.9 MB. Requiere Pillow (pip install pillow). Despues hay que actualizar docs/restaurantes/menu-pdf-manifiesto.json (SHA-256 y bytes):
la prueba packages/domain-restaurantes/tests/menu-pdf-alojado.spec.ts falla si no coinciden. Escribe PDF 1.4 a mano (sin dependencias de PDF)."""
import glob
import io
import os
import sys

from PIL import Image

W, H = 612, 792
LIMITE = 2_900_000
SLUGS = ["montejo-altabrisa-victory", "fco-montejo", "galerias", "playa"]


def armar_pdf(jpegs, destino):
    objs = []

    def add(x):
        objs.append(x)
        return len(objs)

    cat = add(b"")
    pages = add(b"")
    kids = []
    for b, (w, h) in jpegs:
        im = add(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % (w, h, len(b)) + b + b"\nendstream")
        esc = min(W / w, H / h)
        dw, dh = w * esc, h * esc
        cont = ("q %.4f 0 0 %.4f %.4f %.4f cm /Im0 Do Q" % (dw, dh, (W - dw) / 2, (H - dh) / 2)).encode()
        c = add(b"<< /Length %d >>\nstream\n" % len(cont) + cont + b"\nendstream")
        kids.append(add(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>" % (W, H, im, c)))
    objs[cat - 1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[pages - 1] = b"<< /Type /Pages /Count %d /Kids [%s] >>" % (len(kids), b" ".join(b"%d 0 R" % k for k in kids))
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for n, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % n + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    with open(destino, "wb") as fh:
        fh.write(out)
    return len(out)


def codificar(ims, ancho, calidad):
    res = []
    for im in ims:
        r = im.resize((ancho, round(im.height * ancho / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        r.save(buf, "JPEG", quality=calidad, optimize=True, subsampling=2)
        res.append((buf.getvalue(), r.size))
    return res


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    carpeta, salida = sys.argv[1], sys.argv[2]
    os.makedirs(salida, exist_ok=True)
    for slug in sys.argv[3:] or SLUGS:
        ims = [Image.open(f).convert("RGB") for f in sorted(glob.glob(os.path.join(carpeta, "fotos", slug, "[0-9][0-9].jp*g")))]
        if not ims:
            print("sin imagenes:", slug)
            continue
        for ancho in (1700, 1600, 1500):
            for calidad in range(82, 39, -2):
                jp = codificar(ims, ancho, calidad)
                if sum(len(b) for b, _ in jp) <= LIMITE - 8000:
                    destino = os.path.join(salida, "menu-%s.pdf" % slug)
                    print(destino, len(ims), "paginas", ancho, "px q", calidad, armar_pdf(jp, destino), "bytes")
                    break
            else:
                continue
            break
        else:
            sys.exit("no cabe en %d bytes: %s" % (LIMITE, slug))


if __name__ == "__main__":
    main()
