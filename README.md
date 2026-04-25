# Jari Kuikanmäki — Static Site

A pure static export. No build step, no framework. Hosts on **GitHub Pages** as-is.

## Files

| File           | Purpose                                                            |
|----------------|--------------------------------------------------------------------|
| `index.html`   | Homepage                                                           |
| `origins.html` | Book detail page                                                   |
| `styles.css`   | Custom CSS — design tokens, fonts, buttons (well commented)        |
| `script.js`    | Sticky header + mobile menu toggle + footer year                   |
| `assets/`      | Images (author portraits + book covers, all `.webp`)               |

## How styling works

- **Layout, spacing, typography sizes, responsive breakpoints** → Tailwind utility
  classes inline in the HTML (loaded from the official CDN with one `<script>` tag).
- **Brand colors, fonts, buttons, sticky-header behavior** → `styles.css`.

So if you want to:
- **Change a color** → edit the `:root` block in `styles.css`.
- **Change a layout** → edit the Tailwind classes in the HTML file.
- **Change a button style** → edit `.btn-primary`, `.btn-outline` or `.btn-amazon` in `styles.css`.

## Responsive design

All breakpoints are mobile-first:
- **Default styles = mobile.**
- `sm:` = ≥640px (large phones)
- `md:` = ≥768px (tablets — desktop nav appears here)
- `lg:` = ≥1024px (desktop — multi-column grids appear here)

The `<meta name="viewport">` tag is present in both HTML files — **do not remove it**, or mobile zooming will break.

## Hosting on GitHub Pages

1. Commit these files to a repo (root or `/docs` folder).
2. In the repo settings → Pages → choose the branch + folder → Save.
3. Done. No build step.

## Notes for self-maintenance

- Tailwind via CDN is great for simplicity but adds ~100KB on first load. For a personal site this is totally fine.
- If you ever need to work offline or want maximum performance, you can swap the CDN `<script>` for the [Tailwind CLI](https://tailwindcss.com/docs/installation) — but it's not necessary.
