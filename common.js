
const COLORS = {
  data: '#4da3ff',
  mirror: '#bf5af2',
  parity: '#ffd60a',
  parity2: '#00d4aa',
  spare: '#00d4aa',
  rebuild: '#30d158',
  failed: '#ff453a'
};

const PACKET_COLORS = ['#64d2ff', '#ffd60a', '#ff9f0a', '#bf5af2', '#30d158', '#ff6b6b', '#4da3ff'];

const stage = document.getElementById('stage');
const topbar = document.querySelector('.topbar');
const subtitleEl = document.querySelector('.topbar .subtitle');
const sourceGrid = document.getElementById('sourceGrid');
const sourceFrame = document.getElementById('sourceFrame');
const restoreFrame = document.getElementById('restoreFrame');
const caption = document.getElementById('caption');
const statusText = document.getElementById('statusText');
const drivesWrap = document.getElementById('drivesWrap');
const dataLost = document.getElementById('dataLost');
const sourceCross = document.getElementById('sourceCross');
let sourceRecoveryLayer = null;
let sourceLossLayer = null;
let sourceWriteLayer = null;

let step = 0;
let busy = false;
let mapping = [];
let driveEls = [];
let groupFrames = [];
let formulaEl = null;
let algorithmBoxEl = null;
let cpuBoxEl = null;
let packetLegendEl = null;
let actionButtonEl = null;
let rebuildButtonEl = null;
let selectedFailures = [];
let selectionMode = false;
let analysisDone = false;
let actionMode = 'hidden';
let rebuildDone = false;
let lastRecoverySucceeded = false;
let adaptRestoreStage = 0;
let adaptRestorePlacements = [];




function ensureCpuBox() {
  if (cpuBoxEl && cpuBoxEl.isConnected) return cpuBoxEl;
  cpuBoxEl = document.createElement('div');
  cpuBoxEl.className = 'cpu-box';
  cpuBoxEl.innerHTML = '<div class="cpu-chip"></div><div class="cpu-labels"><div class="cpu-title">CPU</div><div class="cpu-value" id="cpuValue"></div></div>';
  stage.appendChild(cpuBoxEl);
  return cpuBoxEl;
}

function showCpuBox() {
  const el = ensureCpuBox();
  const value = el.querySelector('#cpuValue');

  el.classList.remove('cpu-low', 'cpu-medium', 'cpu-high');

  if (RAID_CONFIG.cpu_load) {
    el.classList.add('show');
    if (value) value.textContent = RAID_CONFIG.cpu_load;

    const num = parseInt(RAID_CONFIG.cpu_load, 10);
    if (num <= 25) {
      el.classList.add('cpu-low');
    } else if (num <= 50) {
      el.classList.add('cpu-medium');
    } else {
      el.classList.add('cpu-high');
    }
  } else {
    el.classList.remove('show');
    if (value) value.textContent = '';
  }
}

function hideCpuBox() {
  const el = ensureCpuBox();
  el.classList.remove('show');
}

function ensureActionButton() {
  if (actionButtonEl && actionButtonEl.isConnected) return actionButtonEl;
  actionButtonEl = document.createElement('button');
  actionButtonEl.className = 'recover-btn';
  actionButtonEl.type = 'button';
  actionButtonEl.textContent = 'Select drives';
  actionButtonEl.addEventListener('click', () => {
    if (busy) return;
    if (actionMode === 'select') {
      selectionMode = true;
      actionMode = 'recover';
      updateDriveSelectionState();
      updateActionButton();
      updateSubtitle();
      statusText.textContent = `${RAID_CONFIG.name}: click drives to mark them as failed, then click Recover.`;
      return;
    }
    if (actionMode === 'recover') {
      startRecoveryAnalysis();
    }
  });
  topbar?.appendChild(actionButtonEl);
  return actionButtonEl;
}

function ensureRebuildButton() {
  if (rebuildButtonEl && rebuildButtonEl.isConnected) return rebuildButtonEl;
  rebuildButtonEl = document.createElement('button');
  rebuildButtonEl.className = 'recover-btn rebuild-btn hidden';
  rebuildButtonEl.type = 'button';
  rebuildButtonEl.textContent = 'Rebuild drive';
  rebuildButtonEl.addEventListener('click', () => {
    if (busy || !lastRecoverySucceeded || rebuildDone || RAID_CONFIG.type === 'stripe') return;
    startDiskRebuild();
  });
  topbar?.appendChild(rebuildButtonEl);
  return rebuildButtonEl;
}

function getFailedDrives() {
  return [...selectedFailures].sort((a, b) => a - b);
}

function setSelectedFailures(indices) {
  selectedFailures = [...new Set(indices)].sort((a, b) => a - b);
  updateDriveSelectionState();
  updateActionButton();
  updateSubtitle();
}

function toggleFailedDriveSelection(index) {
  if (!selectionMode || busy || analysisDone) return;
  const next = new Set(selectedFailures);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  setSelectedFailures([...next]);
  statusText.textContent = next.size
    ? `${RAID_CONFIG.name}: selected failed drives ${[...next].sort((a, b) => a - b).map(i => String.fromCharCode(65 + i)).join(', ')}. Click Recover to analyze.`
    : `${RAID_CONFIG.name}: select failed drives, then click Recover.`;
}

function updateDriveSelectionState() {
  driveEls.forEach((drive, idx) => {
    if (!drive) return;
    drive.classList.toggle('marked-fail', selectedFailures.includes(idx) && !analysisDone);
  });
}

function updateActionButton() {
  const btn = ensureActionButton();
  btn.classList.toggle('hidden', actionMode === 'hidden');

  if (actionMode === 'select') {
    btn.textContent = 'Select drives';
    btn.disabled = false;
    return;
  }

  if (actionMode === 'recover') {
    btn.textContent = 'Recover';
    btn.disabled = !selectedFailures.length || analysisDone;
    return;
  }

  btn.textContent = 'Recover';
  btn.disabled = true;
}

function updateRebuildButton() {
  const btn = ensureRebuildButton();
  const show = analysisDone && lastRecoverySucceeded && RAID_CONFIG.type !== 'stripe';
  btn.classList.toggle('hidden', !show);
  if (RAID_CONFIG.type === 'adapt') {
    btn.textContent = adaptRestoreStage === 0 ? 'Restore redundancy' : 'Replace drive + rebalance';
  } else {
    btn.textContent = 'Rebuild drive';
  }
  btn.disabled = !show || rebuildDone || busy;
}

function updateSubtitle() {
  if (!subtitleEl) return;
  if (selectionMode || actionMode === 'select' || actionMode === 'recover') {
    subtitleEl.textContent = 'Space = next step | Select drives = choose failures | R = restart';
    return;
  }
  subtitleEl.textContent = 'Space = next step | R = restart';
}

function getFailedDriveLabel(indices) {
  if (!indices.length) return 'none';
  return indices.map(i => String.fromCharCode(65 + i)).join(', ');
}

function getToleranceSummary(failedDrives, canRecover) {
  const count = failedDrives.length;
  const outcome = canRecover ? 'Data can be restored.' : 'Data cannot be restored.';

  if (RAID_CONFIG.type === 'stripe') {
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 0 tolerates 0 failed drives; selected ${count}. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'mirror') {
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 1 can lose all but one mirror copy; selected ${count}/${RAID_CONFIG.drives}. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'stripe-mirror') {
    const group1 = failedDrives.filter(i => i <= 1).length;
    const group2 = failedDrives.filter(i => i >= 2).length;
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 0+1 needs one full mirrored stripe still alive; group A lost ${group1}/2, group B lost ${group2}/2. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'mirror-stripe') {
    const pairA = failedDrives.filter(i => i <= 1).length;
    const pairB = failedDrives.filter(i => i >= 2).length;
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 10 allows up to 1 failed drive per mirror pair; pair A ${pairA}/2, pair B ${pairB}/2. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'parity1') {
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 5 allows 1 failed drive; selected ${count}. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'raid50') {
    const g1 = failedDrives.filter(i => i >= 0 && i <= 2).length;
    const g2 = failedDrives.filter(i => i >= 3 && i <= 5).length;
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 50 allows 1 failed drive per RAID 5 group; group 1 ${g1}/1, group 2 ${g2}/1. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'parity2') {
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 6 allows 2 failed drives; selected ${count}. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'raid60') {
    const g1 = failedDrives.filter(i => i >= 0 && i <= 3).length;
    const g2 = failedDrives.filter(i => i >= 4 && i <= 7).length;
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. RAID 60 allows up to 2 failed drives per RAID 6 group; group 1 ${g1}/2, group 2 ${g2}/2. ${outcome}`;
  }
  if (RAID_CONFIG.type === 'adapt') {
    return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. ADAPT is shown here with N+2 protection, so up to 2 failed drives are recoverable; selected ${count}. ${outcome}`;
  }
  return `${RAID_CONFIG.name}: failed drives ${getFailedDriveLabel(failedDrives)}. ${outcome}`;
}

function analyzeTolerance(failedDrives) {
  const failed = new Set(failedDrives);
  const count = failed.size;

  if (RAID_CONFIG.type === 'stripe') return count === 0;
  if (RAID_CONFIG.type === 'mirror') return failedDrives.length < RAID_CONFIG.drives;
  if (RAID_CONFIG.type === 'stripe-mirror') {
    const group1Alive = !failed.has(0) && !failed.has(1);
    const group2Alive = !failed.has(2) && !failed.has(3);
    return group1Alive || group2Alive;
  }
  if (RAID_CONFIG.type === 'mirror-stripe') {
    return (!failed.has(0) || !failed.has(1)) && (!failed.has(2) || !failed.has(3));
  }
  if (RAID_CONFIG.type === 'parity1') return count <= 1;
  if (RAID_CONFIG.type === 'raid50') {
    const g1 = failedDrives.filter(i => i >= 0 && i <= 2).length;
    const g2 = failedDrives.filter(i => i >= 3 && i <= 5).length;
    return g1 <= 1 && g2 <= 1;
  }
  if (RAID_CONFIG.type === 'parity2') return count <= 2;
  if (RAID_CONFIG.type === 'raid60') {
    const g1 = failedDrives.filter(i => i >= 0 && i <= 3).length;
    const g2 = failedDrives.filter(i => i >= 4 && i <= 7).length;
    return g1 <= 2 && g2 <= 2;
  }
  if (RAID_CONFIG.type === 'adapt') return count <= 2;
  return false;
}

async function startRecoveryAnalysis() {
  if (!selectedFailures.length) {
    statusText.textContent = `${RAID_CONFIG.name}: select at least one failed drive first.`;
    return;
  }

  if (busy) return;
  busy = true;
  analysisDone = true;
  selectionMode = false;
  actionMode = 'done';
  updateDriveSelectionState();
  updateActionButton();
  updateSubtitle();

  const failedDrives = getFailedDrives();
  const canRecover = analyzeTolerance(failedDrives);
  lastRecoverySucceeded = canRecover;
  rebuildDone = false;
  adaptRestoreStage = 0;
  adaptRestorePlacements = [];
  failDrives();
  statusText.textContent = getToleranceSummary(failedDrives, canRecover);
  await animateRecovery(canRecover);
  if (canRecover && RAID_CONFIG.type !== 'stripe') {
    statusText.textContent = `${getToleranceSummary(failedDrives, canRecover)} Click Rebuild drive to simulate replacement-disk rebuild.`;
  }
  busy = false;
  updateRebuildButton();
}

function ensureAlgorithmBox() {
  if (algorithmBoxEl && algorithmBoxEl.isConnected) return algorithmBoxEl;
  algorithmBoxEl = document.createElement('div');
  algorithmBoxEl.className = 'algorithm-box';
  algorithmBoxEl.innerHTML = '<div class="algorithm-copy"><div class="algorithm-kicker" id="algorithmKicker">Compute</div><div class="algorithm-title" id="algorithmTitle">RAID parity algorithm</div><div class="algorithm-formula" id="algorithmFormula"></div><div class="algorithm-flow"><div class="algorithm-node input" id="algorithmInput">Data blocks</div><div class="algorithm-arrow">-></div><div class="algorithm-node output" id="algorithmOutput">Parity blocks</div></div></div>';
  stage.appendChild(algorithmBoxEl);
  return algorithmBoxEl;
}

function showAlgorithmBox() {
  const el = ensureAlgorithmBox();
  const kicker = el.querySelector('#algorithmKicker');
  const title = el.querySelector('#algorithmTitle');
  const formula = el.querySelector('#algorithmFormula');
  const input = el.querySelector('#algorithmInput');
  const output = el.querySelector('#algorithmOutput');
  if (shouldAnimateCalculation()) {
    const copy = getAlgorithmCopy();
    el.classList.add('show');
    el.dataset.mode = RAID_CONFIG.type;
    if (kicker) kicker.textContent = copy.kicker;
    if (title) title.textContent = copy.title;
    if (formula) formula.textContent = RAID_CONFIG.algorithm_formula || copy.formula;
    if (input) input.textContent = copy.input;
    if (output) output.textContent = copy.output;
  } else {
    el.classList.remove('show');
    delete el.dataset.mode;
    if (kicker) kicker.textContent = '';
    if (title) title.textContent = '';
    if (formula) formula.textContent = '';
    if (input) input.textContent = '';
    if (output) output.textContent = '';
  }
}

function hideAlgorithmBox() {
  const el = ensureAlgorithmBox();
  el.classList.remove('show');
}

function shouldAnimateCalculation() {
  return ['parity1', 'parity2', 'raid50', 'raid60', 'adapt'].includes(RAID_CONFIG.type);
}

function getAlgorithmCopy() {
  const copyByType = {
    parity1: {
      kicker: 'Compute',
      title: 'Single-Parity Calculation',
      formula: 'XOR parity is generated before blocks are written',
      input: 'Data stripe',
      output: 'Parity block'
    },
    parity2: {
      kicker: 'Compute',
      title: 'Dual-Parity Calculation',
      formula: 'P and Q parity are generated before blocks are written',
      input: 'Data stripe',
      output: 'P + Q parity'
    },
    raid50: {
      kicker: 'Group Compute',
      title: 'RAID 5 Group Parity',
      formula: 'Parity is calculated inside one RAID 5 group, then striped across groups',
      input: 'Group data',
      output: 'Group parity'
    },
    raid60: {
      kicker: 'Group Compute',
      title: 'RAID 6 Group Parity',
      formula: 'P and Q are calculated inside one RAID 6 group, then striped across groups',
      input: 'Group data',
      output: 'P + Q parity'
    },
    adapt: {
      kicker: 'Distributed Compute',
      title: 'Array-Wide ADAPT Layout',
      formula: 'Parity and shared spare capacity are distributed across the whole array with N+2 protection',
      input: 'Array data',
      output: 'Parity + N+2 spare'
    }
  };

  return copyByType[RAID_CONFIG.type] || {
    kicker: 'Compute',
    title: 'RAID Calculation',
    formula: '',
    input: 'Data',
    output: 'Protected data'
  };
}

function getRebuildAnimationProfile() {
  return {
    copyDuration: RAID_CONFIG.copy_tile_ms || 140,
    tileDuration: RAID_CONFIG.rebuild_tile_ms || 320,
    batchPause: RAID_CONFIG.rebuild_pause_ms || 180
  };
}

async function animateFastCopiedTiles(tileIndices, duration) {
  if (!tileIndices.length) return;

  const animations = tileIndices.map((tileIndex) => {
    const sourceEntry = mapping.find((entry) =>
      entry.tileIndex === tileIndex &&
      !getFailedDrives().includes(entry.drive) &&
      (entry.kind === 'data' || entry.kind === 'mirror')
    );

    if (!sourceEntry) return null;

    const sourceRect = driveEls[sourceEntry.drive].querySelectorAll('.slot')[sourceEntry.targetSlot].getBoundingClientRect();
    const targetFrame = sourceFrame.getBoundingClientRect();
    const size = targetFrame.width / 5;
    const { r, c } = gridPos(tileIndex);
    const targetRect = {
      left: targetFrame.left + c * size,
      top: targetFrame.top + r * size,
      width: size,
      height: size
    };

    const tile = createTileAtRect(tileIndex, 'data', sourceRect);
    tile.classList.add('rebuild-tile');
    return moveTo(tile, targetRect, duration).then(() => {
      fillSourceSlot(tileIndex);
      tile.remove();
    });
  }).filter(Boolean);

  await Promise.all(animations);
}

function createTileAtRect(tileIndex, kind, rect) {
  const tile = createTile(tileIndex, kind);
  tile.style.left = `${rect.left}px`;
  tile.style.top = `${rect.top}px`;
  tile.style.width = `${rect.width}px`;
  tile.style.height = `${rect.height}px`;
  return tile;
}

function getAlgorithmRect() {
  const box = ensureAlgorithmBox().getBoundingClientRect();
  const size = Math.min(box.width, box.height) * 0.55;
  return {
    left: box.left + box.width / 2 - size / 2,
    top: box.top + box.height / 2 - size / 2,
    width: size,
    height: size
  };
}

function getPacketIndex(tileIndex) {
  return Math.floor(tileIndex / 4);
}

function getPacketLabel(tileIndex) {
  const packetIndex = getPacketIndex(tileIndex);
  return `Set ${String.fromCharCode(65 + (packetIndex % 26))}`;
}

function deterministicShuffle(items, seed) {
  const out = [...items];
  let state = seed * 1664525 + 1013904223;

  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

function getPacketColor(tileIndex) {
  return PACKET_COLORS[getPacketIndex(tileIndex) % PACKET_COLORS.length];
}

function getTileBorderColor(tileIndex, kind, rebuilt=false) {
  if (RAID_CONFIG.type === 'adapt' && ['data', 'mirror', 'rebuild'].includes(kind || '')) {
    return getPacketColor(tileIndex);
  }
  if (rebuilt) return COLORS.rebuild;
  return colorFor(kind);
}


function ensureFormulaEl() {
  if (formulaEl && formulaEl.isConnected) return formulaEl;
  formulaEl = document.createElement('div');
  formulaEl.className = 'formula';
  stage.appendChild(formulaEl);
  return formulaEl;
}

function ensurePacketLegend() {
  if (packetLegendEl && packetLegendEl.isConnected) return packetLegendEl;
  packetLegendEl = document.createElement('div');
  packetLegendEl.className = 'packet-legend';
  stage.appendChild(packetLegendEl);
  return packetLegendEl;
}

function updatePacketLegend() {
  const el = ensurePacketLegend();
  stage.classList.toggle('adapt-mode', RAID_CONFIG.type === 'adapt');
  if (RAID_CONFIG.type !== 'adapt') {
    el.classList.remove('show');
    el.innerHTML = '';
    return;
  }

  const packetCount = Math.ceil(25 / 4);
  const items = Array.from({ length: packetCount }, (_, idx) => {
    const tileIndex = idx * 4;
    const color = getPacketColor(tileIndex);
    const label = getPacketLabel(tileIndex);
    return `<span class="packet-legend-item"><i class="packet-legend-swatch" style="border-color:${color}; color:${color}"></i>${label}</span>`;
  }).join('');

  el.innerHTML = `<div class="packet-legend-title">Packet groups</div><div class="packet-legend-items">${items}</div><div class="packet-legend-footer">Dashed empty slots show distributed free capacity used to restore redundancy.</div>`;
  el.classList.add('show');
}

function showFormula() {
  const el = ensureFormulaEl();
  if (RAID_CONFIG.formula) {
    el.textContent = RAID_CONFIG.formula;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

function hideFormula() {
  const el = ensureFormulaEl();
  el.textContent = '';
  el.classList.remove('show');
}

function buildGrid(el) {
  el.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (RAID_CONFIG.type === 'adapt') {
      cell.style.borderColor = getPacketColor(i);
    }
    el.appendChild(cell);
  }
}
buildGrid(sourceGrid);

function gridPos(tileIndex) {
  const r = Math.floor(tileIndex / 5);
  const c = tileIndex % 5;
  return { r, c };
}

function bgPos(tileIndex) {
  const { r, c } = gridPos(tileIndex);
  return { x: `${c * 25}%`, y: `${r * 25}%` };
}




function ensureSourceWriteLayer() {
  if (sourceWriteLayer && sourceWriteLayer.isConnected) return sourceWriteLayer;
  sourceWriteLayer = document.createElement('div');
  sourceWriteLayer.className = 'source-write';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'write-slot';
    cell.dataset.slot = i;
    sourceWriteLayer.appendChild(cell);
  }
  sourceFrame.appendChild(sourceWriteLayer);
  return sourceWriteLayer;
}

function fillSourceWriteLayer() {
  const layer = ensureSourceWriteLayer();
  layer.querySelectorAll('.write-slot').forEach((cell) => {
    cell.className = 'write-slot';
    cell.style.removeProperty('--bgpos-x');
    cell.style.removeProperty('--bgpos-y');
  });
}

function clearSourceWriteLayer() {
  const layer = ensureSourceWriteLayer();
  layer.querySelectorAll('.write-slot').forEach(cell => {
    cell.className = 'write-slot';
    cell.style.removeProperty('--bgpos-x');
    cell.style.removeProperty('--bgpos-y');
  });
}

function clearSourceWriteSlot(tileIndex) {
  const layer = ensureSourceWriteLayer();
  const cell = layer.querySelectorAll('.write-slot')[tileIndex];
  cell.className = 'write-slot hole';
}

function ensureSourceLossLayer() {
  if (sourceLossLayer && sourceLossLayer.isConnected) return sourceLossLayer;
  sourceLossLayer = document.createElement('div');
  sourceLossLayer.className = 'source-loss';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'loss-slot';
    cell.dataset.slot = i;
    sourceLossLayer.appendChild(cell);
  }
  sourceFrame.appendChild(sourceLossLayer);
  return sourceLossLayer;
}

function clearSourceLossLayer() {
  const layer = ensureSourceLossLayer();
  layer.classList.remove('blurred');
  layer.querySelectorAll('.loss-slot').forEach(cell => {
    cell.className = 'loss-slot';
    cell.innerHTML = '';
    cell.style.removeProperty('--bgpos-x');
    cell.style.removeProperty('--bgpos-y');
  });
}

function fillLossSlot(tileIndex) {
  const layer = ensureSourceLossLayer();
  const cell = layer.querySelectorAll('.loss-slot')[tileIndex];
  const pos = bgPos(tileIndex);
  cell.classList.add('filled');
  cell.style.setProperty('--bgpos-x', pos.x);
  cell.style.setProperty('--bgpos-y', pos.y);
}

function getLossVisibleTileIndices() {
  const failedDrives = getFailedDrives();
  const failed = new Set(failedDrives);

  if (RAID_CONFIG.type === 'stripe-mirror') {
    const visible = new Set();
    const stripeGroups = [
      { drives: [0, 1] },
      { drives: [2, 3] }
    ];

    stripeGroups.forEach((group) => {
      const intact = group.drives.every((drive) => !failed.has(drive));
      if (!intact) return;
      mapping.forEach((entry) => {
        if (group.drives.includes(entry.drive) && (entry.kind === 'data' || entry.kind === 'mirror')) {
          visible.add(entry.tileIndex);
        }
      });
    });

    return [...visible].sort((a, b) => a - b);
  }

  if (RAID_CONFIG.type === 'mirror-stripe') {
    const visible = new Set();
    const mirrorPairs = [
      [0, 1],
      [2, 3]
    ];

    mirrorPairs.forEach((pair) => {
      const pairAlive = pair.some((drive) => !failed.has(drive));
      if (!pairAlive) return;
      mapping.forEach((entry) => {
        if (pair.includes(entry.drive) && (entry.kind === 'data' || entry.kind === 'mirror')) {
          visible.add(entry.tileIndex);
        }
      });
    });

    return [...visible].sort((a, b) => a - b);
  }

  return getVisibleSourceTileIndices();
}

function showLostTilesFromSurvivors() {
  clearSourceLossLayer();
  const layer = ensureSourceLossLayer();
  layer.classList.toggle('blurred', RAID_CONFIG.type !== 'adapt');
  getLossVisibleTileIndices().forEach(fillLossSlot);
}

function ensureSourceRecoveryLayer() {
  if (sourceRecoveryLayer && sourceRecoveryLayer.isConnected) return sourceRecoveryLayer;
  sourceRecoveryLayer = document.createElement('div');
  sourceRecoveryLayer.className = 'source-recovery';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'src-slot';
    cell.dataset.slot = i;
    sourceRecoveryLayer.appendChild(cell);
  }
  sourceFrame.appendChild(sourceRecoveryLayer);
  return sourceRecoveryLayer;
}

function clearSourceRecoveryLayer() {
  const layer = ensureSourceRecoveryLayer();
  layer.querySelectorAll('.src-slot').forEach(cell => {
    cell.className = 'src-slot';
    cell.innerHTML = '';
    cell.style.removeProperty('--bgpos-x');
    cell.style.removeProperty('--bgpos-y');
  });
}

function fillSourceSlot(tileIndex) {
  const layer = ensureSourceRecoveryLayer();
  const cell = layer.querySelectorAll('.src-slot')[tileIndex];
  const pos = bgPos(tileIndex);
  cell.classList.add('filled');
  cell.style.setProperty('--bgpos-x', pos.x);
  cell.style.setProperty('--bgpos-y', pos.y);
  cell.innerHTML = `<div class="outline" style="border-color:${getTileBorderColor(tileIndex, 'rebuild', true)}"></div>${getPacketBadgeMarkup(tileIndex)}`;
}

function getPacketBadgeMarkup(tileIndex) {
  if (RAID_CONFIG.type !== 'adapt') return '';
  return `<div class="packet-badge" style="border-color:${getPacketColor(tileIndex)}; color:${getPacketColor(tileIndex)}">${getPacketLabel(tileIndex)}</div>`;
}

function getDriveColumns(driveCount) {
  if (driveCount >= 8) return 4;
  if (driveCount >= 5) return 3;
  return driveCount;
}

function shouldUseFullImageRebuild() {
  if (
    RAID_CONFIG.type === 'mirror' ||
    RAID_CONFIG.type === 'stripe-mirror' ||
    RAID_CONFIG.type === 'mirror-stripe'
  ) {
    return true;
  }

  return false;
}

function getRecoveryTileIndices() {
  if (shouldUseFullImageRebuild()) {
    return Array.from({ length: 25 }, (_, i) => i);
  }

  const failedDrives = getFailedDrives();
  const failed = new Set(failedDrives);
  const recoverableKinds = new Set(['data', 'mirror']);
  const affected = new Set();

  mapping.forEach((entry) => {
    if (failed.has(entry.drive) && recoverableKinds.has(entry.kind)) {
      affected.add(entry.tileIndex);
    }
  });

  return [...affected].sort((a, b) => a - b);
}

function getFailedDriveEntries() {
  const failed = new Set(getFailedDrives());
  return mapping
    .filter((entry) => failed.has(entry.drive))
    .sort((a, b) => {
      if (a.drive !== b.drive) return a.drive - b.drive;
      if (a.targetSlot !== b.targetSlot) return a.targetSlot - b.targetSlot;
      return a.tileIndex - b.tileIndex;
    });
}

function getVisibleSourceTileIndices() {
  const failedDrives = getFailedDrives();
  const failed = new Set(failedDrives);
  const visibleKinds = new Set(['data', 'mirror']);
  const visible = new Set();

  mapping.forEach((entry) => {
    if (!failed.has(entry.drive) && visibleKinds.has(entry.kind)) {
      visible.add(entry.tileIndex);
    }
  });

  return [...visible].sort((a, b) => a - b);
}

function buildDrives() {
  drivesWrap.innerHTML = '';
  const cols = getDriveColumns(RAID_CONFIG.drives);
  const rows = Math.ceil(RAID_CONFIG.drives / cols);
  drivesWrap.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  drivesWrap.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  drivesWrap.classList.toggle('compact', RAID_CONFIG.drives >= 8);
  driveEls = [];

  const displayOrder = Array.from({ length: RAID_CONFIG.drives }, (_, i) => i);

  displayOrder.forEach((driveIndex) => {
    const drive = document.createElement('div');
    drive.className = 'drive show';
    drive.dataset.drive = driveIndex;
    drive.innerHTML = `<div class="drive-title">Drive ${String.fromCharCode(65+driveIndex)}</div><div class="slots"></div><div class="cross"></div><div class="replace-badge" title="Disk replacement">♻</div>`;
    drive.addEventListener('click', () => toggleFailedDriveSelection(driveIndex));
    const slots = drive.querySelector('.slots');
    for (let s = 0; s < 25; s++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = s;
      slots.appendChild(slot);
    }
    drivesWrap.appendChild(drive);
    driveEls[driveIndex] = drive;
  });

  mapping = buildMapping();
  updateGroupedRaidFrames();
  markAdaptReserveSlots();
}

function setReplacementBadge(driveIndex, show) {
  const drive = driveEls[driveIndex];
  if (!drive) return;
  const badge = drive.querySelector('.replace-badge');
  if (!badge) return;
  badge.classList.toggle('show', show);
}


function clearGroupFrames() {
  groupFrames.forEach(el => el.remove());
  groupFrames = [];
}

function createGroupFrame(startDrive, endDrive, extraClass='group-ok', layerClass='group-inner', label='') {
  if (!driveEls[startDrive] || !driveEls[endDrive]) return null;
  const wrapRect = drivesWrap.getBoundingClientRect();
  const a = driveEls[startDrive].getBoundingClientRect();
  const b = driveEls[endDrive].getBoundingClientRect();
  const frame = document.createElement('div');
  frame.className = `group-frame ${extraClass} ${layerClass}`;
  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'group-label';
    labelEl.textContent = label;
    frame.appendChild(labelEl);
  }
  frame.style.left = `${Math.min(a.left, b.left) - wrapRect.left - 6}px`;
  frame.style.top = `${Math.min(a.top, b.top) - wrapRect.top - 6}px`;
  frame.style.width = `${Math.max(a.right, b.right) - Math.min(a.left, b.left) + 12}px`;
  frame.style.height = `${Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) + 12}px`;
  drivesWrap.appendChild(frame);
  groupFrames.push(frame);
  return frame;
}

function updateGroupedRaidFrames() {
  clearGroupFrames();

  if (RAID_CONFIG.type === 'stripe-mirror') {
    createGroupFrame(0, 1, 'group-ok', 'group-inner', 'RAID 0 Set 1');
    createGroupFrame(2, 3, 'group-ok', 'group-inner', 'RAID 0 Set 2');
    return;
  }

  if (RAID_CONFIG.type === 'mirror-stripe') {
    createGroupFrame(0, 3, 'group-survivor', 'group-outer', 'RAID 0 Across Mirror Pairs');
    createGroupFrame(0, 1, 'group-survivor', 'group-inner', 'Mirror Pair 1');
    createGroupFrame(2, 3, 'group-survivor', 'group-inner', 'Mirror Pair 2');
    return;
  }

  if (RAID_CONFIG.type === 'raid50') {
    createGroupFrame(0, 2, 'group-ok', 'group-inner', 'RAID 5 Group 1');
    createGroupFrame(3, 5, 'group-ok', 'group-inner', 'RAID 5 Group 2');
    return;
  }

  if (RAID_CONFIG.type === 'raid60') {
    createGroupFrame(0, 3, 'group-ok', 'group-inner', 'RAID 6 Group 1');
    createGroupFrame(4, 7, 'group-ok', 'group-inner', 'RAID 6 Group 2');
    return;
  }
}

function makeEntry(tileIndex, drive, kind, label, targetSlot) {
  return { tileIndex, drive, kind, label, targetSlot };
}

function buildMapping() {
  const out = [];
  const n = 25;
  const type = RAID_CONFIG.type;
  const driveCount = type === 'adapt' ? Math.max(RAID_CONFIG.drives, 12) : RAID_CONFIG.drives;

  if (type === 'stripe') {
    for (let i = 0; i < n; i++) out.push(makeEntry(i, i % RAID_CONFIG.drives, 'data', `D${i+1}`, i));
  } else if (type === 'mirror') {
    for (let i = 0; i < n; i++) {
      out.push(makeEntry(i, 0, 'data', `D${i+1}`, i));
      out.push(makeEntry(i, 1, 'mirror', `D${i+1}`, i));
    }
  } else if (type === 'stripe-mirror') {
    for (let i = 0; i < n; i++) {
      const d = i % 2;
      out.push(makeEntry(i, d, 'data', `D${i+1}`, i));
      out.push(makeEntry(i, d + 2, 'mirror', `D${i+1}`, i));
    }
  } else if (type === 'mirror-stripe') {
    for (let i = 0; i < n; i++) {
      const pair = i % 2 === 0 ? [0,1] : [2,3];
      out.push(makeEntry(i, pair[0], 'data', `D${i+1}`, i));
      out.push(makeEntry(i, pair[1], 'mirror', `D${i+1}`, i));
    }
  } else if (type === 'parity1') {
    const dcount = RAID_CONFIG.drives;
    for (let i = 0; i < n; i++) {
      const parityDrive = i % dcount;
      let used = 0;
      for (let d = 0; d < dcount; d++) {
        if (d === parityDrive) out.push(makeEntry(i, d, 'parity', `P${i+1}`, i));
        else out.push(makeEntry(i, d, 'data', `D${i+1}.${++used}`, i));
      }
    }
  } else if (type === 'raid50') {
    for (let i = 0; i < n; i++) {
      const group = i % 2;
      const base = group * 3;
      const parityDrive = Math.floor(i / 2) % 3;
      let used = 0;
      for (let local = 0; local < 3; local++) {
        const d = base + local;
        if (local === parityDrive) out.push(makeEntry(i, d, 'parity', `P${i+1}`, i));
        else out.push(makeEntry(i, d, 'data', `D${i+1}.${++used}`, i));
      }
    }
  } else if (type === 'parity2') {
    const dcount = RAID_CONFIG.drives;
    for (let i = 0; i < n; i++) {
      const p = i % dcount;
      const q = (i + 1) % dcount;
      let used = 0;
      for (let d = 0; d < dcount; d++) {
        if (d === p) out.push(makeEntry(i, d, 'parity', `P${i+1}`, i));
        else if (d === q) out.push(makeEntry(i, d, 'parity2', `Q${i+1}`, i));
        else out.push(makeEntry(i, d, 'data', `D${i+1}.${++used}`, i));
      }
    }
  } else if (type === 'raid60') {
    for (let i = 0; i < n; i++) {
      const group = i % 2;
      const base = group * 4;
      const p = Math.floor(i / 2) % 4;
      const q = (p + 1) % 4;
      let used = 0;
      for (let local = 0; local < 4; local++) {
        const d = base + local;
        if (local === p) out.push(makeEntry(i, d, 'parity', `P${i+1}`, i));
        else if (local === q) out.push(makeEntry(i, d, 'parity2', `Q${i+1}`, i));
        else out.push(makeEntry(i, d, 'data', `D${i+1}.${++used}`, i));
      }
    }
  } else if (type === 'adapt') {
    const driveIds = Array.from({ length: driveCount }, (_, d) => d);
    const slotOrders = driveIds.map((drive) => deterministicShuffle(Array.from({ length: 25 }, (_, slot) => slot), 500 + drive));
    const slotUsage = Array(driveCount).fill(0);
    const pickLeastLoadedDrive = (candidates, usedDrives, seed) => {
      const available = candidates.filter((drive) => !usedDrives.has(drive));
      const shuffled = deterministicShuffle(available, seed);
      const shuffledOrder = new Map(shuffled.map((drive, index) => [drive, index]));
      const ranked = [...shuffled].sort((a, b) => {
        if (slotUsage[a] !== slotUsage[b]) return slotUsage[a] - slotUsage[b];
        return shuffledOrder.get(a) - shuffledOrder.get(b);
      });
      return ranked[0];
    };

    for (let i = 0; i < n; i++) {
      const packetIndex = getPacketIndex(i);
      const baseStart = (packetIndex * 3 + i) % driveCount;
      const ring = Array.from({ length: driveCount }, (_, offset) => driveIds[(baseStart + offset) % driveCount]);
      const preferred = deterministicShuffle(ring.slice(0, 8), 1000 + packetIndex + i);
      const fallback = deterministicShuffle(ring.slice(8), 2000 + packetIndex + i);
      const candidates = [...preferred, ...fallback];
      const usedDrives = new Set();

      const dataDrive = pickLeastLoadedDrive(candidates, usedDrives, 3000 + i);
      usedDrives.add(dataDrive);
      const parityDrive = pickLeastLoadedDrive(candidates, usedDrives, 4000 + i);
      usedDrives.add(parityDrive);
      const spareDrive = pickLeastLoadedDrive(candidates, usedDrives, 5000 + i);

      const dataSlot = slotOrders[dataDrive][slotUsage[dataDrive]++];
      const paritySlot = slotOrders[parityDrive][slotUsage[parityDrive]++];
      const spareSlot = slotOrders[spareDrive][slotUsage[spareDrive]++];

      out.push(makeEntry(i, dataDrive, 'data', `D${i+1}`, dataSlot));
      out.push(makeEntry(i, parityDrive, 'parity', `P${i+1}`, paritySlot));
      out.push(makeEntry(i, spareDrive, 'spare', `S${i+1}`, spareSlot));
    }
  }
  return out;
}

function colorFor(kind) { return COLORS[kind] || COLORS.data; }

function createTile(tileIndex, kind='data') {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const sourceRect = sourceFrame.getBoundingClientRect();
  const size = sourceRect.width / 5;
  const { r, c } = gridPos(tileIndex);

  tile.style.width = `${size}px`;
  tile.style.height = `${size}px`;
  tile.style.left = `${sourceRect.left + c * size}px`;
  tile.style.top = `${sourceRect.top + r * size}px`;

  const pos = bgPos(tileIndex);
  tile.style.backgroundPosition = `${pos.x} ${pos.y}`;
  tile.innerHTML = `<div class="outline" style="border-color:${getTileBorderColor(tileIndex, kind)}"></div>`;
  stage.appendChild(tile);
  return tile;
}

function moveTo(el, rect, duration=700) {
  return new Promise(resolve => {
    const start = el.getBoundingClientRect();
    const dx = rect.left - start.left;
    const dy = rect.top - start.top;
    const sx = rect.width / start.width;
    const sy = rect.height / start.height;
    el.style.transition = `transform ${duration}ms ease, opacity 200ms ease`;
    requestAnimationFrame(() => {
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    });
    setTimeout(resolve, duration + 20);
  });
}

function fillSlot(entry, rebuilt=false) {
  const slot = driveEls[entry.drive].querySelectorAll('.slot')[entry.targetSlot];
  const pos = bgPos(entry.tileIndex);
  slot.classList.remove('reserve', 'reserve-hot');
  slot.classList.add('filled');
  slot.style.setProperty('--bgpos-x', pos.x);
  slot.style.setProperty('--bgpos-y', pos.y);
  slot.innerHTML = `<div class="outline" style="border-color:${getTileBorderColor(entry.tileIndex, entry.kind, rebuilt)}"></div><div class="label">${entry.label}</div>${getPacketBadgeMarkup(entry.tileIndex)}`;
}

function clearDriveSlots(driveIndex) {
  const drive = driveEls[driveIndex];
  if (!drive) return;
  drive.querySelectorAll('.slot').forEach((slot) => {
    slot.className = 'slot';
    slot.style.removeProperty('--bgpos-x');
    slot.style.removeProperty('--bgpos-y');
    slot.innerHTML = '';
  });
}

function clearSingleSlot(driveIndex, targetSlot) {
  const drive = driveEls[driveIndex];
  if (!drive) return;
  const slot = drive.querySelectorAll('.slot')[targetSlot];
  if (!slot) return;
  slot.className = 'slot';
  slot.style.removeProperty('--bgpos-x');
  slot.style.removeProperty('--bgpos-y');
  slot.innerHTML = '';
}

function setCurrentRebuildSlot(driveIndex, targetSlot, active) {
  const drive = driveEls[driveIndex];
  if (!drive) return;
  const slot = drive.querySelectorAll('.slot')[targetSlot];
  if (!slot) return;
  slot.classList.toggle('current-rebuild', active);
}

function markReserveSlot(driveIndex, targetSlot, hot = false) {
  const drive = driveEls[driveIndex];
  if (!drive) return;
  const slot = drive.querySelectorAll('.slot')[targetSlot];
  if (!slot || slot.classList.contains('filled')) return;
  slot.classList.add('reserve');
  slot.classList.toggle('reserve-hot', hot);
}

function markAdaptReserveSlots() {
  if (RAID_CONFIG.type !== 'adapt') return;
  const usedByDrive = Array.from({ length: RAID_CONFIG.drives }, () => new Set());
  mapping.forEach((entry) => {
    if (usedByDrive[entry.drive]) usedByDrive[entry.drive].add(entry.targetSlot);
  });

  driveEls.forEach((drive, driveIndex) => {
    const used = usedByDrive[driveIndex] || new Set();
    const freeSlots = Array.from({ length: 25 }, (_, slotIndex) => slotIndex).filter((slotIndex) => !used.has(slotIndex));
    freeSlots.slice(0, 3).forEach((slotIndex) => {
      const slot = drive.querySelectorAll('.slot')[slotIndex];
      if (!slot.classList.contains('filled')) slot.classList.add('reserve');
    });
  });
}

function clearReserveHighlights() {
  driveEls.forEach((drive) => {
    if (!drive) return;
    drive.querySelectorAll('.slot').forEach((slot) => slot.classList.remove('reserve-hot'));
  });
}

function getAdaptReserveTargets(count, excludedDrives = []) {
  const excluded = new Set(excludedDrives);
  const reserveByDrive = [];
  const restByDrive = [];

  driveEls.forEach((drive, driveIndex) => {
    if (excluded.has(driveIndex)) return;
    const reserveSlots = [];
    const restSlots = [];
    drive.querySelectorAll('.slot').forEach((slot, slotIndex) => {
      if (slot.classList.contains('filled')) return;
      const candidate = { drive: driveIndex, targetSlot: slotIndex };
      if (slot.classList.contains('reserve')) reserveSlots.push(candidate);
      else restSlots.push(candidate);
    });
    if (reserveSlots.length) reserveByDrive.push(reserveSlots);
    if (restSlots.length) restByDrive.push(restSlots);
  });

  const result = [];
  const takeRoundRobin = (buckets) => {
    let added = true;
    while (result.length < count && added) {
      added = false;
      for (const bucket of buckets) {
        if (!bucket.length || result.length >= count) continue;
        result.push(bucket.shift());
        added = true;
      }
    }
  };

  takeRoundRobin(reserveByDrive);
  if (result.length < count) takeRoundRobin(restByDrive);
  return result;
}

async function animateDriveWipe(driveIndices, duration = 520) {
  if (!driveIndices.length) return;
  const unique = [...new Set(driveIndices)];
  unique.forEach((driveIndex) => {
    const drive = driveEls[driveIndex];
    if (!drive) return;
    drive.classList.add('wiping');
  });
  await new Promise((resolve) => setTimeout(resolve, duration));
  unique.forEach((driveIndex) => {
    clearDriveSlots(driveIndex);
    const drive = driveEls[driveIndex];
    if (!drive) return;
    drive.classList.remove('wiping');
  });
}

async function animateWrite() {
  sourceFrame.style.opacity = '1';
  const sourceImgEl = sourceFrame.querySelector('.source-img');
  if (sourceImgEl) sourceImgEl.style.opacity = '1';

  clearSourceRecoveryLayer();
  clearSourceLossLayer();
  clearSourceWriteLayer();
  fillSourceWriteLayer();
  hideAlgorithmBox();

  const grouped = mapping.reduce((acc, e) => {
    (acc[e.tileIndex] ||= []).push(e);
    return acc;
  }, {});
  const tileIndices = Object.keys(grouped).map(Number).sort((a, b) => a - b);
  const animatedCount = Math.min(10, tileIndices.length);

  async function animateWriteTile(tileIndex, durations) {
    const entries = grouped[tileIndex];
    clearSourceWriteSlot(tileIndex);

    if (shouldAnimateCalculation()) {
      showAlgorithmBox();
      const algRect = getAlgorithmRect();
      const input = createTile(tileIndex, 'data');
      await moveTo(input, algRect, durations.input);
      input.remove();

      const outputs = entries.map(e => ({ entry: e, node: createTileAtRect(tileIndex, e.kind, algRect) }));
      await Promise.all(outputs.map(({ entry, node }) => {
        const target = driveEls[entry.drive].querySelectorAll('.slot')[entry.targetSlot].getBoundingClientRect();
        return moveTo(node, target, durations.output);
      }));
      outputs.forEach(({ entry, node }) => {
        fillSlot(entry);
        node.remove();
      });
      return;
    }

    const tiles = entries.map(e => ({ entry: e, node: createTile(tileIndex, e.kind) }));
    await Promise.all(tiles.map(({ entry, node }) => {
      const target = driveEls[entry.drive].querySelectorAll('.slot')[entry.targetSlot].getBoundingClientRect();
      return moveTo(node, target, durations.output);
    }));
    tiles.forEach(({ entry, node }) => {
      fillSlot(entry);
      node.remove();
    });
  }

  for (let idx = 0; idx < animatedCount; idx++) {
    await animateWriteTile(tileIndices[idx], { input: 380, output: shouldAnimateCalculation() ? 420 : 650 });
  }

  const remaining = tileIndices.slice(animatedCount);
  if (remaining.length) {
    const fastDurations = shouldAnimateCalculation()
      ? { input: 120, output: 150 }
      : { input: 0, output: 180 };
    for (const tileIndex of remaining) {
      await animateWriteTile(tileIndex, fastDurations);
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  hideAlgorithmBox();
  sourceFrame.style.opacity = '0';
  if (sourceImgEl) sourceImgEl.style.opacity = '1';
  clearSourceWriteLayer();
}

function failDrives() {
  const failedDrives = getFailedDrives();
  if (RAID_CONFIG.type === 'stripe-mirror') {
    failedDrives.forEach((failedIndex) => {
      const offlineIndex = failedIndex < 2 ? (failedIndex === 0 ? 1 : 0) : (failedIndex === 2 ? 3 : 2);
      if (driveEls[failedIndex]) {
        driveEls[failedIndex].classList.add('failed');
        driveEls[failedIndex].querySelector('.cross').classList.add('show');
        setReplacementBadge(failedIndex, true);
      }
      if (driveEls[offlineIndex]) {
        driveEls[offlineIndex].classList.add('offline');
        driveEls[offlineIndex].querySelector('.cross').classList.add('show');
      }
    });
    return;
  }

  if (RAID_CONFIG.type === 'mirror-stripe') {
    failedDrives.forEach((failedIndex) => {
      if (driveEls[failedIndex]) {
        driveEls[failedIndex].classList.add('failed');
        driveEls[failedIndex].querySelector('.cross').classList.add('show');
        setReplacementBadge(failedIndex, true);
      }
    });
    // keep RAID 1 pair frames and outer RAID 0 frame green here
    if (groupFrames.length >= 3) {
      groupFrames[0].className = 'group-frame group-survivor group-outer';
      groupFrames[1].className = 'group-frame group-survivor group-inner';
      groupFrames[2].className = 'group-frame group-survivor group-inner';
    }
    return;
  }

  if (RAID_CONFIG.type === 'raid50') {
    failedDrives.forEach(i => {
      if (driveEls[i]) {
        driveEls[i].classList.add('failed');
        driveEls[i].querySelector('.cross').classList.add('show');
        setReplacementBadge(i, true);
      }
    });
    if (groupFrames[0] && groupFrames[1]) {
      const g1fail = failedDrives.some(i => i >= 0 && i <= 2);
      const g2fail = failedDrives.some(i => i >= 3 && i <= 5);
      groupFrames[0].className = 'group-frame ' + (g1fail ? 'group-survivor group-inner' : 'group-ok group-inner');
      groupFrames[1].className = 'group-frame ' + (g2fail ? 'group-survivor group-inner' : 'group-ok group-inner');
    }
    driveEls.forEach((d, idx) => {
      if (!failedDrives.includes(idx)) d.classList.add('rebuild');
    });
    return;
  }

  if (RAID_CONFIG.type === 'raid60') {
    failedDrives.forEach(i => {
      if (driveEls[i]) {
        driveEls[i].classList.add('failed');
        driveEls[i].querySelector('.cross').classList.add('show');
        setReplacementBadge(i, true);
      }
    });
    if (groupFrames[0] && groupFrames[1]) {
      const g1fail = failedDrives.some(i => i >= 0 && i <= 3);
      const g2fail = failedDrives.some(i => i >= 4 && i <= 7);
      groupFrames[0].className = 'group-frame ' + (g1fail ? 'group-survivor group-inner' : 'group-ok group-inner');
      groupFrames[1].className = 'group-frame ' + (g2fail ? 'group-survivor group-inner' : 'group-ok group-inner');
    }
    driveEls.forEach((d, idx) => {
      if (!failedDrives.includes(idx)) d.classList.add('rebuild');
    });
    return;
  }

  failedDrives.forEach(i => {
    if (driveEls[i]) {
      driveEls[i].classList.add('failed');
      driveEls[i].querySelector('.cross').classList.add('show');
      setReplacementBadge(i, true);
    }
  });
}

async function animateRecovery(canRecover) {
  const failedDrives = getFailedDrives();
  if (!canRecover) {
    restoreFrame.classList.remove('show');
    sourceFrame.style.opacity = '1';
    const sourceImgEl = sourceFrame.querySelector('.source-img');
    if (sourceImgEl) sourceImgEl.style.opacity = '0';
    clearSourceRecoveryLayer();
    showLostTilesFromSurvivors();
    dataLost.classList.add('show');
    if (sourceCross) sourceCross.classList.add('show');
    driveEls.forEach((drive) => {
      if (!drive) return;
      drive.classList.remove('rebuild', 'rebuilt');
      drive.classList.add('offline');
      const cross = drive.querySelector('.cross');
      if (cross) cross.classList.add('show');
    });
    failedDrives.forEach((driveIndex) => setReplacementBadge(driveIndex, true));
    if (groupFrames && groupFrames.length) {
      groupFrames.forEach((frame) => {
        const layerClass = frame.classList.contains('group-outer') ? 'group-outer' : 'group-inner';
        frame.className = `group-frame group-failed ${layerClass}`;
      });
    }
    caption.textContent = RAID_CONFIG.result;
    return;
  }

  const usableDrive = driveEls.find((_, idx) => !failedDrives.includes(idx));
  if (usableDrive) usableDrive.classList.add('rebuild');

  restoreFrame.classList.add('show');
  dataLost.classList.remove('show');
  if (sourceCross) sourceCross.classList.remove('show');
  sourceFrame.style.opacity = '1';

  const sourceImgEl = sourceFrame.querySelector('.source-img');
  if (sourceImgEl) sourceImgEl.style.opacity = '0';

  clearSourceWriteLayer();
  clearSourceLossLayer();
  clearSourceRecoveryLayer();
  hideAlgorithmBox();

  let stripeMirrorPoolRect = null;
  if (RAID_CONFIG.type === 'stripe-mirror' && groupFrames.length) {
    const failedIndex = failedDrives[0];
    const failedGroup = failedIndex < 2 ? [0, 1] : [2, 3];
    const survivorFrame = failedIndex < 2 ? groupFrames[1] : groupFrames[0];
    const offlineIndex = failedGroup.find((driveIndex) => driveIndex !== failedIndex);

    if (driveEls[failedIndex]) {
      driveEls[failedIndex].classList.add('failed');
      driveEls[failedIndex].querySelector('.cross').classList.add('show');
      setReplacementBadge(failedIndex, true);
    }
    if (driveEls[offlineIndex]) {
      driveEls[offlineIndex].classList.add('offline');
      driveEls[offlineIndex].querySelector('.cross').classList.add('show');
    }
    [0,1].includes(failedIndex) ? groupFrames[0].className = 'group-frame group-failed' : groupFrames[1].className = 'group-frame group-failed';
    [0,1].includes(failedIndex) ? groupFrames[1].className = 'group-frame group-survivor' : groupFrames[0].className = 'group-frame group-survivor';

    stripeMirrorPoolRect = survivorFrame.getBoundingClientRect();
  } else if (RAID_CONFIG.type === 'mirror-stripe' && groupFrames.length) {
    const failedIndex = failedDrives[0];

    groupFrames[0].className = 'group-frame group-survivor group-outer';
    groupFrames[1].className = 'group-frame group-survivor group-inner';
    groupFrames[2].className = 'group-frame group-survivor group-inner';

    driveEls.forEach((d, idx) => {
      if (idx !== failedIndex) d.classList.add('rebuild');
    });

    const partnerIndex = failedIndex <= 1 ? (failedIndex === 0 ? 1 : 0) : (failedIndex === 2 ? 3 : 2);
    const partnerDrive = driveEls[partnerIndex];
    stripeMirrorPoolRect = null;
    if (partnerDrive) {
      const partnerRect = partnerDrive.getBoundingClientRect();
      stripeMirrorPoolRect = partnerRect;
    }
  } else if (RAID_CONFIG.type === 'raid50' && groupFrames.length) {
    const survivorFrame = failedDrives.some(i => i >= 0 && i <= 2) ? groupFrames[1] : groupFrames[0];
    stripeMirrorPoolRect = survivorFrame.getBoundingClientRect();
  } else if (RAID_CONFIG.type === 'raid60' && groupFrames.length) {
    const survivorFrame = failedDrives.some(i => i >= 0 && i <= 3) ? groupFrames[1] : groupFrames[0];
    stripeMirrorPoolRect = survivorFrame.getBoundingClientRect();
  }

  const tileOrder = getRecoveryTileIndices();
  const visibleTileOrder = getVisibleSourceTileIndices();
  const profile = getRebuildAnimationProfile();
  const copiedTileOrder = visibleTileOrder.filter((tileIndex) => !tileOrder.includes(tileIndex));
  const useFullImageRebuild = shouldUseFullImageRebuild();

  if (RAID_CONFIG.type === 'adapt') {
    await animateFastCopiedTiles(copiedTileOrder, profile.copyDuration);
  } else if (!useFullImageRebuild) {
    await animateFastCopiedTiles(copiedTileOrder, Math.max(180, Math.round(profile.tileDuration * 0.55)));
  }

  const animatedCount = useFullImageRebuild
    ? tileOrder.length
    : Math.min(10, tileOrder.length);

  async function animateRecoveryTile(i, duration, calcInputDuration) {
    const sourceRect = sourceFrame.getBoundingClientRect();
    const size = sourceRect.width / 5;
    const { r, c } = gridPos(i);
    const target = {
      left: sourceRect.left + c * size,
      top: sourceRect.top + r * size,
      width: size,
      height: size
    };

    if (shouldAnimateCalculation()) {
      showAlgorithmBox();
      const algRect = getAlgorithmRect();
      const stripeEntries = mapping.filter(entry => entry.tileIndex === i && !failedDrives.includes(entry.drive));
      const inputs = stripeEntries.map(entry => {
        const rect = driveEls[entry.drive].querySelectorAll('.slot')[entry.targetSlot].getBoundingClientRect();
        return { entry, node: createTileAtRect(i, entry.kind, rect) };
      });

      await Promise.all(inputs.map(({ node }) => moveTo(node, algRect, calcInputDuration)));
      inputs.forEach(({ node }) => node.remove());

      const outTile = createTileAtRect(i, 'rebuild', algRect);
      outTile.classList.add('rebuild-tile');
      await moveTo(outTile, target, duration);
      fillSourceSlot(i);
      outTile.remove();
      return;
    }

    const tile = createTile(i, 'rebuild');
    tile.classList.add('rebuild-tile');

    let startRect = sourceFrame.getBoundingClientRect();
    if (RAID_CONFIG.type === 'stripe-mirror') {
      const failedIndex = failedDrives[0];
      const failedGroup = failedIndex < 2 ? new Set([0, 1]) : new Set([2, 3]);
      const sourceEntry = mapping.find(entry =>
        entry.tileIndex === i &&
        !failedGroup.has(entry.drive) &&
        (entry.kind === 'data' || entry.kind === 'mirror')
      );
      if (sourceEntry) {
        startRect = driveEls[sourceEntry.drive].querySelectorAll('.slot')[sourceEntry.targetSlot].getBoundingClientRect();
      }
    } else if (RAID_CONFIG.type === 'mirror-stripe') {
      const sourceEntry = mapping.find(entry =>
        entry.tileIndex === i &&
        !failedDrives.includes(entry.drive) &&
        (entry.kind === 'data' || entry.kind === 'mirror')
      );
      if (sourceEntry) {
        startRect = driveEls[sourceEntry.drive].querySelectorAll('.slot')[sourceEntry.targetSlot].getBoundingClientRect();
      }
    } else if (stripeMirrorPoolRect) {
      const poolSize = Math.min(stripeMirrorPoolRect.width, stripeMirrorPoolRect.height) / 6;
      startRect = {
        left: stripeMirrorPoolRect.left + stripeMirrorPoolRect.width / 2 - poolSize / 2,
        top: stripeMirrorPoolRect.top + stripeMirrorPoolRect.height / 2 - poolSize / 2,
        width: poolSize,
        height: poolSize
      };
    } else if (usableDrive) {
      const sourceSlot = usableDrive.querySelectorAll('.slot')[i].getBoundingClientRect();
      startRect = sourceSlot;
    }

    tile.style.left = `${startRect.left}px`;
    tile.style.top = `${startRect.top}px`;
    tile.style.width = `${startRect.width}px`;
    tile.style.height = `${startRect.height}px`;

    await moveTo(tile, target, duration);
    fillSourceSlot(i);
    tile.remove();
  }

  for (let idx = 0; idx < animatedCount; idx++) {
    await animateRecoveryTile(tileOrder[idx], profile.tileDuration, 320);
  }

  const remaining = tileOrder.slice(animatedCount);
  if (remaining.length) {
    const fastTileDuration = Math.max(90, Math.round(profile.tileDuration * 0.35));
    const fastInputDuration = shouldAnimateCalculation() ? Math.max(80, Math.round(320 * 0.35)) : 0;
    for (const i of remaining) {
      await animateRecoveryTile(i, fastTileDuration, fastInputDuration);
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(40, Math.round(profile.batchPause * 0.35))));
  }

  hideAlgorithmBox();
  if (RAID_CONFIG.type === 'adapt') {
    driveEls.forEach((d, idx) => {
      if (!failedDrives.includes(idx)) d.classList.add('rebuild');
    });
  }

  caption.textContent = RAID_CONFIG.result;
}

async function startDiskRebuild() {
  const failedDrives = getFailedDrives();
  if (!failedDrives.length || RAID_CONFIG.type === 'stripe') return;
  if (busy) return;

  if (RAID_CONFIG.type === 'adapt') {
    busy = true;
    rebuildDone = false;
    updateRebuildButton();
    const profile = getRebuildAnimationProfile();

    if (adaptRestoreStage === 0) {
      statusText.textContent = `${RAID_CONFIG.name}: restoring redundancy for endangered chunks into distributed free capacity.`;

      const lostEntries = getFailedDriveEntries();
      const reserveTargets = getAdaptReserveTargets(lostEntries.length, failedDrives);
      adaptRestorePlacements = [];

      reserveTargets.forEach((target) => markReserveSlot(target.drive, target.targetSlot, true));

      showAlgorithmBox();

      async function restoreEntry(entry, target) {
        const calcDuration = Math.max(620, profile.tileDuration * 12);
        const tileDuration = Math.max(520, profile.tileDuration * 10);
        const algRect = getAlgorithmRect();
        setCurrentRebuildSlot(entry.drive, entry.targetSlot, true);
        const inputs = mapping
          .filter((candidate) =>
            candidate.tileIndex === entry.tileIndex &&
            !failedDrives.includes(candidate.drive) &&
            (candidate.kind === 'data' || candidate.kind === 'parity' || candidate.kind === 'spare')
          )
          .map((candidate) => {
            const rect = driveEls[candidate.drive].querySelectorAll('.slot')[candidate.targetSlot].getBoundingClientRect();
            return { node: createTileAtRect(entry.tileIndex, candidate.kind, rect) };
          });

        await Promise.all(inputs.map(({ node }) => moveTo(node, algRect, calcDuration)));
        inputs.forEach(({ node }) => node.remove());

        const outTile = createTileAtRect(entry.tileIndex, 'spare', algRect);
        const targetRect = driveEls[target.drive].querySelectorAll('.slot')[target.targetSlot].getBoundingClientRect();
        await moveTo(outTile, targetRect, tileDuration);
        fillSlot({ ...entry, drive: target.drive, targetSlot: target.targetSlot, kind: 'spare', label: `S${entry.tileIndex + 1}` }, true);
        outTile.remove();
        setCurrentRebuildSlot(entry.drive, entry.targetSlot, false);
      }

      for (let i = 0; i < lostEntries.length; i++) {
        if (!reserveTargets[i]) break;
        await restoreEntry(lostEntries[i], reserveTargets[i]);
        adaptRestorePlacements.push({ failedEntry: lostEntries[i], reserveTarget: reserveTargets[i] });
        await new Promise((resolve) => setTimeout(resolve, 260));
      }

      clearReserveHighlights();
      hideAlgorithmBox();
      adaptRestoreStage = 1;
      rebuildDone = false;
      statusText.textContent = `${RAID_CONFIG.name}: redundancy restored. Replace failed drive, then rebalance chunks back into the array.`;
      busy = false;
      updateRebuildButton();
      return;
    }

    statusText.textContent = `${RAID_CONFIG.name}: replacement drive joins the array and protected chunks are rebalanced back from distributed free capacity.`;
    failedDrives.forEach((driveIndex) => {
      const drive = driveEls[driveIndex];
      if (!drive) return;
      drive.classList.remove('failed');
      const cross = drive.querySelector('.cross');
      if (cross) cross.classList.remove('show');
      setReplacementBadge(driveIndex, false);
      clearDriveSlots(driveIndex);
      drive.classList.add('rebuild');
    });

    for (let i = 0; i < adaptRestorePlacements.length; i++) {
      const placement = adaptRestorePlacements[i];
      const sourceRect = driveEls[placement.reserveTarget.drive].querySelectorAll('.slot')[placement.reserveTarget.targetSlot].getBoundingClientRect();
      const targetRect = driveEls[placement.failedEntry.drive].querySelectorAll('.slot')[placement.failedEntry.targetSlot].getBoundingClientRect();
      const tile = createTileAtRect(placement.failedEntry.tileIndex, placement.failedEntry.kind, sourceRect);
      const moveDuration = Math.max(320, profile.tileDuration * 7);
      await moveTo(tile, targetRect, moveDuration);
      fillSlot(placement.failedEntry, true);
      tile.remove();
      clearSingleSlot(placement.reserveTarget.drive, placement.reserveTarget.targetSlot);
      markReserveSlot(placement.reserveTarget.drive, placement.reserveTarget.targetSlot, false);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    failedDrives.forEach((driveIndex) => {
      const drive = driveEls[driveIndex];
      if (!drive) return;
      drive.classList.remove('rebuild', 'failed');
      drive.classList.add('rebuilt');
    });
    adaptRestoreStage = 2;
    rebuildDone = true;
    statusText.textContent = `${RAID_CONFIG.name}: replacement drive inserted and array rebalanced. Distributed free capacity is available again.`;
    busy = false;
    updateRebuildButton();
    return;
  }

  const rebuildTargetDrives = RAID_CONFIG.type === 'stripe-mirror'
    ? (failedDrives[0] < 2 ? [0, 1] : [2, 3])
    : failedDrives;

  busy = true;
  rebuildDone = false;
  updateRebuildButton();
  statusText.textContent = RAID_CONFIG.type === 'stripe-mirror'
    ? `${RAID_CONFIG.name}: rebuilding failed stripe set ${rebuildTargetDrives.map(i => String.fromCharCode(65 + i)).join(', ')} from the surviving mirror set.`
    : `${RAID_CONFIG.name}: rebuilding replaced drive ${failedDrives.map(i => String.fromCharCode(65 + i)).join(', ')} sector by sector.`;

  const profile = getRebuildAnimationProfile();
  const rebuildTargets = new Set(rebuildTargetDrives);
  const failedEntries = mapping
    .filter((entry) => rebuildTargets.has(entry.drive))
    .sort((a, b) => {
      if (a.drive !== b.drive) return a.drive - b.drive;
      if (a.targetSlot !== b.targetSlot) return a.targetSlot - b.targetSlot;
      return a.tileIndex - b.tileIndex;
    });
  const fastPhaseStart = Math.min(10, failedEntries.length);
  const parallelRebuild = (failedDrives.length > 1 && ['mirror-stripe', 'raid50', 'parity2', 'raid60'].includes(RAID_CONFIG.type)) || RAID_CONFIG.type === 'stripe-mirror';
  const wipeTargets = rebuildTargetDrives.filter((driveIndex) => !failedDrives.includes(driveIndex));

  rebuildTargetDrives.forEach((driveIndex) => {
    const drive = driveEls[driveIndex];
    if (!drive) return;
    drive.classList.remove('failed', 'offline');
    setReplacementBadge(driveIndex, false);
    const cross = drive.querySelector('.cross');
    if (cross) cross.classList.remove('show');
    if (failedDrives.includes(driveIndex)) {
      clearDriveSlots(driveIndex);
    }
    drive.classList.add('rebuild');
  });

  if (wipeTargets.length) {
    statusText.textContent = `${RAID_CONFIG.name}: preparing overwrite targets ${wipeTargets.map(i => String.fromCharCode(65 + i)).join(', ')} before rebuild.`;
    await animateDriveWipe(wipeTargets);
    statusText.textContent = RAID_CONFIG.type === 'stripe-mirror'
      ? `${RAID_CONFIG.name}: rebuilding failed stripe set ${rebuildTargetDrives.map(i => String.fromCharCode(65 + i)).join(', ')} from the surviving mirror set.`
      : `${RAID_CONFIG.name}: rebuilding replaced drive ${failedDrives.map(i => String.fromCharCode(65 + i)).join(', ')} sector by sector.`;
  }

  async function rebuildEntry(entry, entryIndex) {
    const target = driveEls[entry.drive].querySelectorAll('.slot')[entry.targetSlot].getBoundingClientRect();
    const isFastPhase = entryIndex >= fastPhaseStart;
    const tileDuration = isFastPhase ? Math.max(90, Math.round(profile.tileDuration * 0.35)) : profile.tileDuration;
    const calcDuration = isFastPhase ? Math.max(80, Math.round(320 * 0.35)) : 320;

    if (RAID_CONFIG.type === 'mirror' || RAID_CONFIG.type === 'stripe-mirror' || RAID_CONFIG.type === 'mirror-stripe') {
      const sourceEntry = mapping.find((candidate) =>
        candidate.tileIndex === entry.tileIndex &&
        !rebuildTargets.has(candidate.drive) &&
        (candidate.kind === 'data' || candidate.kind === 'mirror')
      );
      if (sourceEntry) {
        const sourceRect = driveEls[sourceEntry.drive].querySelectorAll('.slot')[sourceEntry.targetSlot].getBoundingClientRect();
        const tile = createTileAtRect(entry.tileIndex, entry.kind === 'mirror' ? 'mirror' : 'data', sourceRect);
        await moveTo(tile, target, tileDuration);
        fillSlot(entry, true);
        tile.remove();
        return;
      }
    }

    showAlgorithmBox();
    const algRect = getAlgorithmRect();
    const stripeEntries = mapping.filter((candidate) =>
      candidate.tileIndex === entry.tileIndex &&
      !rebuildTargets.has(candidate.drive) &&
      !failedDrives.includes(candidate.drive)
    );

    const inputs = stripeEntries.map((candidate) => {
      const rect = driveEls[candidate.drive].querySelectorAll('.slot')[candidate.targetSlot].getBoundingClientRect();
      return { node: createTileAtRect(entry.tileIndex, candidate.kind, rect) };
    });

    await Promise.all(inputs.map(({ node }) => moveTo(node, algRect, calcDuration)));
    inputs.forEach(({ node }) => node.remove());

    const outTile = createTileAtRect(entry.tileIndex, entry.kind, algRect);
    await moveTo(outTile, target, tileDuration);
    fillSlot(entry, true);
    outTile.remove();
  }

  if (parallelRebuild) {
    showAlgorithmBox();
    const byDrive = rebuildTargetDrives.map((driveIndex) => failedEntries.filter((entry) => entry.drive === driveIndex));
    const maxLen = Math.max(...byDrive.map((entries) => entries.length));
    for (let batch = 0; batch < maxLen; batch++) {
      const batchEntries = byDrive
        .map((entries) => entries[batch])
        .filter(Boolean);
      await Promise.all(batchEntries.map((entry, batchOffset) => rebuildEntry(entry, batch + batchOffset)));
    }
  } else {
    for (let idx = 0; idx < failedEntries.length; idx++) {
      await rebuildEntry(failedEntries[idx], idx);
    }
  }

  hideAlgorithmBox();
  rebuildTargetDrives.forEach((driveIndex) => {
    const drive = driveEls[driveIndex];
    if (!drive) return;
    drive.classList.remove('rebuild', 'failed');
    drive.classList.add('rebuilt');
  });
  updateGroupedRaidFrames();
  if (RAID_CONFIG.type === 'stripe-mirror' && groupFrames.length >= 2) {
    groupFrames[0].className = 'group-frame group-survivor group-inner';
    groupFrames[1].className = 'group-frame group-survivor group-inner';
  }
  driveEls.forEach((drive) => {
    if (!drive) return;
    drive.classList.remove('rebuild');
  });
  rebuildDone = true;
  updateRebuildButton();
  statusText.textContent = `${RAID_CONFIG.name}: replacement drive rebuild completed.`;
  busy = false;
}


function sanitizeInitialState() {
  driveEls.forEach(d => {
    if (!d) return;
    d.classList.remove('failed', 'offline', 'rebuild', 'rebuilt');
    const cross = d.querySelector('.cross');
    if (cross) cross.classList.remove('show');
    const badge = d.querySelector('.replace-badge');
    if (badge) badge.classList.remove('show');
  });
  if (groupFrames && groupFrames.length) {
    groupFrames.forEach(frame => {
      const layerClass = frame.classList.contains('group-outer') ? 'group-outer' : 'group-inner';
      const defaultClass = 'group-ok';
      frame.className = 'group-frame ' + defaultClass + ' ' + layerClass;
    });
  }
}

function resetAll() {
  step = 0;
  busy = false;
  selectionMode = false;
  analysisDone = false;
  actionMode = 'hidden';
  selectedFailures = [];
  rebuildDone = false;
  lastRecoverySucceeded = false;
  adaptRestoreStage = 0;
  adaptRestorePlacements = [];
  sourceGrid.classList.remove('visible');
  sourceFrame.style.opacity = '1';
  const sourceImgEl = sourceFrame.querySelector('.source-img');
  if (sourceImgEl) sourceImgEl.style.opacity = '1';
  clearSourceRecoveryLayer();
  clearSourceLossLayer();
  clearSourceWriteLayer();
  restoreFrame.classList.remove('show');
  caption.classList.remove('show');
  caption.textContent = '';
  hideFormula();
  hideAlgorithmBox();
  hideCpuBox();
  showCpuBox();
  ensureActionButton();
  ensureRebuildButton();
  updateActionButton();
  updateRebuildButton();
  updateSubtitle();
  updatePacketLegend();
  statusText.textContent = 'Press Space to advance the animation.';
  dataLost.classList.remove('show');
  if (sourceCross) sourceCross.classList.remove('show');
  document.querySelectorAll('.tile').forEach(t => t.remove());
  buildDrives();
  sanitizeInitialState();
}

async function nextStep() {
  if (busy) return;
  if (analysisDone) return;
  busy = true;
  if (step === 0) {
    sourceGrid.classList.add('visible');
    statusText.textContent = `${RAID_CONFIG.name}: source image is divided into blocks.`;
  } else if (step === 1) {
    statusText.textContent = `${RAID_CONFIG.name}: blocks move to the drives using this RAID layout.`;
    await animateWrite();
    caption.textContent = RAID_CONFIG.desc;
    caption.classList.add('show');
    showFormula();
    showCpuBox();
    actionMode = 'select';
    updateActionButton();
    updateSubtitle();
    statusText.textContent = `${RAID_CONFIG.name}: click Select drives to choose failed disks.`;
  } else {
    statusText.textContent = selectionMode
      ? `${RAID_CONFIG.name}: click drives to mark them as failed, then click Recover.`
      : `${RAID_CONFIG.name}: click Select drives to choose failed disks.`;
  }
  step += 1;
  busy = false;
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    nextStep();
  }
  if (e.key === 'r' || e.key === 'R') {
    resetAll();
    showCpuBox();
  }
});

window.addEventListener('message', (event) => {
  if (!event.data || !event.data.type) return;
  if (event.data.type === 'raid-next-step') nextStep();
  if (event.data.type === 'raid-reset') resetAll();
});

window.addEventListener('resize', () => {
  if (driveEls.length) updateGroupedRaidFrames();
});

window.addEventListener('pageshow', () => {
  resetAll();
  showCpuBox();
});

window.addEventListener('load', () => {
  resetAll();
  showCpuBox();
});

resetAll();
