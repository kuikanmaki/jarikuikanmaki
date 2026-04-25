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
const menuBtn = document.querySelector('[data-menu-button]');
const menu    = document.querySelector('[data-menu]');
if (menuBtn && menu) {
  menuBtn.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    menuBtn.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  // Close the menu when a link inside it is clicked
  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      menu.classList.remove('open');
      menuBtn.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  });
}

// 3. Footer year
const yearEl = document.querySelector('[data-year]');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
