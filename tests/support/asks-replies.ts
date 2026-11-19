// Made-up replies of the shapes Claude Code sessions end a turn with (a hook_stop's last_assistant_message), for
// claudeAsked (src/core/summarizer.ts): summaries, lists, statuses, offers and questions. Assistant text only.

// A list of what went into a notes file, then a line about an agent still running. A list item that names
// verbs ("send, send with a note, or ask") once read as an offer, and the summary ended in a question of its
// own ("Should it leave the theme work running, or wait for that to finish first?").
export const LISTED_VERBS = `I've added both to NOTES.md under Search, as future work only (commit \`5e1f0a2\`):

**Recent files as a hint:** it only breaks ties and never overrides a file you named, with test cases for both situations.

**A large, self-improving search test set:**
- **Growing from today's 120 queries** to hundreds, then thousands.
- **From the bug tracker:** wrong results, empty results and "did you mean" misses, turned into tests automatically.
- **Written on purpose,** as you said, not just collected from reports: realistic queries and edge cases. Examples:
  - near-duplicate titles;
  - queries without a keyword;
  - typos mid-word;
  - two filters applied at once;
  - mobile versus desktop;
  - misspelled tags;
  - very long queries.
- **Tagged by area,** so day to day only a sample or the relevant tags run, and the full set runs when we really want to tune it.
- **An improvement loop:** an agent runs the set, groups the failures, proposes a change and re-checks everything. You approve before anything changes.
- **Three answers from the ranker:** send, send with a note, or ask.
- **Caveats:** compute cost for big runs, and keeping some queries aside so it doesn't overfit to the examples.

The theme agent, which is also restyling the settings page colours, is still running.`;

// Ends with what to do when it's done; a summary once added a question of its own about telling you when.
export const WHEN_DONE = `I wrote the decisions down and started the change.

**Written down and committed:**
- **\`docs/import.md\`:** the import design. Recipes come from the browser's bookmarks plus your recipes folder, and everything else goes to an Inbox list.
- **\`docs/setup.md\`:** a new first-run step: look for the common recipe folders, ask where you keep yours, and never assume a layout.

**Being built,** in a separate copy:
- **One import, in the right place.** "Import the binder" reads straight from \`~/Recipes/binder\` and says "Importing the binder", with nothing extra to pick.
- **Close matches** open the nearest folder and say which one.
- **No folder named, or an unknown name:** a fresh list under \`~/Recipes/inbox\`, and the app tells you so.
- **"Make a new collection called X"** creates the folder in your recipes root.
- **"Tagged X"** becomes the import's tag. Anything you add beyond the import becomes its first note.
- **Settings:** new "Recipes root" (yours becomes \`~/Recipes\`) and "Inbox folder" options. The old setting pointing at the app's folder goes away.
- **Test run:** it runs once at the end (about two minutes), with new test cases for each of these.

When it's done: restart the app and glance at the two new settings.`;

// Ends with how to get the second half; a summary once added "Want me to hold off on anything else until then?"
export const HOW_TO_GET = `It's for both.

- **On the desktop:** the app reads each reminder and its options aloud, and you answer by voice. The side panel shows the current reminder and its options.
- **On the watch:** the reminders come up as a card, one page per reminder. You tap an option, or dictate your own answer in the box, then send.

Answering on either one clears it on the other. You can also still answer in the web dashboard itself, as before.

To get the watch side, rebuild the watch app from Xcode. The watch app installed now doesn't have it yet. Until you rebuild, tapping Snooze there just leaves the reminders on the desktop.`;

// "Nothing else is waiting on you." says nothing is asked.
export const NOTHING_WAITING = `Two agents are running in the background:

1. **Upload fix:**
   - It's fixing the progress bar that froze at 99% and showed up about a second late when you dropped a file right after a sync, and making the bar appear first on every drop.
   - It's also giving the file list more room and stopping long names from being cut off at the top.
   - **When it's done:** you reload the page.
2. **Slow-start investigation:** it's looking for the occasional slow first load on the dashboard. It's checking the cache headers, the bundle size, the database pool warming up, and the fonts loading at the wrong moment.
   - **When it's done:** if it finds a clear cause, it fixes it and you redeploy. If not, it brings back evidence and a simple way to confirm.

Nothing else is waiting on you. I'll tell you when either one is finished.`;

// "tell me if it acts oddly and I'll remove it", then a line about what's next. Once read as an offer; it's for
// if something happens, so it asks nothing now.
export const IF_ODD = `The new invoices page is live. Refresh, then open your March invoices to see it.

- **Header:** on desktop it shows the client's name, a Paid pill, "Due: next Friday", Edit and a ⋯ menu, with no second header. On a phone those fold into one small menu button.
- **Payments:** they're grouped by month. Older months fold into one line, and the latest payment stays open. Opened older payments have the normal Copy and ⋯ actions.
- **Other pages** look exactly the same as before.

All tests and the build pass, and I checked the screenshots. I didn't sign in to production, so your test is the first one on a real account. With only a few weeks of invoices, you'll see mostly the current month for now.

One thing to try: opened older payments also got a Refund button. I'm not sure that makes sense on a settled invoice, so tell me if it acts oddly and I'll remove it.

The "+ New invoice" change is ready to go out next.`;

// "If you're OK with it, I'll have a small agent make the change", with no question mark.
export const OK_WITH_IT = `I'd make **\`d\` mean delete** everywhere and move duplicate to **\`+\`**.

**Why \`d\` for delete:**
- That's what list tools usually use: mail clients like mutt, and ranger uses \`d\`/\`D\` for deleting things.
- Browsers have their own delete key, \`Del\`, but many laptops lack it, and we've already given \`x\` to close.
- \`d\` → "delete" is the first guess most people make. Duplicate doesn't have a standard key in other apps.

**Why \`+\` for duplicate:**
- In spreadsheets and design tools, \`+\` often means "add another". That's close enough to "make a copy" to be easy to remember.
- Nothing else on the board uses it.

**Keep a duplicate key at all?** I'd keep it, but as a minor key. You're right that the card menu works, and that's the main way. A key helps when the mouse isn't convenient, for example when you're sorting a long list or tidying a board. It costs nothing, since \`+\` isn't wanted for anything else.

**Clashes:** none. Like the other letters, these only work inside the board's list view, so the browser and screen readers never see them.

If you're OK with it, I'll have a small agent make the change once the current merge lands. It's a few lines plus the tests and docs.`;

// "I can add it if you want", then a labelled list and a closing line.
export const OFFER_THEN_LIST = `The storage refactor is done, so you can restart the server safely now. If you restarted while it was still editing files, restart once more to get the finished version. It's in three commits, and all checks pass: typecheck, 412 unit tests and the end-to-end cases. Nothing should look or behave any different.

**What changed in the code:**
- **Storage backends:** SQLite now sits behind a common interface in \`src/storage/\`. That covers reads, writes, migrations and backups. Adding Postgres or DuckDB later means writing one more adapter there.
- **Exporters:** CSV and the PDF report moved out of the web handlers into \`src/export/\`. Each report is linked to whichever exporter can produce it, and JSON will plug in there later.
- The CLI uses the same interfaces. \`docs/design.md\` and \`docs/roadmap.md\` are updated.

**Not built yet:**
- **Writes during a migration:** these are still refused with a reason, as before. Queuing them until the migration finishes is left as a TODO.
- **New and deleted files** are still noticed by checking every 5 seconds. They could be noticed instantly with a file watcher, but that means adding an entry to your \`~/.config/shelf/settings.json\`, which I left alone. I can add it if you want (with a backup first).

**Small differences you probably won't notice:**
- A log field can be empty in a case the server never hits.
- A startup check now runs in a slightly different order, with no effect.

Go ahead with the import test whenever you're ready.`;

// Ends with "Should I go ahead after the merge?"
export const GO_AHEAD = `No conflict either way. I only mentioned spreadsheets because that's where \`+\` comes from as "add another", to make it easy to remember. It's not about opening a spreadsheet.

Even if someone did have a spreadsheet, or anything else, open in a card, it wouldn't matter. When you're editing a card, every key goes to that card's text box; \`+\`, \`d\` and the other letters only do something in the board's own list or after Escape. That can actually happen, by the way: a card can embed a sheet for a long table. The sheet would still get its \`+\` normally.

So \`d\` = delete, \`+\` = duplicate is safe. Should I go ahead after the merge?`;

// A test list that ends with what to do if a step misbehaves. A request like it was once read as asking ("just tell
// me", and "so I can trace it"), and the summary ended in a question of its own about telling Claude the number.
export const STEP_NUMBER = `Restart the server first, then work through these.

**1. On start**
- **Expected:** you see "Added the nightly backup job." once.
- **Restart again:** it shouldn't appear a second time.

**2. Sign in**
- **Do:** run \`shelf login\` in a new terminal tab.
- **Expected:** it signs in, with no "token expired" error.

**3. Default view**
- **Say:** "Show my shelf for [room]."
- **Expected:** the footer shows "⏵ grid view on".

**4. Spoken confirm**
- **Ask the assistant:** something that needs a long query, e.g. "list every book I lent out last year".
- **Expected, spoken:** what it's for, never the query itself.
- **Expected, on screen:** the card at the bottom of the sidebar shows the full query.

**5. Scanner open**
- **Say, with the scanner app running:** "Scan a book into [room] and tag it new."
- **Expected:** the book appears in the scanner's list and in the shelf under recent scans.

**6. Scanner closed**
- **Quit the scanner, then say the same thing.**
- **Expected:** "The scanner isn't open, so I'm adding it by hand." and a blank entry opens.

**7. Never mind**
- **Say:** "Can you look up the… actually, never mind."
  - **Expected:** "Okay, not added." and nothing reaches the shelf.
- **Say:** "Add support for phrases like never mind."
  - **Expected:** added as a normal note.

**8. Locked shelves**
- **Do:** on a shared shelf, press Shift+L until it shows "locked", then ask for something that changes it, like a bulk delete.
- **Expected:** "The shelf is locked … Unlock it?" plus a card.
- **Say yes:**
  - **Expected:** the shelf unlocks and retries.
  - **Expected after that:** you get a second card for the delete itself.

**9. Short summary**
- **Ask the assistant for a fun fact.**
- **Expected:** the fact keeps its "I", and the summary doesn't end with "The assistant didn't ask anything else."

If any step fails, just tell me its number. It's all in the log, so I can trace it from there.`;
