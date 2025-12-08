const map = L.map('map', {
  center: [45.4384, 10.9916],
  zoom: 11,
  zoomControl: true
});

// BASEMAP NERO REALE
L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    attribution: '© OpenStreetMap, © CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }
).addTo(map);

// CARICAMENTO COMUNI
fetch('data/comuni_verona_metropolitana.geojson')
  .then(r => r.json())
  .then(data => {

    const comuniLayer = L.geoJSON(data, {
      style: {
        color: '#00ff9c',
        weight: 1.5,
        fillColor: '#003322',
        fillOpacity: 0.35
      },
      onEachFeature: (feature, layer) => {
        const nome = feature.properties.name || feature.properties.nome || 'Comune';

        layer.bindTooltip(nome, {
          permanent: true,
          direction: 'center',
          className: 'comune-label'
        });

        layer.on('click', () => {
          map.fitBounds(layer.getBounds(), {
            padding: [40, 40]
          });
        });
      }
    }).addTo(map);

    map.fitBounds(comuniLayer.getBounds());
  });
