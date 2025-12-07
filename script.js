var map = new maplibregl.Map({
    container:'map',
    style:{
      version:8,
      sources:{
        'empty':{ type:'raster', tiles:[], tileSize:256 }
      },
      layers:[
        { id:'background', type:'background', paint:{ 'background-color':'#000' } }
      ]
    },
    center:[10.99,45.44],
    zoom:9
});

map.on('load', ()=>{ console.log("Map loaded placeholder"); });
