const map = L.map('map').setView([45.4384, 10.9916], 12);
layer.setStyle({
  color: '#00ff9c',
  weight: 2,
  fillOpacity: 0
});
L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    attribution: '© OpenStreetMap, © CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }
).addTo(map);
