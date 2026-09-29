/* Applies the saved light/dark preference before first paint (storage may be unavailable). */
try { var th = localStorage.getItem('urh_theme'); if (th === 'dark' || th === 'light') document.documentElement.setAttribute('data-theme', th); } catch (e) {}
