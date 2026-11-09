(function(d,w){var r=d.documentElement,o,t,m;if(d.querySelector('meta[name="atiende-diseno-legado"]'))return;r.dataset.diseno="ds3";
try{t=w.localStorage.getItem("atiende-tema");o=!/\/login\/?$/.test(w.location.pathname)&&(t=="oscuro"||t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches)}catch{o=0}
r.classList.toggle("dark",!!o);r.dataset.theme=o?"dark":"light";m=d.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",o?"#0e0e10":"#ffffff")})(document,window);
