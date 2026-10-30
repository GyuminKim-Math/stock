const state = {
  rows: [],
  treasury: null,
  coverage: null,
  generatedAt: null,
  aboveOnly: true,
  sort: { key: 'earningsYield', direction: 'desc' },
  search: '',
  loading: false,
  error: '',
  configured: false,
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
    header.setAttribute('aria-sort', isActive ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function formatPrice(row) {
  if (!row.classQuotes?.length) return '—';
  if (row.classQuotes.length === 1) return usd(row.classQuotes[0].price);
  return row.classQuotes.map((quote) => `${escapeHtml(quote.symbol)} ${usd(quote.price)}`).join('<br />');
}

function renderTable() {
  const rows = currentRows();
  document.querySelector('#visible-count').textContent = rows.length;
  renderSortIndicators();
  if (!rows.length) {
    elements.resultsBody.innerHTML = '<tr><td class="empty-state" colspan="9">표시할 종목이 없습니다. 검색 조건을 바꾸거나 데이터 연결 상태를 확인해 주세요.</td></tr>';
    return;
  }
  elements.resultsBody.innerHTML = rows.map((row, index) => {
    const isPassing = row.earningsYield > state.treasury.value / 100;
    return `<tr>
      <td class="rank-column">${index + 1}</td>
      <td><a class="company-link" href="/company/${encodeURIComponent(row.symbols?.[0] || row.symbol)}" data-company><span class="company-avatar" aria-hidden="true">${escapeHtml(row.symbol.slice(0, 2))}</span><span class="company"><strong>${escapeHtml(row.symbol)} ↗</strong><span>${escapeHtml(row.name)}</span></span></a></td>
      <td><span class="sector-pill">${escapeHtml(row.sector)}</span></td>
      <td class="numeric price">${formatPrice(row)}</td>
      <td class="numeric">${usd(row.marketCap, true)}</td>
      <td class="numeric estimate" title="${escapeHtml(row.incomeMethod)}">${usd(row.ttmNetIncome, true)}<span class="info-dot" aria-label="${escapeHtml(row.incomeMethod)}">i</span></td>
      <td class="numeric yield ${isPassing ? 'positive' : 'negative'}">${percent(row.earningsYield)}</td>
      <td class="numeric spread ${isPassing ? 'positive' : 'negative'}">${isPassing ? '+' : ''}${(row.treasurySpread * 100).toFixed(2)}%p</td>
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
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  renderRoute();
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
    state.error = error.message;
    setStatus(error.message, 'error');
    renderTable();
  } finally {
    state.loading = false;
    renderRoute();
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
    state.configured = payload.configured.complete;
    renderRoute();
    if (!payload.configured.complete) {
      setStatus('첫 사용 전 데이터 연결 설정이 필요합니다.', 'warning');
      showSettings();
      return;
    }
    await loadScreen();
  } catch (error) {
    state.error = error.message;
    setStatus(error.message, 'error');
    renderRoute();
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
    state.configured = true;
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
  header.tabIndex = 0;
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); }
  });
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

renderTable();
renderRoute();
initialize();

function selectedSymbol() {
  if (!location.pathname.startsWith('/company/')) return null;
  try { return decodeURIComponent(location.pathname.slice('/company/'.length)).toUpperCase(); }
  catch { return ''; }
}

function renderRoute() {
  const symbol = selectedSymbol();
  const detail = document.querySelector('#company-view');
  document.querySelector('#dashboard-view').hidden = symbol !== null;
  detail.hidden = symbol === null;
  if (symbol === null) {
    document.title = 'Equity Note · S&P 500 스크리너';
    return;
  }
  const back = '<a class="back-link" href="/" data-home>← 전체 기업으로 돌아가기</a>';
  const row = state.rows.find((item) => (item.symbols || [item.symbol]).includes(symbol));
  document.title = `${symbol || '기업'} · Equity Note`;
  if (!row) {
    const title = state.loading ? '기업 데이터를 불러오는 중입니다' : state.error ? '데이터를 불러오지 못했습니다' : !state.configured ? '데이터 연결이 필요합니다' : '비교 가능한 기업 데이터가 없습니다';
    const message = state.loading ? '최초 실적 수집에는 약 1~2분이 걸릴 수 있습니다.' : state.error || (!state.configured ? '기존 API 연결 정보를 설정하면 기업 정보를 확인할 수 있습니다.' : `${symbol}의 주소를 확인해 주세요. 가격 또는 실적이 누락된 기업은 상세 정보를 표시할 수 없습니다.`);
    detail.innerHTML = `${back}<div class="detail-message"><p class="eyebrow">COMPANY OVERVIEW</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${!state.loading ? '<button class="button primary" data-detail-refresh>다시 불러오기</button> <button class="button secondary" data-settings>데이터 설정</button>' : ''}</div>`;
    return;
  }
  const passing = row.treasurySpread > 0;
  const treasuryRate = state.treasury.value / 100;
  const scale = Math.max(Math.abs(row.earningsYield), Math.abs(treasuryRate), 0.01) * 1.15;
  const width = (value) => Math.min(100, Math.abs(value) / scale * 100).toFixed(2);
  const spread = `${row.treasurySpread > 0 ? '+' : ''}${(row.treasurySpread * 100).toFixed(2)}%p`;
  const secLink = /^\d{1,10}$/.test(row.cik || '') ? `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(row.cik)}&owner=exclude` : `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(symbol)}`;
  detail.innerHTML = `${back}
    <header class="company-hero"><div class="company-identity"><span class="company-avatar" aria-hidden="true">${escapeHtml(symbol.slice(0, 2))}</span><div><p class="eyebrow">COMPANY OVERVIEW · ${escapeHtml(row.symbol)}</p><h1 tabindex="-1">${escapeHtml(row.name)}</h1><p class="subtitle">${escapeHtml(row.sector)} · S&amp;P 500 구성 기업</p></div></div><div class="header-actions"><button class="button secondary" data-settings>데이터 설정</button><button class="button primary" data-detail-refresh ${state.loading ? 'disabled' : ''}>${state.loading ? '갱신 중…' : '↻ 가격 새로고침'}</button></div></header>
    <p class="detail-status" role="status">${state.error ? `갱신 실패 · ${escapeHtml(state.error)} · 마지막 수신 데이터를 표시합니다.` : `마지막 수신 ${escapeHtml(localTime(state.generatedAt))} · 가격 60초 자동 갱신`}</p>
    <section class="metrics" aria-label="기업 핵심 지표">
      <article class="metric-card highlight"><span>실제 이익수익률</span><strong>${percent(row.earningsYield)}</strong><small>${passing ? '미국 1년 국채금리 초과' : '미국 1년 국채금리 이하'}</small></article>
      <article class="metric-card"><span>기업 시가총액</span><strong>${usd(row.marketCap, true)}</strong><small>${row.multiClass ? '전체 활성 클래스 합산' : '현재 주가 × 발행주식수'}</small></article>
      <article class="metric-card"><span>TTM 실제 순이익</span><strong>${usd(row.ttmNetIncome, true)}</strong><small>실적 기준일 ${escapeHtml(row.periodEnd || '—')}</small></article>
      <article class="metric-card"><span>국채 대비 수익률 차이</span><strong class="${passing ? 'positive' : 'negative'}">${spread}</strong><small>1년 만기 미국 국채 ${percent(treasuryRate)}</small></article>
    </section>
    <div class="detail-grid">
      <section class="detail-card"><p class="eyebrow">YIELD COMPARISON</p><h2>같은 기준으로 비교하기</h2>
        <div class="compare-row"><div class="compare-label"><span>${escapeHtml(row.symbol)} · 실제 이익수익률</span><strong>${percent(row.earningsYield)}</strong></div><div class="bar-track" aria-hidden="true"><div class="bar-fill equity" style="width:${width(row.earningsYield)}%;${row.earningsYield < 0 ? 'background:var(--red)' : ''}"></div></div></div>
        <div class="compare-row"><div class="compare-label"><span>미국 1년 국채 · FRED DGS1</span><strong>${percent(treasuryRate)}</strong></div><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${width(treasuryRate)}%"></div></div></div>
        <p class="comparison-note">기업의 실제 이익수익률이 국채금리보다 ${Math.abs(row.treasurySpread * 100).toFixed(2)}%p ${passing ? '높습니다' : row.treasurySpread === 0 ? '차이로 같습니다' : '낮습니다'}.</p><p>실제 순이익 ÷ 현재 시가총액으로 계산한 값이며, 배당수익률이나 보장된 투자수익률이 아닙니다. 막대 길이는 수익률의 절댓값을 나타냅니다.</p>
      </section>
      <section class="detail-card"><p class="eyebrow">LIVE QUOTES</p><h2>클래스별 주가</h2><div class="quote-list">${(row.classQuotes || []).map((quote) => `<div class="quote-item"><div><strong>${escapeHtml(quote.symbol)}</strong><small>발행주식수 ${new Intl.NumberFormat('ko-KR').format(quote.sharesOutstanding)}주</small></div><div class="numeric"><strong>${usd(quote.price)}</strong><small>시가총액 ${usd(quote.marketCap, true)}</small></div></div>`).join('')}</div><p>토스증권 OpenAPI · 마지막 수신 시점 기준. 복수 클래스 기업은 각 클래스의 시가총액을 합산합니다.</p></section>
      <section class="detail-card"><p class="eyebrow">COMPANY FACTS</p><h2>기업 및 실적 정보</h2><dl><div><dt>기업명</dt><dd>${escapeHtml(row.name)}</dd></div><div><dt>섹터</dt><dd>${escapeHtml(row.sector)}</dd></div><div><dt>티커</dt><dd>${escapeHtml(row.symbol)}</dd></div><div><dt>SEC CIK</dt><dd>${escapeHtml(row.cik || '—')}</dd></div><div><dt>순이익 산출 방식</dt><dd>${escapeHtml(row.incomeMethod)}</dd></div><div><dt>실적 종료일</dt><dd>${escapeHtml(row.periodEnd || '—')}</dd></div><div><dt>국채 관측일</dt><dd>${escapeHtml(state.treasury.date)}</dd></div></dl></section>
      <section class="detail-card"><p class="eyebrow">FURTHER READING</p><h2>기업을 더 알아보기</h2><a class="resource-link" href="${secLink}" target="_blank" rel="noopener noreferrer">SEC 공시 및 재무 보고서 <span>↗</span></a><a class="resource-link" href="https://finance.yahoo.com/quote/${encodeURIComponent(symbol.replaceAll('.', '-'))}/" target="_blank" rel="noopener noreferrer">Yahoo Finance · 기업 정보와 뉴스 <span>↗</span></a><a class="resource-link" href="https://fred.stlouisfed.org/series/DGS1" target="_blank" rel="noopener noreferrer">FRED · 비교 기준 국채금리 <span>↗</span></a><p>관련 자료는 새 탭에서 열립니다. 각 출처의 가격 기준과 갱신 시점은 이 화면과 다를 수 있습니다.</p></section>
    </div>`;
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-company], a[data-home]');
  if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    history.pushState({}, '', link.getAttribute('href'));
    renderRoute();
    window.scrollTo(0, 0);
    const heading = document.querySelector(selectedSymbol() === null ? '#dashboard-view h1' : '#company-view h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }
  if (event.target.closest('[data-detail-refresh]')) loadScreen();
  if (event.target.closest('[data-settings]')) showSettings();
});
window.addEventListener('popstate', renderRoute);
