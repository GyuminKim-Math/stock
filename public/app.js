const state = {
  rows: [],
  treasury: null,
  coverage: null,
  generatedAt: null,
  aboveOnly: true,
  sort: { key: 'earningsYield', direction: 'desc' },
  search: '',
};

const elements = {
  dialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  formError: document.querySelector('#form-error'),
  statusLine: document.querySelector('#status-line'),
  resultsBody: document.querySelector('#results-body'),
  treasuryYield: document.querySelector('#treasury-yield'),
  treasuryDate: document.querySelector('#treasury-date'),
  passingCount: document.querySelector('#passing-count'),
  coverageCount: document.querySelector('#coverage-count'),
  coverageDetail: document.querySelector('#coverage-detail'),
  updatedTime: document.querySelector('#updated-time'),
  searchInput: document.querySelector('#search-input'),
  aboveOnlyToggle: document.querySelector('#above-only-toggle'),
  refreshButton: document.querySelector('#refresh-button'),
  actualsRefreshButton: document.querySelector('#actuals-refresh-button'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function usd(value, compact = false) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(value);
}

function percent(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('ko-KR', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function localTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function sortValue(row, key) {
  if (key === 'rank') return 0;
  const value = row[key];
  return typeof value === 'string' ? value.toLocaleLowerCase('en-US') : value;
}

function currentRows() {
  const query = state.search.trim().toLocaleLowerCase('en-US');
  const treasuryRate = state.treasury?.value / 100;
  const filtered = state.rows.filter((row) => {
    const matchesFilter = !state.aboveOnly || row.earningsYield > treasuryRate;
    const matchesSearch = !query || [row.symbol, row.name, row.sector, ...(row.symbols || [])].some((value) => String(value).toLocaleLowerCase('en-US').includes(query));
    return matchesFilter && matchesSearch;
  });
  return filtered.sort((left, right) => {
    const a = sortValue(left, state.sort.key);
    const b = sortValue(right, state.sort.key);
    if (a === b) return left.symbol.localeCompare(right.symbol);
    if (typeof a === 'string') return state.sort.direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
    return state.sort.direction === 'asc' ? a - b : b - a;
  });
}

function renderSortIndicators() {
  document.querySelectorAll('thead th[data-sort]').forEach((header) => {
    const isActive = header.dataset.sort === state.sort.key;
    header.classList.toggle('active-sort', isActive);
    header.dataset.direction = isActive ? state.sort.direction : '';
  });
}

function formatPrice(row) {
  if (!row.classQuotes?.length) return '—';
  if (row.classQuotes.length === 1) return usd(row.classQuotes[0].price);
  return row.classQuotes.map((quote) => `${escapeHtml(quote.symbol)} ${usd(quote.price)}`).join('<br />');
}

function renderTable() {
  const rows = currentRows();
  renderSortIndicators();
  if (!rows.length) {
    elements.resultsBody.innerHTML = '<tr><td class="empty-state" colspan="9">표시할 종목이 없습니다. 검색 조건을 바꾸거나 데이터 연결 상태를 확인해 주세요.</td></tr>';
    return;
  }
  elements.resultsBody.innerHTML = rows.map((row, index) => {
    const isPassing = row.earningsYield > state.treasury.value / 100;
    return `<tr>
      <td class="rank-column">${index + 1}</td>
      <td><div class="company"><strong>${escapeHtml(row.symbol)}</strong><span>${escapeHtml(row.name)}</span></div></td>
      <td>${escapeHtml(row.sector)}</td>
      <td class="numeric price">${formatPrice(row)}</td>
      <td class="numeric">${usd(row.marketCap, true)}</td>
      <td class="numeric estimate" title="${escapeHtml(row.incomeMethod)}">${usd(row.ttmNetIncome, true)}<span class="info-dot" aria-label="${escapeHtml(row.incomeMethod)}">i</span></td>
      <td class="numeric yield ${isPassing ? 'positive' : 'negative'}">${percent(row.earningsYield)}</td>
      <td class="numeric spread ${isPassing ? 'positive' : 'negative'}">${isPassing ? '+' : ''}${percent(row.treasurySpread)}</td>
      <td class="date-cell">${row.periodEnd ? escapeHtml(row.periodEnd) : '—'}</td>
    </tr>`;
  }).join('');
}

function renderSummary() {
  const passing = state.rows.filter((row) => row.earningsYield > state.treasury.value / 100).length;
  elements.treasuryYield.textContent = percent(state.treasury.value / 100);
  elements.treasuryDate.textContent = `FRED DGS1 · ${state.treasury.date}`;
  elements.passingCount.textContent = `${passing}개`;
  elements.coverageCount.textContent = `${state.coverage.rowsWithComparableData}개`;
  elements.coverageDetail.textContent = `S&P 500 ${state.coverage.universe}개 종목 · ${state.coverage.issuers}개 기업 기준`;
  elements.updatedTime.textContent = localTime(state.generatedAt);
}

function setStatus(message, type = 'normal') {
  elements.statusLine.textContent = message;
  elements.statusLine.dataset.type = type;
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '요청을 처리하지 못했습니다.');
  return payload;
}

async function loadScreen({ refreshActuals = false, silent = false } = {}) {
  if (!silent) setStatus(refreshActuals ? 'SEC EDGAR 실제 순이익과 S&P 500 구성종목을 새로 불러오는 중입니다. 최초 실행은 약 1~2분 걸릴 수 있습니다…' : '토스증권 실시간 가격과 FRED 국채금리를 불러오는 중입니다…');
  elements.refreshButton.disabled = true;
  elements.actualsRefreshButton.disabled = true;
  try {
    const endpoint = `/api/screen?filter=all${refreshActuals ? '&refresh=actuals' : ''}`;
    const payload = await jsonFetch(endpoint);
    state.rows = payload.rows;
    state.treasury = payload.treasury;
    state.coverage = payload.coverage;
    state.generatedAt = payload.generatedAt;
    renderSummary();
    renderTable();
    const warnings = [];
    if (payload.coverage.actualIncomeFailed) warnings.push(`SEC 실제 순이익 미수신 ${payload.coverage.actualIncomeFailed}개 기업`);
    if (payload.coverage.missingActualIncome) warnings.push(`TTM 순이익 추출 불가 ${payload.coverage.missingActualIncome}개 기업`);
    if (payload.coverage.incompleteIssuerMarketCap) warnings.push(`전체 클래스 시가총액 미확인 ${payload.coverage.incompleteIssuerMarketCap}개 기업`);
    if (payload.coverage.multiClassIssuers) warnings.push(`복수 클래스 ${payload.coverage.multiClassIssuers}개 기업은 합산 시가총액 적용`);
    setStatus(warnings.length ? `갱신 완료 · ${warnings.join(' · ')}` : '갱신 완료 · 주가와 국채금리는 60초마다 자동 갱신됩니다.', warnings.length ? 'warning' : 'success');
  } catch (error) {
    setStatus(error.message, 'error');
    if (state.rows.length) renderTable();
  } finally {
    elements.refreshButton.disabled = false;
    elements.actualsRefreshButton.disabled = false;
  }
}

function showSettings() {
  elements.formError.textContent = '';
  elements.settingsForm.reset();
  if (!elements.dialog.open) elements.dialog.showModal();
}

function closeSettings() {
  if (elements.dialog.open) elements.dialog.close();
}

async function initialize() {
  try {
    const payload = await jsonFetch('/api/config');
    if (!payload.configured.complete) {
      setStatus('첫 사용 전 데이터 연결 설정이 필요합니다.', 'warning');
      showSettings();
      return;
    }
    await loadScreen();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.formError.textContent = '';
  const button = elements.settingsForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const form = new FormData(elements.settingsForm);
    await jsonFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    closeSettings();
    await loadScreen();
  } catch (error) {
    elements.formError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#settings-button').addEventListener('click', showSettings);
document.querySelector('#close-settings-button').addEventListener('click', closeSettings);
document.querySelector('#cancel-settings-button').addEventListener('click', closeSettings);
elements.refreshButton.addEventListener('click', () => loadScreen());
elements.actualsRefreshButton.addEventListener('click', async () => {
  if (!window.confirm('SEC 실제 순이익 캐시를 지우고 다시 받습니다. 약 1~2분 걸릴 수 있습니다. 계속할까요?')) return;
  try {
    await jsonFetch('/api/cache/refresh', { method: 'POST' });
    await loadScreen({ refreshActuals: true });
  } catch (error) {
    setStatus(error.message, 'error');
  }
});
elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderTable();
});
elements.aboveOnlyToggle.addEventListener('change', (event) => {
  state.aboveOnly = event.target.checked;
  renderTable();
});
document.querySelectorAll('thead th[data-sort]').forEach((header) => {
  header.addEventListener('click', () => {
    const key = header.dataset.sort;
    if (key === 'rank') return;
    state.sort = state.sort.key === key ? { key, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'desc' };
    renderTable();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.rows.length) loadScreen({ silent: true });
});
window.setInterval(() => {
  if (document.visibilityState === 'visible' && state.rows.length) loadScreen({ silent: true });
}, 60_000);

initialize();
