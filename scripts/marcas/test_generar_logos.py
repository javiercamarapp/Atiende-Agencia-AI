"""Prueba de comportamiento de generar-logos.py: _SoloRegistro y descargar() rechazan hosts ajenos. Uso: python3 -I scripts/marcas/test_generar_logos.py"""
import importlib.util
import os
import unittest
import urllib.error
import urllib.request

ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generar-logos.py")
spec = importlib.util.spec_from_file_location("generar_logos", ruta)
gl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gl)


class Redirecciones(unittest.TestCase):
    def setUp(self):
        self.h = gl._SoloRegistro()
        self.req = urllib.request.Request("https://registry.npmjs.org/simple-icons/-/x.tgz")

    def test_redireccion_ajena_falla(self):
        for url in ("https://evil.example/x.tgz", "http://registry.npmjs.org/x.tgz", "https://registry.npmjs.org.evil.example/x.tgz"):
            with self.assertRaises(urllib.error.URLError, msg=url):
                self.h.redirect_request(self.req, None, 302, "Found", {}, url)

    def test_redireccion_al_registro_pasa(self):
        nuevo = self.h.redirect_request(self.req, None, 302, "Found", {}, "https://registry.npmjs.org/otro.tgz")
        self.assertEqual(nuevo.full_url, "https://registry.npmjs.org/otro.tgz")

    def test_descargar_host_ajeno_aborta(self):
        with self.assertRaises(SystemExit):
            gl.descargar("https://evil.example/x.tgz")


if __name__ == "__main__":
    unittest.main(verbosity=0)
