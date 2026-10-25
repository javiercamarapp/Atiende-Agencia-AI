#!/usr/bin/env python3
"""Convierte colores hex a tripletes HSL sin `hsl()` ("H S% L%"), el formato de los tokens de packages/ui/src/index.css, y
viceversa; sirve para verificar los valores de referencia del sistema de diseno con tolerancia de 1/255 por canal.

Uso:
  python3 scripts/diseno/hex2hsl.py "#1D4FD7" "#0e0e10"            # hex -> triplete
  python3 scripts/diseno/hex2hsl.py --a-hex "224 76% 48%"          # triplete -> hex
  python3 scripts/diseno/hex2hsl.py --comprobar "#1D4FD7" "224 76% 48%"   # sale 1 si difieren en mas de 1/255 por canal
Compatible con Python 3.9.
"""
import colorsys
import re
import sys

TOL = 1  # 1/255 por canal


def hex_a_rgb(h):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", h):
        raise ValueError(f"hex invalido: {h!r}")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_a_triplete(rgb):
    r, g, b = (c / 255 for c in rgb)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    num = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")  # noqa: E731
    return f"{num(h * 360)} {num(s * 100)}% {num(l * 100)}%"


def triplete_a_rgb(t):
    m = re.fullmatch(r"\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*", t)
    if not m:
        raise ValueError(f"triplete invalido: {t!r} (esperado 'H S% L%')")
    h, s, l = float(m.group(1)) / 360, float(m.group(2)) / 100, float(m.group(3)) / 100
    return tuple(round(c * 255) for c in colorsys.hls_to_rgb(h, l, s))


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "--a-hex":
        for t in argv[1:]:
            print("#%02x%02x%02x" % triplete_a_rgb(t))
        return 0
    if argv[0] == "--comprobar":
        if len(argv) != 3:
            print("uso: --comprobar <hex> <triplete>", file=sys.stderr)
            return 2
        a, b = hex_a_rgb(argv[1]), triplete_a_rgb(argv[2])
        dif = max(abs(x - y) for x, y in zip(a, b))
        print(f"{argv[1]} vs {argv[2]}: diferencia maxima {dif}/255 ({'OK' if dif <= TOL else 'FUERA DE TOLERANCIA'})")
        return 0 if dif <= TOL else 1
    for h in argv:
        print(f"{h} -> {rgb_a_triplete(hex_a_rgb(h))}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
