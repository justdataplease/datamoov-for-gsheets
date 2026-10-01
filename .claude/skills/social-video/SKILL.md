---
name: social-video
description: Produce a short social-media video (LinkedIn, X) of a DataMoov feature with fictional data only, black title cards with the logo, burned-in captions, rendered to MP4 in videos/. Use when asked for a video, clip, reel, demo or LinkedIn post of a feature.
---

# Make a social video of a feature

Videos live in `videos/<slug>/`: a `storyboard.mjs` (committed) and `out/` (renders, ignored by
git, synced to Drive with the folder). The recorder is `videos/kit/record.mjs`; read
`videos/README.md` for the director API before writing a storyboard. `videos/ppc-dashboard/` is
the worked example: copy it.

## Rule zero: nothing real on screen

Jason posts these publicly. No account number, customer, campaign name, e-mail, spreadsheet or
real figure may appear, not even near-copies of real ones (the dashboard preview's own fixture
uses IDs one digit off his real accounts and his client's campaign naming: never use it in a
video).

- Data comes from `videos/kit/demo-fixture.mjs` (Demo Store US / EU, an outdoor-gear shop, USD)
  or a new fixture of the same kind. Accounts are labelled, never numbered.
- Chat replies are scripted in the storyboard (`d.chatScript`). Numbers they quote must be read
  off the rendered fictional dashboard, never invented elsewhere and never copied from a real
  conversation or screenshot.
- A brief or prompt the user wrote may be shown if it holds no account IDs, names or figures;
  strip any that it does.
- The recorder enforces this too: it aborts every request outside its two local servers and
  Google Fonts, and scans every frame's visible text and inputs for account-shaped numbers
  (`123-456-7890`, any run of 7+ digits), e-mails outside example.com, and every ID found in the
  private files under `data/` and `.local/`. A hit fails the run and deletes that render. Never
  weaken these checks to make a render pass; change what is on screen.

## Steps

1. **Story first.** 30 to 60 seconds. One feature, one promise. Shape:
   opening card (kicker "New in DataMoov for Google Sheets", a 3 to 7 word title) →
   the ask in the sidebar → the result in the sheet, 4 to 6 captioned shots →
   a closing card (the benefit) → the end card (logo, "DataMoov for Google Sheets", one line on
   sources, note `justdataplease.com · demo data`). Cards are black with white letters and the
   logo, as in the original walkthrough.
2. **Captions carry the story.** Feeds autoplay muted. One caption per shot, at most ~70
   characters, plain words, no jargon; the caption names what the viewer sees right now
   (pass it as `say` to `d.section` so it lands when the shot settles).
3. **Write `videos/<slug>/storyboard.mjs`.** Export `formats`, optionally
   `dashboardFixture`/`dashboardPlan` (to draw a real dashboard via
   `tools/dashboard-preview.mjs`) and `setupSidebar(data)` (to reshape the preview fixture), and
   a default `async function (d)`. If the feature needs the sidebar preview to do something it
   cannot, extend the hooks in `tools/preview.mjs` (`DATAMOOV_PREVIEW_SETUP`,
   `DATAMOOV_PREVIEW_CHAT_SCRIPT`), never `src/`.
4. **Render square first** (LinkedIn feed default):
   `npm run video -- videos/<slug>` (or `--format square|portrait|landscape|all`).
   It needs an ffmpeg with libx264: `DATAMOOV_FFMPEG`, PATH, or a known install location
   (on Jason's machine, Stremio's). If none exists, say so and suggest `winget install Gyan.FFmpeg`.
5. **Look at it.** Read `out/<slug>-square-contact.png` (a tile every 2 s), then pull full-size
   frames of key shots with ffmpeg (`-ss <t> -frames:v 1`) and read them. Check: captions match
   the shot, sections are the right ones, text is readable at phone size, nothing real, no
   developer chrome (the preview banner is hidden by the recorder). Fix and re-render until it
   is right; then render `--format all`.
6. **Hand over.** Give the paths of the MP4s (square 1080×1080 for the feed, portrait 1080×1350
   for mobile-first, landscape 1920×1080 for YouTube or the site), their lengths, and a 2 to 3
   line LinkedIn post text to go with it. Commit the storyboard and any kit changes (the `ship`
   skill's checks apply when `tools/` changed); renders stay out of git.

## Limits to state honestly

The video shows the real sidebar and the real dashboard renderer on fictional data. The chat's
answers are scripted, not a live model run, and the dashboard is the preview's approximation of
the Sheets batch. Say so if asked; the end card's "demo data" note covers the public side.
