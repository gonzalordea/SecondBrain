// Runs before the app paints so the saved theme never flashes the wrong colours.
// (A separate file because the CSP forbids inline scripts.)
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* storage blocked: fall back to the OS preference */ }
