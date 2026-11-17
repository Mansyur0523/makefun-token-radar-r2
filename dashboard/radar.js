// Launch Radar page: sortable + filterable board, per-protocol detail,
// methodology panel. Reads window.RADAR from data.js. No network.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.body.textContent = 'Radar data missing.'; return; }
  var rows = D.rows, live = D.live, model = D.model;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K';
    return s + '$' + Math.round(a);
  }
  function moneyFull(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  function pct(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(d == null ? 1 : d) + '%';
  }
  function ageFmt(days) {
    if (days == null) return '—';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function chainsFmt(c) { return c && c.length ? c[0] + (c.length > 1 ? ' +' + (c.length - 1) : '') : '—'; }

  // ---- masthead stats
  var farms = rows.filter(function (r) { return r.verdict === 'farm'; }).length;
  $('stats').innerHTML =
    stat(rows.length, 'pre-token protocols ranked') +
    stat(D.watchlist_size, 'on the watchlist') +
    stat(model.fit.n, 'traded anchors fitted') +
    stat(farms, 'verdict: farm') +
    stat('R² ' + model.validation.holdout_r2, 'holdout, blind');
  function stat(v, label) { return '<div><dt>' + esc(label) + '</dt><dd>' + esc(v) + '</dd></div>'; }
  $('asof').textContent = 'Snapshot ' + D.as_of + ' · ' + D.source + ' · watchlist floor ' + moneyFull(D.floor_usd) + ' TVL.';

  // ---- methodology: fit + validation tables
  var f = model.fit, v = model.validation;
  var offRows = Object.keys(f.offsets).sort().map(function (c) {
    return '<tr><th>offset · ' + esc(c) + '</th><td class="num">' + f.offsets[c].toFixed(3) + '</td></tr>';
  }).join('');
  $('fit-table').innerHTML =
    '<tr><th>Anchors (traded tokens)</th><td class="num">' + f.n + '</td></tr>' +
    '<tr><th>Intercept a</th><td class="num">' + f.intercept.toFixed(3) + '</td></tr>' +
    '<tr><th>Slope b on log(TVL)</th><td class="num">' + f.slope.toFixed(3) + '</td></tr>' +
    '<tr><th>Baseline category</th><td class="num">' + esc(f.baseline) + '</td></tr>' +
    offRows +
    '<tr><th>In-sample R²</th><td class="num">' + f.r2.toFixed(3) + '</td></tr>' +
    '<tr><th>Residual σ (log)</th><td class="num">' + f.sigma.toFixed(3) + '</td></tr>';
  $('valid-table').innerHTML =
    '<tr><th>Holdout split</th><td class="num">80 / 20, seed ' + v.holdout_seed + '</td></tr>' +
    '<tr><th>Holdout R² (n=' + v.holdout_n + ')</th><td class="num">' + v.holdout_r2.toFixed(3) + '</td></tr>' +
    '<tr><th>Holdout log-RMSE</th><td class="num">' + v.holdout_log_rmse.toFixed(3) + '</td></tr>' +
    '<tr><th>5-fold CV R², mean of ' + v.cv_seeds + ' seeds</th><td class="num">' + v.cv_r2_mean.toFixed(3) + '</td></tr>' +
    '<tr><th>5-fold CV R², range</th><td class="num">' + v.cv_r2_min.toFixed(3) + ' – ' + v.cv_r2_max.toFixed(3) + '</td></tr>' +
    '<tr><th>90% prediction band</th><td class="num">×' + v.band_90x.toFixed(1) + ' / ÷' + v.band_90x.toFixed(1) + '</td></tr>';
  $('live-n').textContent = String(f.n);

  // ---- category filter options
  var cats = [];
  rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  $('cat').innerHTML = '<option value="">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  // ---- board state: filter + sort
  var state = { q: '', cat: '', verdict: '', wl: false, key: 'implied', dir: -1 };
  var SORTS = {
    rank: function (r) { return r.rank; }, name: function (r) { return r.name.toLowerCase(); },
    category: function (r) { return (r.category || '').toLowerCase(); },
    chains: function (r) { return (r.chains[0] || '').toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; }, growth: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
    age: function (r) { return r.age_days == null ? -1 : r.age_days; },
    implied: function (r) { return r.implied_value_usd; },
    prob: function (r) { return r.launch_prob; }, ev: function (r) { return r.expected_value_usd; },
    verdict: function (r) { return { farm: 0, thin: 1, skip: 2 }[r.verdict]; }
  };
  function visible() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.wl && !r.is_watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = SORTS[state.key] || SORTS.implied;
    list.sort(function (a, b) {
      var x = k(a), y = k(b);
      var c = x < y ? -1 : x > y ? 1 : (a.slug < b.slug ? -1 : 1);
      return c * state.dir;
    });
    return list;
  }
  function render() {
    var list = visible();
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols';
    $('rows').innerHTML = list.map(function (r) {
      var g = r.change_7d;
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td>' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.is_watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
        '<span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(chainsFmt(r.chains)) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (g == null ? '' : g < 0 ? 'neg' : 'pos') + '">' + pct(g) + '</td>' +
        '<td class="num">' + ageFmt(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + money(r.band_low_usd) + '–' + money(r.band_high_usd) + '</td>' +
        '<td class="num">' + (r.launch_prob * 100).toFixed(0) + '%</td>' +
        '<td class="num ' + (r.expected_value_usd < 0 ? 'neg' : 'pos') + '">' + money(r.expected_value_usd) + '</td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('');
    document.querySelectorAll('#board thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.getAttribute('data-k') === state.key);
    });
  }
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  // ---- detail view
  var selected = null;
  function openDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selected = slug;
    document.querySelectorAll('#rows tr').forEach(function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    $('detail').hidden = false;
    $('d-name').innerHTML = esc(r.name) + ' <span class="small">#' + r.rank + ' · ' + esc(r.slug) + '</span>';
    $('d-grid').innerHTML =
      grid('Implied value', moneyFull(r.implied_value_usd)) +
      grid('Comps base value', moneyFull(r.base_value_usd)) +
      grid('90% band', money(r.band_low_usd) + ' – ' + money(r.band_high_usd)) +
      grid('P(launch)', (r.launch_prob * 100).toFixed(0) + '%') +
      grid('TVL', moneyFull(r.tvl_usd)) +
      grid('7-day TVL change', pct(r.change_7d)) +
      grid('Age, no token', ageFmt(r.age_days)) +
      grid('Category', esc(r.category || '—')) +
      grid('Chains', esc(r.chains.join(', ') || '—')) +
      grid('Farm cost', moneyFull(r.farm_cost_usd) + ' · capital ' + moneyFull(r.farm_capital_usd)) +
      grid('Expected value', moneyFull(r.expected_value_usd)) +
      grid('Verdict', r.verdict.toUpperCase());
    function grid(k, val) { return '<div><dt>' + esc(k) + '</dt><dd>' + val + '</dd></div>'; }
    $('d-why').textContent =
      'The comps curve reads this protocol’s TVL of ' + moneyFull(r.tvl_usd) + ' and its ' +
      (r.category || 'uncategorised') + ' offset and predicts a traded market cap near ' +
      moneyFull(r.base_value_usd) + ' (90% band ' + money(r.band_low_usd) + ' – ' + money(r.band_high_usd) +
      ' before the launch haircut). Multiplied by a launch probability of ' + (r.launch_prob * 100).toFixed(0) +
      '% — from its size, its ' + pct(r.change_7d) + ' seven-day TVL change and ' + ageFmt(r.age_days) +
      ' listed with no token — that gives an implied value of ' + moneyFull(r.implied_value_usd) + '.';
    $('d-steps').innerHTML = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('d-ev').textContent =
      'Expected value: ' + moneyFull(r.implied_value_usd) + ' implied × 0.01% farmer share − ' +
      moneyFull(r.farm_cost_usd) + ' farm cost = ' + moneyFull(r.expected_value_usd) +
      '. Verdict ' + r.verdict + ': ' +
      (r.verdict === 'farm' ? 'the expected value clears $250 — farm it first.' :
        r.verdict === 'thin' ? 'the expected value is positive but under $250 — farm it only after the farm verdicts.' :
          'the farm costs more than the expected slice — skip it unless the protocol changes.');
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (location.hash.indexOf('p=') < 0) history.replaceState(null, '', '#p=' + slug);
  }
  $('d-close').addEventListener('click', function () {
    $('detail').hidden = true; selected = null;
    history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('#rows tr').forEach(function (tr) { tr.classList.remove('sel'); });
  });

  // ---- live anchors table
  $('live-rows').innerHTML = live.map(function (p) {
    return '<tr><td><span class="pname">' + esc(p.name) + '</span><span class="pslug">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num">' + p.mcap_tvl.toFixed(2) + '×</td>' +
      '<td class="num ' + (p.change_7d == null ? '' : p.change_7d < 0 ? 'neg' : 'pos') + '">' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  // ---- controls
  $('q').addEventListener('input', function () { state.q = this.value; render(); });
  $('cat').addEventListener('change', function () { state.cat = this.value; render(); });
  $('verdict').addEventListener('change', function () { state.verdict = this.value; render(); });
  $('wl').addEventListener('change', function () { state.wl = this.checked; render(); });
  $('sort').addEventListener('change', function () {
    var map = { implied: -1, tvl: -1, growth: -1, ev: -1, age: -1, name: 1 };
    state.key = this.value; state.dir = map[this.value] || -1; render();
  });
  document.querySelectorAll('#board thead th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (state.key === k) state.dir = -state.dir;
      else { state.key = k; state.dir = (k === 'name' || k === 'category' || k === 'chains') ? 1 : -1; }
      render();
    });
  });

  // ---- hash routing: #p=slug opens a detail, #f=category / #v=verdict pre-filter
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var out = {};
    h.split('&').forEach(function (part) {
      var kv = part.split('=');
      if (kv[0]) out[kv[0]] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }
  var hh = readHash();
  if (hh.f) { state.cat = hh.f; $('cat').value = hh.f; }
  if (hh.v) { state.verdict = hh.v; $('verdict').value = hh.v; }
  render();
  if (hh.p) openDetail(hh.p);
})();
