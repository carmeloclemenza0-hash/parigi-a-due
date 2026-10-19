/* Ricordi condivisi per tappa: pulsante sotto ogni tappa, pannello dal basso, accesso, diario.
 * I dati passano solo da `api` (memories-api.js, o la versione finta dei test). */
(function () {
  const trip = window.PARIS_TRIP;
  const { toast, icon, escapeHTML: esc } = window.PARIS_APP;
  const $ = id => document.getElementById(id);
  const CACHE_KEY = `${trip.storageKey}-memories`;
  const MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.82;
  const MAX_PHOTOS = 6;
  const MAX_NOTE = 2000;

  // Ogni tappa per id, con il suo giorno: serve per titoli e diario.
  const stops = new Map();
  for (const day of trip.days) for (const group of day.groups) for (const item of group.items) stops.set(item.id, { day, item });

  // --- Logica pura (provata in tests/browser-checks.js) ---

  // Misure della foto rimpicciolita: il lato lungo non supera `max`, mai ingrandita.
  function fitWithin(width, height, max = MAX_SIDE) {
    const scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  function countByStop(memories) {
    const counts = {};
    for (const memory of memories) counts[memory.stopId] = (counts[memory.stopId] || 0) + 1;
    return counts;
  }

  // Diario: un gruppo per giorno del viaggio, ricordi in ordine di tempo; i giorni vuoti spariscono.
  function groupByDay(memories) {
    return trip.days
      .map(day => ({ day, memories: memories.filter(m => stops.get(m.stopId)?.day === day).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
      .filter(group => group.memories.length);
  }

  window.ParisMemories = { fitWithin, countByStop, groupByDay };

  // --- Interfaccia: Task 4–6 ---
})();
