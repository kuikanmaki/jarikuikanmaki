/* =============================================================
   Origins of Coronavirus — Editions data file
   -------------------------------------------------------------
   ONE place to edit every place the book is sold.

   Each entry describes ONE edition at ONE retailer:

     edition : "1"            — edition number (default "1")
     format  : "hardcover" | "paperback" | "ebook" | "audiobook"
     retailer: "Amazon"       — store name, shown on the button/link
     url     : "https://…"    — link to the book at that retailer
     status  : "live" | "upcoming"
               "live"     = shown on the site
               "upcoming" = hidden everywhere until you flip it to "live"

   TO ADD A NEW STORE: copy a block, change retailer/url, save.
   The site updates automatically on the next page load —
   no other file needs to be touched.
   ============================================================= */

const ORIGINS_EDITIONS = [
  {
    edition: "1",
    format: "paperback",
    retailer: "Amazon",
    url: "https://mybook.to/origins-amazon",
    status: "live",
  },
  {
    edition: "1",
    format: "ebook",
    retailer: "Amazon",
    url: "https://mybook.to/origins-amazon",
    status: "live",
  },
  {
    edition: "1",
    format: "audiobook",
    retailer: "Storytel",
    url: "https://www.storytel.com/tv/books/origins-of-coronavirus-wuhan-the-secret-research-that-sparked-the-pandemic-and-the-cover-up-of-the-century-15184969",
    status: "live",
  },
  {
    edition: "1",
    format: "audiobook",
    retailer: "Google Play",
    url: "https://play.google.com/store/audiobooks/details/Origins_of_Coronavirus_Wuhan_the_Secret_Research_T?id=AQAAAEAGdUk1XM",
    status: "live",
  },

  /* --- Examples of upcoming editions (hidden until status: "live") ---
  {
    edition: "1",
    format: "hardcover",
    retailer: "Amazon",
    url: "https://mybook.to/origins-amazon",
    status: "upcoming",
  },
  {
    edition: "1",
    format: "audiobook",
    retailer: "Audible",
    url: "https://www.audible.com/…",
    status: "upcoming",
  },
  */
];
