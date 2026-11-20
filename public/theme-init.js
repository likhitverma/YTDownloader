// Runs before first paint so the saved theme never flashes. (External file: the CSP forbids inline scripts.)
(function () {
  try {
    var t = localStorage.getItem("mediadock-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage unavailable: default dark */ }
})();
