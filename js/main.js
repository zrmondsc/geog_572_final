const CONFIG = {
  courtGeojsonPath: "data/external/huge_basketball_court.geojson",
  playerJsonPath: "data/processed/player_itineraries_downsampled_25_frames_huge.json",
  initialCenter: [-98, 39],
  initialZoom: 2.9,
  initialPitch: 45,
  initialBearing: -8,
  style: "mapbox://styles/mondschz/cmmnxu9ij006p01suafybg2ip"
};


const LAYERS = {
  courtFill: "court-fill",
  courtLine: "court-line",
  courtLabel: "court-label",
  playerPoints: "player-points",
  playerLabels: "player-labels"
};



// =====================================
// Huge Basketball Court - Mapbox GL JS
// =====================================

// Replace this with your own Mapbox public token
mapboxgl.accessToken = "pk.eyJ1IjoibW9uZHNjaHoiLCJhIjoiY21tNThyenZuMDFyMDJ4b3M3MWFqdXFqbSJ9.5dpIdeNz2kqHx7nN0uNnFA";

// Build map
const map = new mapboxgl.Map({
  container: "map",
  style: CONFIG.style,
  center: CONFIG.initialCenter,
  zoom: CONFIG.initialZoom,
  pitch: CONFIG.initialPitch,
  bearing: CONFIG.initialBearing,
  antialias: true
});

map.addControl(new mapboxgl.NavigationControl(), "top-right");
map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: "imperial" }));

let courtData = null;
let courtBounds = null;

let playerData = null;
let playerIndex = [];
let frameList = [];
let currentFrame = null;
let isPlaying = false;
let playInterval = null;

// -----------------------------
// Helpers
// -----------------------------
function computeBoundsFromGeoJSON(geojson) {
  const bounds = new mapboxgl.LngLatBounds();

  for (const feature of geojson.features) {
    if (!feature.geometry) continue;
    const geom = feature.geometry;

    if (geom.type === "Polygon") {
      for (const ring of geom.coordinates) {
        for (const coord of ring) bounds.extend(coord);
      }
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          for (const coord of ring) bounds.extend(coord);
        }
      }
    }
  }

  return bounds;
}

function safeNameExpression() {
  return ["downcase", ["coalesce", ["get", "name"], ["get", "label"], ""]];
}

function setLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function addCourtSource(data) {
  if (map.getSource("court")) return;

  map.addSource("court", {
    type: "geojson",
    data
  });
}

function addCourtLayers() {
  const featureName = safeNameExpression();

  // Filled areas
  map.addLayer({
    id: LAYERS.courtFill,
    type: "fill",
    source: "court",
    paint: {
      "fill-color": [
        "case",

        ["==", featureName, "court surface"], "#c49a57",

        ["any",
          ["==", featureName, "north key"],
          ["==", featureName, "south key"]
        ], "#d7882f",

        ["==", featureName, "center circle"], "#cf7b24",

        ["any",
          ["==", featureName, "north free throw circle"],
          ["==", featureName, "south free throw circle"]
        ], "#e0a14d",

        ["any",
          ["==", featureName, "north rim"],
          ["==", featureName, "south rim"],
          ["==", featureName, "center mark"]
        ], "#f15a24",

        "#d9d4c8"
      ],
      "fill-opacity": [
        "case",
        ["==", featureName, "court surface"], 0.82,
        0.55
      ]
    }
  });

  // Court outlines / lines
  map.addLayer({
    id: LAYERS.courtLine,
    type: "line",
    source: "court",
    paint: {
      "line-color": [
        "case",
        ["any",
          ["==", featureName, "north rim"],
          ["==", featureName, "south rim"],
          ["==", featureName, "center mark"]
        ],
        "#ff6b2d",
        "#fff6df"
      ],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        2, 1,
        4, 2,
        6, 3,
        8, 5
      ]
    }
  });

  // Labels
  map.addLayer({
    id: LAYERS.courtLabel,
    type: "symbol",
    source: "court",
    layout: {
      "text-field": ["coalesce", ["get", "name"], ["get", "label"], ""],
      "text-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        2, 10,
        4, 12,
        6, 14
      ],
      "text-allow-overlap": false
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#111111",
      "text-halo-width": 1.2
    }
  });
}

function bindCourtInteractions() {
  map.on("click", LAYERS.courtFill, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;

    const props = feature.properties || {};
    const name = props.name || props.label || "Court feature";
    const type = props.feature_type || props.type || feature.geometry?.type || "unknown";

    new mapboxgl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`
        <strong>${name}</strong><br>
        Type: ${type}
      `)
      .addTo(map);
  });

  map.on("mouseenter", LAYERS.courtFill, () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", LAYERS.courtFill, () => {
    map.getCanvas().style.cursor = "";
  });
}

function wireUI() {
  const fillToggle = document.getElementById("toggle-court-fill");
  const lineToggle = document.getElementById("toggle-court-lines");
  const labelToggle = document.getElementById("toggle-labels");
  const resetBtn = document.getElementById("reset-view");

  fillToggle.addEventListener("change", (e) => {
    setLayerVisibility(LAYERS.courtFill, e.target.checked);
  });

  lineToggle.addEventListener("change", (e) => {
    setLayerVisibility(LAYERS.courtLine, e.target.checked);
  });

  labelToggle.addEventListener("change", (e) => {
    setLayerVisibility(LAYERS.courtLabel, e.target.checked);
  });

  resetBtn.addEventListener("click", () => {
    if (!courtBounds) return;
    map.fitBounds(courtBounds, {
      padding: 40,
      pitch: CONFIG.initialPitch,
      bearing: CONFIG.initialBearing,
      duration: 1200
    });
  });
}

async function loadCourtData() {
  const response = await fetch(CONFIG.courtGeojsonPath);
  if (!response.ok) {
    throw new Error(`Failed to load GeoJSON: ${response.status} ${response.statusText}`);
  }

  courtData = await response.json();
  courtBounds = computeBoundsFromGeoJSON(courtData);
}


async function loadPlayerData() {
  const response = await fetch(CONFIG.playerJsonPath);
  if (!response.ok) {
    throw new Error(`Failed to load player JSON: ${response.status} ${response.statusText}`);
  }

  playerData = await response.json();
  playerIndex = Object.values(playerData).sort((a, b) =>
    (a.player_name || "").localeCompare(b.player_name || "")
  );

  const frameSet = new Set();

  for (const player of playerIndex) {
    for (const step of (player.trajectory || [])) {
      frameSet.add(step.frame_idx);
    }
  }

  frameList = Array.from(frameSet).sort((a, b) => a - b);

  if (frameList.length > 0) {
    currentFrame = frameList[0];
  }
}

function buildPlayerFeatures(frameIdx, selectedPlayerId = "__all__") {
  const features = [];

  for (const player of playerIndex) {
    if (selectedPlayerId !== "__all__" && String(player.player_id) !== String(selectedPlayerId)) {
      continue;
    }

    const step = (player.trajectory || []).find(d => d.frame_idx === frameIdx);
    if (!step) continue;

    if (
      step.x_huge === undefined || step.x_huge === null ||
      step.y_huge === undefined || step.y_huge === null
    ) {
      continue;
    }

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [step.x_huge, step.y_huge]
      },
      properties: {
        player_id: player.player_id,
        player_name: player.player_name || "",
        team_abbr: player.team_abbr || "",
        team_name: player.team_name || "",
        jersey: player.jersey || "",
        position: player.position || "",
        frame_idx: step.frame_idx,
        period: step.period,
        game_clock: step.game_clock,
        shot_clock: step.shot_clock
      }
    });
  }

  return {
    type: "FeatureCollection",
    features
  };
}

function addPlayerSourceAndLayers() {
  if (!map.getSource("players")) {
    map.addSource("players", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: []
      }
    });
  }

  if (!map.getLayer(LAYERS.playerPoints)) {
    map.addLayer({
      id: LAYERS.playerPoints,
      type: "circle",
      source: "players",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 4,
          4, 6,
          6, 8
        ],
        "circle-color": [
          "match",
          ["get", "team_abbr"],
          "ATL", "#e03a3e",
          "BOS", "#007a33",
          "#4cc9f0"
        ],
        "circle-stroke-color": "#111111",
        "circle-stroke-width": 1.2,
        "circle-opacity": 0.95
      }
    });
  }

  if (!map.getLayer(LAYERS.playerLabels)) {
    map.addLayer({
      id: LAYERS.playerLabels,
      type: "symbol",
      source: "players",
      layout: {
        "text-field": [
          "coalesce",
          ["get", "jersey"],
          ["get", "player_name"]
        ],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 9,
          5, 11,
          7, 13
        ],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-allow-overlap": false
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#111111",
        "text-halo-width": 1.2
      }
    });
  }
}

function populatePlayerFilter() {
  const select = document.getElementById("player-filter");
  if (!select) return;

  for (const player of playerIndex) {
    const option = document.createElement("option");
    option.value = String(player.player_id);
    option.textContent = `${player.player_name} (${player.team_abbr || ""})`;
    select.appendChild(option);
  }
}

function getSelectedPlayerId() {
  const select = document.getElementById("player-filter");
  return select ? select.value : "__all__";
}

function updateTimeReadout(frameIdx) {
  const readout = document.getElementById("time-readout");
  if (readout) {
    readout.textContent = frameIdx;
  }
}

function updateSliderPosition(frameIdx) {
  const slider = document.getElementById("time-slider");
  if (!slider) return;

  const idx = frameList.indexOf(frameIdx);
  if (idx >= 0) {
    slider.value = idx;
  }
}

function renderPlayersAtFrame(frameIdx) {
  if (!map.getSource("players")) return;

  currentFrame = frameIdx;

  const selectedPlayerId = getSelectedPlayerId();
  const fc = buildPlayerFeatures(frameIdx, selectedPlayerId);

  map.getSource("players").setData(fc);
  updateSliderPosition(frameIdx);
  updateTimeReadout(frameIdx);
}

function stepForwardFrame() {
  if (!frameList.length) return;

  const currentIdx = frameList.indexOf(currentFrame);
  const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % frameList.length : 0;
  renderPlayersAtFrame(frameList[nextIdx]);
}

function togglePlayback() {
  const btn = document.getElementById("play-pause-btn");
  isPlaying = !isPlaying;

  if (isPlaying) {
    if (btn) btn.textContent = "Pause";
    playInterval = window.setInterval(() => {
      stepForwardFrame();
    }, 250);
  } else {
    if (btn) btn.textContent = "Play";
    if (playInterval) {
      window.clearInterval(playInterval);
      playInterval = null;
    }
  }
}

function bindPlayerInteractions() {
  map.on("click", LAYERS.playerPoints, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;

    const props = feature.properties || {};

    new mapboxgl.Popup()
      .setLngLat(feature.geometry.coordinates)
      .setHTML(`
        <strong>${props.player_name || "Unknown player"}</strong><br>
        Team: ${props.team_abbr || "N/A"}<br>
        Jersey: ${props.jersey || "N/A"}<br>
        Position: ${props.position || "N/A"}<br>
        Frame: ${props.frame_idx ?? "N/A"}<br>
        Period: ${props.period ?? "N/A"}<br>
        Game clock: ${props.game_clock ?? "N/A"}<br>
        Shot clock: ${props.shot_clock ?? "N/A"}
      `)
      .addTo(map);
  });

  map.on("mouseenter", LAYERS.playerPoints, () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", LAYERS.playerPoints, () => {
    map.getCanvas().style.cursor = "";
  });
}

function wirePlayerUI() {
  const playerFilter = document.getElementById("player-filter");
  const timeSlider = document.getElementById("time-slider");
  const playPauseBtn = document.getElementById("play-pause-btn");

  if (timeSlider) {
    timeSlider.min = 0;
    timeSlider.max = Math.max(frameList.length - 1, 0);
    timeSlider.step = 1;
    timeSlider.value = 0;

    timeSlider.addEventListener("input", (e) => {
      const idx = Number(e.target.value);
      const frameIdx = frameList[idx];
      if (frameIdx !== undefined) {
        renderPlayersAtFrame(frameIdx);
      }
    });
  }

  if (playerFilter) {
    playerFilter.addEventListener("change", () => {
      renderPlayersAtFrame(currentFrame);
    });
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", () => {
      togglePlayback();
    });
  }
}

// -----------------------------
// Main
// -----------------------------
map.on("style.load", async () => {
  try {
    if (!courtData) {
      await loadCourtData();
    }

    if (!playerData) {
      await loadPlayerData();
    }

    addCourtSource(courtData);
    addCourtLayers();
    bindCourtInteractions();
    wireUI();

    addPlayerSourceAndLayers();
    populatePlayerFilter();
    bindPlayerInteractions();
    wirePlayerUI();

    map.fitBounds(courtBounds, {
      padding: 40,
      pitch: CONFIG.initialPitch,
      bearing: CONFIG.initialBearing,
      duration: 0
    });

    if (frameList.length > 0) {
      renderPlayersAtFrame(frameList[0]);
    }
  } catch (error) {
    console.error(error);
    alert("There was a problem loading the court or player data. Check the console.");
  }
});