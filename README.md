# Jari Kuikanmäki — Static Site

Plain HTML/CSS/JS export. No build step required.

## Files
- `index.html` — Home page
- `origins.html` — Origins of Coronavirus book page
- `styles.css` — All styles (design tokens + layout)
- `script.js` — Sticky header state, mobile menu, footer year
- `assets/` — Images (webp)

## Hosting on GitHub Pages
1. Create a new repository (e.g. `jarikuikanmaki-site`).
2. Upload all files in this folder to the repo root.
3. In repo Settings → Pages → Source: `Deploy from a branch` → `main` / `/ (root)`.
4. Wait ~1 minute, then visit `https://<user>.github.io/<repo>/`.

## Local preview
Open `index.html` directly, or run any static server:
```
python3 -m http.server 8000
```
Then open http://localhost:8000

## Notes
- Fonts load from Google Fonts (Inter + Space Grotesk).
- All internal links use relative paths (`origins.html`), so this works in any subdirectory on GitHub Pages.
- No tracking, no analytics, no external JS.
