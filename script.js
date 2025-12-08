const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',

  // CENTRO SU VERONA
  center: [10.9916, 45.4384],
  zoom: 10,
  pitch: 45,
  bearing: -15,

  // BLOCCA LA MAPPA SU VERONA (niente giro per l’Europa)
  maxBounds: [
    [10.85, 45.33], // sud-ovest
    [11.15, 45.55]  // nord-est
  ]
});

map.on('load', () => {
  map.addSource('comuni', {
    type: 'geojson',
    data: 'data/comuni_verona_metropolitana.geojson'
  });

  // RIEMPIMENTO (futuristico, leggero)
  map.addLayer({
    id: 'comuni-fill',
    type: 'fill-extrusion',
    source: 'comuni',
    paint: {
      'fill-extrusion-color': '#004433',
      'fill-extrusion-height': 1500,
      'fill-extrusion-opacity': 0.35
    }
  });

  // CONTORNI VERDI COME DA UMAPP
  map.addLayer({
    id: 'comuni-line',
    type: 'line',
    source: 'comuni',
    paint: {
      'line-color': '#00ff9c',
      'line-width': 1.5
    }
  });

  // 👉 ZOOM AUTOMATICO SUI COMUNI
  const bounds = new maplibregl.LngLatBounds();
  comuni.features.forEach(f => {
    f.geometry.coordinates[0].forEach(c => bounds.extend(c));
  });
  map.fitBounds(bounds, { padding: 40, duration: 1000 });
});
