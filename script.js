const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [10.99, 45.44],
  zoom: 9,
  pitch: 45,
  bearing: -20
});

map.on('load', () => {
  map.addSource('comuni', {
    type: 'geojson',
    data: 'data/comuni_verona.geojson'
  });

  map.addLayer({
    id: 'comuni-fill',
    type: 'fill-extrusion',
    source: 'comuni',
    paint: {
      'fill-extrusion-color': '#003322',
      'fill-extrusion-height': 2000,
      'fill-extrusion-opacity': 0.35
    }
  });

  map.addLayer({
    id: 'comuni-line',
    type: 'line',
    source: 'comuni',
    paint: {
      'line-color': '#00ff9c',
      'line-width': 1.8
    }
  });
});
