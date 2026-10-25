(function(d,w){var r=d.documentElement,o,t,m,q,l;try{l=w.localStorage;t=l.getItem("atiende-tema")}catch{t=0}
o=t=="oscuro"||(t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches);
r.classList.toggle("dark",!!o);m=d.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",o?"#0e0e10":"#ffffff");
q=new URLSearchParams(w.location.search).get("diseno");
try{if(q=="ds3")l.setItem("atiende-diseno",q);else if(q=="off")l.removeItem("atiende-diseno");else q=l.getItem("atiende-diseno")}catch{q=0}
if(q=="ds3")r.dataset.diseno=q})(document,window);
