const OFFICIAL_GTFS_URL = "https://api3.ottop.org/download/gtfs/ooXuXei4op7y/5000020472115";
const CITY_SOURCE_URL = "https://www.city.okinawa.okinawa.jp/k036-001/chiikikankyou/koukyoukoutsuu/shibus/25042.html";
const REQUIRED_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"];
const FREE_TRANSFER_STOPS = new Set(["中部興産沖縄市役所前", "BCコザ（市立図書館）", "ミュージックタウン"]);
const WALK_TRANSFER_PAIRS = [["美里市営住宅前", "美原4丁目"]];
const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  feed: null,
  graph: null,
  stopsByName: new Map(),
  routeStops: new Map(),
  selectedRouteId: "all",
  pickTarget: "from",
  lastSource: ""
};

const el = {
  status: document.getElementById("dataStatus"),
  from: document.getElementById("fromStop"),
  to: document.getElementById("toStop"),
  date: document.getElementById("serviceDate"),
  time: document.getElementById("departTime"),
  timeLabel: document.getElementById("timeLabel"),
  search: document.getElementById("searchBtn"),
  swap: document.getElementById("swapBtn"),
  pickFrom: document.getElementById("pickFromBtn"),
  pickTo: document.getElementById("pickToBtn"),
  file: document.getElementById("gtfsFile"),
  retry: document.getElementById("retryBtn"),
  list: document.getElementById("stopList"),
  routeTabs: document.getElementById("routeTabs"),
  routeMap: document.getElementById("routeMap"),
  stopButtons: document.getElementById("stopButtons"),
  stopPanelTitle: document.getElementById("stopPanelTitle"),
  stopFilter: document.getElementById("stopFilter"),
  results: document.getElementById("results")
};

init();

function init() {
  const now = new Date();
  el.date.value = toDateInput(now);
  el.time.value = toTimeInput(now);
  el.search.addEventListener("click", searchRoute);
  el.swap.addEventListener("click", () => {
    [el.from.value, el.to.value] = [el.to.value, el.from.value];
    updateMapSelection();
  });
  el.pickFrom.addEventListener("click", () => setPickTarget("from"));
  el.pickTo.addEventListener("click", () => setPickTarget("to"));
  el.retry.addEventListener("click", () => loadOfficialGtfs());
  el.file.addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) loadZipBlob(file, file.name);
  });
  el.stopFilter.addEventListener("input", renderStopButtons);
  document.querySelectorAll('input[name="timeMode"]').forEach(input => {
    input.addEventListener("change", updateTimeModeLabel);
    input.closest("label")?.addEventListener("click", () => setTimeout(updateTimeModeLabel, 0));
  });
  updateTimeModeLabel();
  loadOfficialGtfs();
}

async function loadOfficialGtfs() {
  setStatus("公式GTFSを取得中...", false);
  try {
    const res = await fetch(OFFICIAL_GTFS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadZipBlob(await res.blob(), "公式GTFS");
  } catch (error) {
    setStatus("公式GTFSの自動取得に失敗。ZIPを読み込んでください。", true);
    showMessage(`公式GTFSをブラウザから取得できませんでした。データ更新・読み込み欄からGTFS ZIPを選択してください。詳細: ${error.message}`);
  }
}

async function loadZipBlob(blob, sourceLabel) {
  setStatus(`${sourceLabel}を解析中...`, false);
  try {
    const files = await unzipGtfs(await blob.arrayBuffer());
    const missing = REQUIRED_FILES.filter(name => !files[name]);
    if (missing.length) throw new Error(`必要なGTFSファイルが不足しています: ${missing.join(", ")}`);
    state.feed = parseGtfs(files);
    state.graph = buildGraph(state.feed);
    state.routeStops = buildRouteStops(state.feed);
    state.lastSource = sourceLabel;
    fillStops(state.feed.stops);
    renderRouteTabs();
    renderRouteMap();
    renderStopButtons();
    setStatus(`${sourceLabel}: ${state.feed.stops.length}停留所 / ${state.feed.trips.length}便`, false);
    showMessage("データを読み込みました。路線図または停留所名から出発地・目的地を選んでください。");
  } catch (error) {
    setStatus("GTFS解析に失敗しました", true);
    showMessage(`読み込みに失敗しました: ${error.message}`);
  }
}

function parseGtfs(files) {
  const stops = parseCsv(files["stops.txt"])
    .filter(row => !row.location_type || row.location_type === "0")
    .map(row => ({ id: row.stop_id, name: cleanName(row.stop_name), lat: Number(row.stop_lat), lon: Number(row.stop_lon) }));
  const routes = new Map(parseCsv(files["routes.txt"]).map(row => [row.route_id, {
    id: row.route_id,
    name: cleanName(row.route_short_name || row.route_long_name),
    longName: cleanName(row.route_long_name || row.route_short_name),
    color: cleanName(row.route_color || "")
  }]));
  const trips = parseCsv(files["trips.txt"]).map(row => ({
    id: row.trip_id,
    routeId: row.route_id,
    serviceId: row.service_id,
    headsign: cleanName(row.trip_headsign || "")
  }));
  const stopTimesByTrip = new Map();
  for (const row of parseCsv(files["stop_times.txt"])) {
    const item = {
      tripId: row.trip_id,
      arrival: timeToMinutes(row.arrival_time),
      departure: timeToMinutes(row.departure_time),
      stopId: row.stop_id,
      sequence: Number(row.stop_sequence)
    };
    if (!stopTimesByTrip.has(item.tripId)) stopTimesByTrip.set(item.tripId, []);
    stopTimesByTrip.get(item.tripId).push(item);
  }
  for (const times of stopTimesByTrip.values()) times.sort((a, b) => a.sequence - b.sequence);
  const calendars = parseCalendars(files["calendar.txt"], files["calendar_dates.txt"]);
  return { stops, stopById: new Map(stops.map(stop => [stop.id, stop])), routes, trips, tripById: new Map(trips.map(trip => [trip.id, trip])), stopTimesByTrip, calendars };
}

function parseCalendars(calendarText, dateText) {
  const services = new Map();
  for (const row of parseCsv(calendarText)) {
    services.set(row.service_id, {
      id: row.service_id,
      start: row.start_date,
      end: row.end_date,
      days: [row.sunday, row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday].map(v => v === "1"),
      exceptions: new Map()
    });
  }
  for (const row of parseCsv(dateText)) {
    if (!services.has(row.service_id)) {
      services.set(row.service_id, { id: row.service_id, start: "00000000", end: "99999999", days: [false, false, false, false, false, false, false], exceptions: new Map() });
    }
    services.get(row.service_id).exceptions.set(row.date, row.exception_type);
  }
  return services;
}

function buildGraph(feed) {
  const departures = new Map();
  const walkTransfers = new Map();
  const addWalk = (from, to) => {
    if (!walkTransfers.has(from)) walkTransfers.set(from, []);
    walkTransfers.get(from).push({ to, minutes: 4 });
  };
  for (const [aName, bName] of WALK_TRANSFER_PAIRS) {
    for (const a of feed.stops.filter(stop => stop.name === aName)) {
      for (const b of feed.stops.filter(stop => stop.name === bName)) {
        addWalk(a.id, b.id);
        addWalk(b.id, a.id);
      }
    }
  }
  for (const trip of feed.trips) {
    const times = feed.stopTimesByTrip.get(trip.id) || [];
    const route = feed.routes.get(trip.routeId) || { name: trip.routeId, longName: trip.routeId };
    for (let i = 0; i < times.length - 1; i++) {
      const from = times[i];
      if (!departures.has(from.stopId)) departures.set(from.stopId, []);
      departures.get(from.stopId).push({
        tripId: trip.id,
        routeId: trip.routeId,
        routeName: route.name || route.longName,
        headsign: trip.headsign,
        serviceId: trip.serviceId,
        depart: from.departure,
        stopIndex: i,
        times
      });
    }
  }
  for (const list of departures.values()) list.sort((a, b) => a.depart - b.depart);
  return { departures, walkTransfers };
}

function buildRouteStops(feed) {
  const routeStops = new Map();
  for (const trip of feed.trips) {
    const times = feed.stopTimesByTrip.get(trip.id) || [];
    if (!routeStops.has(trip.routeId)) routeStops.set(trip.routeId, []);
    const list = routeStops.get(trip.routeId);
    for (const time of times) {
      if (!list.includes(time.stopId)) list.push(time.stopId);
    }
  }
  return routeStops;
}

function fillStops(stops) {
  const unique = new Map();
  for (const stop of stops) if (!unique.has(stop.name)) unique.set(stop.name, stop);
  state.stopsByName = unique;
  el.list.innerHTML = [...unique.keys()].sort((a, b) => a.localeCompare(b, "ja")).map(name => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function renderRouteTabs() {
  const routeButtons = [`<button class="route-tab active" type="button" data-route-id="all">全路線</button>`];
  for (const route of state.feed.routes.values()) {
    routeButtons.push(`<button class="route-tab" type="button" data-route-id="${escapeHtml(route.id)}">${escapeHtml(route.name || route.longName)}</button>`);
  }
  el.routeTabs.innerHTML = routeButtons.join("");
  el.routeTabs.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedRouteId = button.dataset.routeId;
      el.routeTabs.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
      renderRouteMap();
      renderStopButtons();
    });
  });
}

function renderRouteMap() {
  if (!state.feed) return;
  const stops = getVisibleStops();
  if (!stops.length) {
    el.routeMap.innerHTML = `<div class="empty">表示できる停留所がありません。</div>`;
    return;
  }
  const bounds = getBounds(stops);
  const width = 760;
  const height = 430;
  const point = stop => {
    const x = 40 + ((stop.lon - bounds.minLon) / Math.max(0.0001, bounds.maxLon - bounds.minLon)) * (width - 90);
    const y = 35 + ((bounds.maxLat - stop.lat) / Math.max(0.0001, bounds.maxLat - bounds.minLat)) * (height - 80);
    return { x, y };
  };
  const routeLines = [];
  const routes = state.selectedRouteId === "all" ? [...state.routeStops.keys()] : [state.selectedRouteId];
  for (const routeId of routes) {
    const route = state.feed.routes.get(routeId);
    const routeStopIds = state.routeStops.get(routeId) || [];
    const points = routeStopIds.map(id => state.feed.stopById.get(id)).filter(Boolean).map(point);
    if (points.length < 2) continue;
    const d = points.map((p, index) => `${index === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    routeLines.push(`<path d="${d}" fill="none" stroke="${routeColor(route?.name || "")}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.78"></path>`);
  }
  const selectedNames = new Set([cleanName(el.from.value), cleanName(el.to.value)].filter(Boolean));
  const dots = stops.map(stop => {
    const p = point(stop);
    const selected = selectedNames.has(stop.name) ? " selected" : "";
    return `<g class="map-stop${selected}" data-stop-name="${escapeHtml(stop.name)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
      <circle r="6"></circle>
      <text x="9" y="4">${escapeHtml(shortStopName(stop.name))}</text>
      <title>${escapeHtml(stop.name)}</title>
    </g>`;
  }).join("");
  el.routeMap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img">${routeLines.join("")}${dots}</svg>`;
  el.routeMap.querySelectorAll(".map-stop").forEach(node => {
    node.addEventListener("click", () => chooseStop(node.dataset.stopName));
  });
}

function renderStopButtons() {
  if (!state.feed) return;
  const route = state.selectedRouteId === "all" ? null : state.feed.routes.get(state.selectedRouteId);
  const filter = cleanName(el.stopFilter.value).toLowerCase();
  const stops = getVisibleStops()
    .filter(stop => !filter || stop.name.toLowerCase().includes(filter))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  el.stopPanelTitle.textContent = route ? `${route.name || route.longName}の停留所` : "全停留所";
  el.stopButtons.innerHTML = stops.map(stop => `<button class="stop-button" type="button" data-stop-name="${escapeHtml(stop.name)}"><span class="dot"></span><span>${escapeHtml(stop.name)}</span></button>`).join("");
  el.stopButtons.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => chooseStop(button.dataset.stopName));
  });
}

function getVisibleStops() {
  if (!state.feed) return [];
  if (state.selectedRouteId === "all") return [...state.stopsByName.values()];
  const ids = state.routeStops.get(state.selectedRouteId) || [];
  const unique = new Map();
  for (const id of ids) {
    const stop = state.feed.stopById.get(id);
    if (stop && !unique.has(stop.name)) unique.set(stop.name, stop);
  }
  return [...unique.values()];
}

function chooseStop(name) {
  if (state.pickTarget === "from") {
    el.from.value = name;
    setPickTarget("to");
  } else {
    el.to.value = name;
  }
  updateMapSelection();
}

function setPickTarget(target) {
  state.pickTarget = target;
  el.pickFrom.classList.toggle("active-pick", target === "from");
  el.pickTo.classList.toggle("active-pick", target === "to");
}

function updateMapSelection() {
  renderRouteMap();
}

function searchRoute() {
  updateTimeModeLabel();
  if (!state.feed || !state.graph) {
    showMessage("先にGTFSデータを読み込んでください。");
    return;
  }
  const fromStop = resolveStop(cleanName(el.from.value));
  const toStop = resolveStop(cleanName(el.to.value));
  if (!fromStop || !toStop) {
    showMessage("出発停留所と到着停留所を候補、路線図、停留所一覧から選んでください。");
    return;
  }
  if (fromStop.id === toStop.id) {
    showMessage("出発停留所と到着停留所が同じです。");
    return;
  }
  const targetMinute = timeToMinutes(`${el.time.value}:00`);
  const serviceKey = el.date.value.replaceAll("-", "");
  const mode = getTimeMode();
  const route = mode === "arrive"
    ? findLatestArrivalRoute(fromStop.id, toStop.id, targetMinute, serviceKey)
    : findEarliestRoute(fromStop.id, toStop.id, targetMinute, serviceKey);

  if (!route) {
    const suggestion = findServiceSuggestion(fromStop.id, toStop.id, serviceKey, targetMinute, mode);
    renderNoService(fromStop, toStop, serviceKey, targetMinute, mode, suggestion);
    return;
  }
  renderRoute(route, fromStop, toStop, targetMinute, mode);
}

function findEarliestRoute(originId, targetId, startMinute, serviceKey) {
  return runEarliestSearch(originId, targetId, startMinute, serviceKey);
}

function findLatestArrivalRoute(originId, targetId, targetMinute, serviceKey) {
  const candidates = candidateStartTimes(originId, serviceKey)
    .filter(time => time <= targetMinute)
    .sort((a, b) => b - a);
  let best = null;
  for (const start of candidates) {
    const route = runEarliestSearch(originId, targetId, start, serviceKey);
    if (!route || route.arrive > targetMinute) continue;
    if (!best || route.depart > best.depart || (route.depart === best.depart && route.arrive < best.arrive)) best = route;
  }
  return best;
}

function runEarliestSearch(originId, targetId, startMinute, serviceKey) {
  const best = new Map([[originId, startMinute]]);
  const previous = new Map();
  const queue = [{ stopId: originId, time: startMinute }];
  const activeCache = new Map();
  const isActive = dep => {
    if (!activeCache.has(dep.serviceId)) activeCache.set(dep.serviceId, isServiceActive(dep.serviceId, serviceKey));
    return activeCache.get(dep.serviceId);
  };

  while (queue.length) {
    queue.sort((a, b) => a.time - b.time);
    const current = queue.shift();
    if (current.time !== best.get(current.stopId)) continue;
    if (current.stopId === targetId) break;

    for (const walk of state.graph.walkTransfers.get(current.stopId) || []) {
      relax(walk.to, current.time + walk.minutes, {
        type: "walk",
        fromStopId: current.stopId,
        toStopId: walk.to,
        depart: current.time,
        arrive: current.time + walk.minutes,
        minutes: walk.minutes
      });
    }

    const departures = state.graph.departures.get(current.stopId) || [];
    for (const dep of departures) {
      if (dep.depart < current.time || !isActive(dep)) continue;
      for (let j = dep.stopIndex + 1; j < dep.times.length; j++) {
        const arrival = dep.times[j];
        if (arrival.arrival < dep.depart) continue;
        relax(arrival.stopId, arrival.arrival, {
          type: "ride",
          fromStopId: current.stopId,
          toStopId: arrival.stopId,
          depart: dep.depart,
          arrive: arrival.arrival,
          tripId: dep.tripId,
          routeId: dep.routeId,
          routeName: dep.routeName,
          headsign: dep.headsign,
          serviceId: dep.serviceId
        });
      }
    }
  }

  if (!best.has(targetId)) return null;
  const legs = [];
  let cursor = targetId;
  while (cursor !== originId) {
    const leg = previous.get(cursor);
    if (!leg) return null;
    legs.push(leg);
    cursor = leg.fromStopId;
  }
  const compact = compactLegs(legs.reverse());
  const firstRide = compact.find(leg => leg.type === "ride");
  return { depart: firstRide?.depart ?? startMinute, arrive: best.get(targetId), legs: compact, serviceKey };

  function relax(stopId, arrive, leg) {
    if (arrive >= (best.get(stopId) ?? Infinity)) return;
    best.set(stopId, arrive);
    previous.set(stopId, leg);
    queue.push({ stopId, time: arrive });
  }
}

function compactLegs(legs) {
  const compact = [];
  for (const leg of legs) {
    const last = compact[compact.length - 1];
    if (last && leg.type === "ride" && last.type === "ride" && last.tripId === leg.tripId && last.toStopId === leg.fromStopId) {
      last.toStopId = leg.toStopId;
      last.arrive = leg.arrive;
    } else {
      compact.push({ ...leg });
    }
  }
  return compact;
}

function candidateStartTimes(originId, serviceKey) {
  const times = new Set();
  const addFromStop = (stopId, offset = 0) => {
    for (const dep of state.graph.departures.get(stopId) || []) {
      if (isServiceActive(dep.serviceId, serviceKey)) times.add(Math.max(0, dep.depart - offset));
    }
  };
  addFromStop(originId);
  for (const walk of state.graph.walkTransfers.get(originId) || []) addFromStop(walk.to, walk.minutes);
  return [...times].sort((a, b) => a - b);
}

function findNearestRouteAround(originId, targetId, requestedAt, direction, mode) {
  const requestedDate = new Date(requestedAt);
  const requestedKey = toServiceKey(requestedDate);
  const requestedMinute = requestedDate.getHours() * 60 + requestedDate.getMinutes();
  let best = null;

  for (let offset = 0; offset <= 14; offset++) {
    const date = new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate() + offset * direction);
    const key = toServiceKey(date);
    const route = direction < 0
      ? findLatestArrivalRoute(originId, targetId, key === requestedKey ? requestedMinute : 24 * 60 - 1, key)
      : findEarliestRoute(originId, targetId, key === requestedKey ? requestedMinute : 0, key);
    if (!route) continue;

    const routeMinute = mode === "arrive" ? route.arrive : route.depart;
    const routeAt = date.getTime() + routeMinute * 60 * 1000;
    if ((direction < 0 && routeAt > requestedAt) || (direction > 0 && routeAt < requestedAt)) continue;
    const distanceMinutes = Math.abs(routeAt - requestedAt) / 60000;
    const candidate = { date, route, distanceMinutes };
    if (!best || candidate.distanceMinutes < best.distanceMinutes) best = candidate;
    break;
  }

  return best;
}

function renderSuggestionLine(label, suggestion) {
  return `<p>${escapeHtml(label)}: <strong>${formatServiceDate(suggestion.date)} ${formatTime(suggestion.route.depart)}発 → ${formatTime(suggestion.route.arrive)}着</strong>（指定から約${Math.round(suggestion.distanceMinutes)}分）</p>`;
}

function describeServiceWindow(originId, targetId, serviceKey) {
  const startDate = keyToDate(serviceKey);
  const windows = [];
  for (let offset = 0; offset <= 13 && windows.length < 3; offset++) {
    const date = new Date(startDate.getTime() + offset * DAY_MS);
    const key = toServiceKey(date);
    const starts = candidateStartTimes(originId, key);
    const routes = [];
    for (const start of starts) {
      const route = findEarliestRoute(originId, targetId, start, key);
      if (route) routes.push(route);
    }
    if (!routes.length) continue;
    routes.sort((a, b) => a.depart - b.depart);
    windows.push(`${formatServiceDate(date)}は、おおむね${formatTime(routes[0].depart)}発から${formatTime(routes[routes.length - 1].depart)}発まで候補があります`);
  }
  return windows.length ? `規定の運行日時・時間: ${windows.join("。")}。` : "規定の運行日時・時間: この区間では確認できる運行候補がありません。";
}

function findServiceSuggestion(originId, targetId, serviceKey, minute, mode) {
  const startDate = keyToDate(serviceKey);
  const requestedAt = startDate.getTime() + minute * 60 * 1000;
  const before = findNearestRouteAround(originId, targetId, requestedAt, -1, mode);
  const after = findNearestRouteAround(originId, targetId, requestedAt, 1, mode);
  const best = [before, after].filter(Boolean).sort((a, b) => a.distanceMinutes - b.distanceMinutes)[0] || null;
  return { before, after, best, service: describeServiceWindow(originId, targetId, serviceKey) };
}

function renderNoService(fromStop, toStop, serviceKey, minute, mode, suggestion) {
  const label = mode === "arrive" ? "到着" : "出発";
  const requested = `${formatServiceDate(keyToDate(serviceKey))} ${formatTime(minute)} ${label}`;
  const previous = suggestion?.before ? renderSuggestionLine("指定日時より前の近い候補", suggestion.before) : "";
  const next = suggestion?.after ? renderSuggestionLine("指定日時より後の近い候補", suggestion.after) : "";
  const nearest = suggestion?.best ? renderSuggestionLine("最も近い候補", suggestion.best) : "<p>前後14日以内に候補が見つかりませんでした。</p>";
  const service = suggestion?.service ? `<p class="leg-detail">${escapeHtml(suggestion.service)}</p>` : "";
  el.results.innerHTML = `
    <div class="route-card">
      <div class="notice danger">
        <strong>指定日時では運行候補がありません。</strong>
        <p>${escapeHtml(fromStop.name)} から ${escapeHtml(toStop.name)} へ、${requested} で検索しました。</p>
        ${nearest}
        ${previous}
        ${next}
      </div>
      ${service}
      <p class="leg-detail">運休日、始発前、最終便後、または乗継が成立しない時間帯の可能性があります。</p>
    </div>`;
}

function renderRoute(route, fromStop, toStop, requestedMinute, mode) {
  const total = mode === "depart" ? route.arrive - requestedMinute : route.arrive - route.depart;
  const rides = route.legs.filter(leg => leg.type === "ride");
  const transferCount = Math.max(0, rides.length - 1);
  const wait = route.legs.reduce((sum, leg, index) => {
    const prevTime = index === 0 ? (mode === "depart" ? requestedMinute : route.depart) : route.legs[index - 1].arrive;
    return sum + Math.max(0, leg.depart - prevTime);
  }, 0);
  const source = state.lastSource ? ` / ${state.lastSource}` : "";
  const modeNotice = mode === "arrive"
    ? `<div class="notice">指定した到着時刻 ${formatTime(requestedMinute)} までに着く中で、できるだけ遅く出発する候補です。</div>`
    : "";
  el.results.innerHTML = `
    <article class="route-card">
      ${modeNotice}
      <div class="summary">
        <div class="metric"><span>出発</span><strong>${formatTime(route.depart)}</strong></div>
        <div class="metric"><span>到着</span><strong>${formatTime(route.arrive)}</strong></div>
        <div class="metric"><span>総移動時間</span><strong>${total}分</strong></div>
        <div class="metric"><span>乗継回数</span><strong>${transferCount}回</strong></div>
        <div class="metric"><span>待ち時間合計</span><strong>${wait}分</strong></div>
      </div>
      ${route.legs.map((leg, index) => renderLeg(leg, index, route.legs, route.serviceKey)).join("")}
      <p class="leg-detail">データ出典: <a href="${CITY_SOURCE_URL}" target="_blank" rel="noreferrer">沖縄市公式ページ</a>${escapeHtml(source)}。道路状況による遅延は反映していません。</p>
    </article>
  `;
}

function renderLeg(leg, index, legs, serviceKey) {
  const from = state.feed.stopById.get(leg.fromStopId)?.name || leg.fromStopId;
  const to = state.feed.stopById.get(leg.toStopId)?.name || leg.toStopId;
  const prev = legs[index - 1];
  const wait = prev ? Math.max(0, leg.depart - prev.arrive) : 0;
  if (leg.type === "walk") {
    return `
      <div class="leg">
        <div class="leg-time">${formatTime(leg.depart)}</div>
        <div class="leg-body">
          <span class="route-name">徒歩連絡</span>
          <p class="leg-title">${escapeHtml(from)} → ${escapeHtml(to)}</p>
          <p class="leg-detail">乗継指定停留所間の徒歩連絡として${leg.minutes}分で計算しています。</p>
        </div>
      </div>`;
  }
  const transferText = prev ? `<span class="transfer">待ち${wait}分</span> / ` : "";
  const free = index > 0 ? (isFreeTransferStop(from) ? "無料乗継券の対象停留所です。" : "同一停留所での乗継として計算しています。") : "";
  const options = index > 0 ? renderTransferOptions(leg, prev, serviceKey) : "";
  return `
    <div class="leg">
      <div class="leg-time">${formatTime(leg.depart)}<br>${formatTime(leg.arrive)}</div>
      <div class="leg-body">
        <span class="route-name ${routeClass(leg.routeName)}">${escapeHtml(leg.routeName)}</span>
        <p class="leg-title">${escapeHtml(from)} → ${escapeHtml(to)}</p>
        <p class="leg-detail">${transferText}${leg.arrive - leg.depart}分乗車。${escapeHtml(formatHeadsign(leg.headsign))}。${free}</p>
        ${options}
      </div>
    </div>`;
}

function renderTransferOptions(leg, prev, serviceKey) {
  const options = nearbyTransferDepartures(leg.fromStopId, leg.routeId, leg.depart, serviceKey);
  if (!options.length) return "";
  return `
    <details class="transfer-options">
      <summary>この乗継前後の便を確認</summary>
      <div class="option-list">
        ${options.map(option => `
          <div class="option-item">
            <strong>${formatTime(option.depart)}発 → ${formatTime(option.arrive)}着 ${escapeHtml(option.routeName)}</strong>
            <span>${escapeHtml(option.headsign || "")} / ${Math.max(0, option.depart - prev.arrive)}分待ち相当</span>
          </div>`).join("")}
      </div>
    </details>`;
}

function nearbyTransferDepartures(stopId, routeId, departMinute, serviceKey) {
  const deps = (state.graph.departures.get(stopId) || [])
    .filter(dep => dep.routeId === routeId && isServiceActive(dep.serviceId, serviceKey))
    .map(dep => {
      const next = dep.times[dep.stopIndex + 1];
      return {
        depart: dep.depart,
        arrive: next?.arrival ?? dep.depart,
        routeName: dep.routeName,
        headsign: dep.headsign
      };
    })
    .sort((a, b) => a.depart - b.depart);
  const index = deps.findIndex(dep => dep.depart === departMinute);
  if (index < 0) return deps.filter(dep => Math.abs(dep.depart - departMinute) <= 60).slice(0, 5);
  return deps.slice(Math.max(0, index - 2), index + 3);
}

function isServiceActive(serviceId, serviceKey) {
  const service = state.feed.calendars.get(serviceId);
  if (!service) return true;
  const exception = service.exceptions.get(serviceKey);
  if (exception === "1") return true;
  if (exception === "2") return false;
  if (serviceKey < service.start || serviceKey > service.end) return false;
  const date = new Date(`${serviceKey.slice(0, 4)}-${serviceKey.slice(4, 6)}-${serviceKey.slice(6, 8)}T00:00:00`);
  return Boolean(service.days[date.getDay()]);
}

function resolveStop(name) {
  if (state.stopsByName.has(name)) return state.stopsByName.get(name);
  if (state.stopsByName.has(`${name}バス停`)) return state.stopsByName.get(`${name}バス停`);
  const normalized = name.replace(/\s+/g, "");
  const candidates = [...state.stopsByName.entries()].filter(([stopName]) => stopName.replace(/\s+/g, "") === normalized);
  return candidates.length === 1 ? candidates[0][1] : null;
}

function getTimeMode() {
  return document.querySelector('input[name="timeMode"]:checked')?.value || "depart";
}

function updateTimeModeLabel() {
  el.timeLabel.textContent = getTimeMode() === "arrive" ? "到着時刻" : "出発時刻";
}

function routeClass(name) {
  if (name.includes("西部")) return "west";
  if (name.includes("東部")) return "east";
  if (name.includes("北部")) return "north";
  if (name.includes("中部")) return "middle";
  return "";
}

function routeColor(name) {
  if (name.includes("西部")) return "#21a67a";
  if (name.includes("東部")) return "#e85d75";
  if (name.includes("北部")) return "#3867d6";
  if (name.includes("中部")) return "#f4b43f";
  return "#0f7c72";
}

function isFreeTransferStop(name) {
  return FREE_TRANSFER_STOPS.has(name) || WALK_TRANSFER_PAIRS.some(pair => pair.includes(name));
}

function formatHeadsign(headsign) {
  const value = cleanName(headsign || "循環便");
  return value.endsWith("方面") || value.endsWith("行") ? value : `${value}方面`;
}

function shortStopName(name) {
  return name.length > 11 ? `${name.slice(0, 10)}…` : name;
}

function getBounds(stops) {
  return stops.reduce((acc, stop) => ({
    minLat: Math.min(acc.minLat, stop.lat),
    maxLat: Math.max(acc.maxLat, stop.lat),
    minLon: Math.min(acc.minLon, stop.lon),
    maxLon: Math.max(acc.maxLon, stop.lon)
  }), { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity });
}

async function unzipGtfs(buffer) {
  const data = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const files = {};
  let ptr = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("ZIP中央ディレクトリを読めません。");
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const fileNameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decodeUtf8(data.slice(ptr + 46, ptr + 46 + fileNameLength));
    if (name.endsWith(".txt")) files[name.split("/").pop()] = await readZipEntry(data, localOffset, compressedSize, method);
    ptr += 46 + fileNameLength + extraLength + commentLength;
  }
  return files;
}

async function readZipEntry(data, localOffset, compressedSize, method) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIPローカルヘッダを読めません。");
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = data.slice(start, start + compressedSize);
  if (method === 0) return decodeUtf8(compressed);
  if (method !== 8) throw new Error(`未対応のZIP圧縮方式です: ${method}`);
  if (!("DecompressionStream" in window)) throw new Error("このブラウザはZIP展開に必要なDecompressionStreamに対応していません。");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function findEndOfCentralDirectory(data) {
  for (let i = data.length - 22; i >= Math.max(0, data.length - 66000); i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) return i;
  }
  throw new Error("ZIPの終端情報が見つかりません。");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") {
        value += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += ch;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift()?.map(header => header.trim()) || [];
  return rows.filter(cols => cols.length > 1 || cols[0]).map(cols => Object.fromEntries(headers.map((key, index) => [key, cols[index] ?? ""])));
}

function timeToMinutes(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toDateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toTimeInput(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toServiceKey(date) {
  return toDateInput(date).replaceAll("-", "");
}

function keyToDate(key) {
  return new Date(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00`);
}

function formatServiceDate(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}(${weekdays[date.getDay()]})`;
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function setStatus(text, isError) {
  el.status.textContent = text;
  el.status.style.borderColor = isError ? "#e58a8a" : "";
  el.status.style.color = isError ? "#9b2c2c" : "";
}

function showMessage(message) {
  el.results.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}
