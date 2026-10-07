/* =============================================================
   Jari Kuikanmäki — Static Site JavaScript
   -------------------------------------------------------------
   Tiny vanilla JS file. Two jobs:
     1. Toggle the .scrolled class on the sticky header.
     2. Toggle the mobile menu open/closed.
   Plus: fill the current year in the footer automatically.
   ============================================================= */

// 1. Sticky header — add a subtle background once the user scrolls
const header = document.querySelector('.site-header');
if (header) {
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// 2. Mobile menu toggle
// The header is injected async by the shared-header fetch, so we use event
// delegation on document instead of binding to the button directly.
const closeMenu = () => {
  document.querySelectorAll('[data-menu].open').forEach((menu) => menu.classList.remove('open'));
  document.querySelectorAll('[data-menu-button].open').forEach((btn) => {
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu-button]');
  if (btn) {
    const menu = document.getElementById(btn.getAttribute('aria-controls') || '') || document.querySelector('[data-menu]');
    if (menu) {
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    }
    return;
  }
  // Close the menu when a link inside it is clicked, or when clicking elsewhere.
  if (e.target.closest('[data-menu] a') || !e.target.closest('[data-menu]')) closeMenu();
});

// 3. Footer year
const yearEl = document.querySelector('[data-year]');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

/* =============================================================
   4. Editions renderer — reads public/data/origins-editions.js
   -------------------------------------------------------------
   Any element with [data-editions] is filled automatically.
   Attributes control what is rendered:

     data-editions                  (required, marks the container)
     data-format="audiobook"        only this format (omit = all formats)
     data-status="live"             only this status (default: "live")
     data-sort="retailer"           sort alphabetically by this field
     data-style="buttons"           "buttons" (default) or "list"
     data-label="Buy on {retailer}" button text; {retailer} and {format}
                                    are replaced with the entry's values

   Examples:
     <div data-editions data-format="audiobook" data-sort="retailer"
          data-label="Listen on {retailer}"></div>
     <div data-editions data-style="list" data-sort="retailer"></div>
   ============================================================= */
window.renderEditions = function renderEditions() {
  if (typeof ORIGINS_EDITIONS === 'undefined') return;

  const escapeHtml = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  document.querySelectorAll('[data-editions]').forEach((container) => {
    const format   = container.getAttribute('data-format');
    const status   = container.getAttribute('data-status') || 'live';
    const sortBy   = container.getAttribute('data-sort');
    const style    = container.getAttribute('data-style') || 'buttons';
    // Default label is per entry: "Listen on X" for audiobooks, "Buy on X" otherwise.
    const labelTpl = container.getAttribute('data-label') || null;

    let items = ORIGINS_EDITIONS.filter((e) =>
      e && e.status === status && (!format || e.format === format)
    );

    if (sortBy) {
      items = items.slice().sort((a, b) =>
        String(a[sortBy] ?? '').localeCompare(String(b[sortBy] ?? ''))
      );
    }

    // Drop duplicates: same retailer + same url = one button.
    const seen = new Set();
    items = items.filter((e) => {
      const key = e.retailer + '|' + e.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (items.length === 0) return; // leave container empty if nothing matches

    if (style === 'inline') {
      // Compact inline links joined by " · " — used in the announcement banner.
      container.innerHTML = items.map((e) => {
        const tpl = labelTpl || (e.format === 'audiobook' ? 'Listen on {retailer}' : 'Buy on {retailer}');
        const label = tpl.replace('{retailer}', e.retailer).replace('{format}', e.format);
        return '<a href="' + escapeHtml(e.url) + '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(label) + '</a>';
      }).join(' <span class="editions-sep" aria-hidden="true">·</span> ');
    } else if (style === 'list') {
      container.innerHTML =
        '<ul class="editions-list">' +
        items.map((e) =>
          '<li><a href="' + escapeHtml(e.url) + '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(e.retailer) +
          ' <span class="editions-format">(' + escapeHtml(e.format) + ')</span></a></li>'
        ).join('') +
        '</ul>';
    } else {
      container.innerHTML = items.map((e) => {
        const tpl = labelTpl || (e.format === 'audiobook' ? 'Listen on {retailer}' : 'Buy on {retailer}');
        const label = tpl
          .replace('{retailer}', e.retailer)
          .replace('{format}', e.format);
        const btnClass = e.retailer === 'Amazon' ? 'btn btn-primary' : 'btn btn-outline';
        return '<a href="' + escapeHtml(e.url) + '" target="_blank" rel="noopener noreferrer" class="' +
          btnClass + '">' + escapeHtml(label) + '</a>';
      }).join('');
    }
  });
};

// Run once for containers already in the page...
window.renderEditions();
// ...and again once the shared header/footer have been injected.
document.addEventListener('site-partials-loaded', window.renderEditions);
