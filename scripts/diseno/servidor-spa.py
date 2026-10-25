#!/usr/bin/env python3
"""Servidor estatico con fallback de SPA (sin Node): sirve una carpeta construida (p. ej. apps/web/dist-catalogo) y devuelve
index.html para cualquier ruta sin archivo, como hace `vite preview`. Solo para verificacion local o en CI; no es de produccion.

Uso: python3 scripts/diseno/servidor-spa.py <carpeta> [puerto]     (puerto por omision: 5190; escucha solo en 127.0.0.1)
"""
import http.server
import os
import sys


class SPA(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        ruta = self.translate_path(self.path.split("?", 1)[0].split("#", 1)[0])
        if not os.path.exists(ruta) and not os.path.splitext(ruta)[1]:
            self.path = "/index.html"
        return super().send_head()


if __name__ == "__main__":
    carpeta = sys.argv[1] if len(sys.argv) > 1 else "."
    puerto = int(sys.argv[2]) if len(sys.argv) > 2 else 5190
    handler = lambda *a, **k: SPA(*a, directory=carpeta, **k)  # noqa: E731
    with http.server.ThreadingHTTPServer(("127.0.0.1", puerto), handler) as srv:
        print(f"sirviendo {os.path.abspath(carpeta)} en http://127.0.0.1:{puerto}", flush=True)
        srv.serve_forever()
