// What's New: the text of the one-time screen Ghost shows on the first open after an update (ui.js, section
// "What's New"). Written at publish time, one entry per released version (the key is the exact
// CFBundleShortVersionString from ios/project.yml). A version without an entry shows nothing.
//
// Rules for the text (it is read by friends, not developers):
//   - 2 to 5 short bullets, plain words, what the person can now do or what got better. Start with the feature.
//   - `how` is optional: where to find it, one line ("Settings > Report a Bug or Idea"). Only when it needs it.
//   - No ticket numbers, test counts, file or function names, protocol terms.
//   - If a build ships several versions at once (e.g. 1.15.0 inside 1.16.0), put the bullets of all of them
//     in the newest entry.
window.GHOST_WHATS_NEW = {
  "1.18.2": {
    items: [
      { t: "With an Apple developer account, notifications while Ghost is closed can come straight to Ghost instead of the ntfy app.", how: "Settings > Notifications > Apple Push" },
      { t: "Tapping one of those notifications opens the chat, and opening a chat clears its notifications." },
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports that had to wait now really go out, even after you close Ghost, and show if they're waiting, sending or sent.", how: "Settings > Report a Bug or Idea" },
      { t: "The report form is simpler and big pictures are made a bit smaller so reports with several of them go through." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
  "1.18.1": {
    items: [
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports that had to wait now really go out, even after you close Ghost, and show if they're waiting, sending or sent.", how: "Settings > Report a Bug or Idea" },
      { t: "Reports with several pictures go through: big pictures are made a bit smaller so they fit." },
      { t: "The report form is simpler: just your text and pictures, no Screen field to fill in." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
  "1.18.0": {
    items: [
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports send reliably: if the server is busy, Ghost keeps the report and sends it by itself a little later." },
      { t: "Reports with several pictures go through: big pictures are made a bit smaller so they fit." },
      { t: "The report form is simpler: just your text and pictures, no Screen field to fill in." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
};
