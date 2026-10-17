# Setting up the scheduled Claude run

The connector does nothing on its own; a **Claude scheduled task** drives it.
Everything the task needs to know is in [`scheduled-task.md`](./scheduled-task.md).

## Recommended schedule

One task, every day, at **10:07 AM Mountain Time** (a few minutes past the
hour so it is not delayed by the top-of-hour rush). Why 10:07:

| Day | What the run does at ~10 AM MT |
| --- | --- |
| Tue | Weekly review, waiver claims (ESPN processes waivers early Wednesday), trade decisions |
| Wed | Checks waiver results, picks up fallbacks, resets lineup |
| Thu | Locks in Thursday-night players (kickoff 6:15 PM MT) |
| Fri / Sat | Reacts to injury designations |
| Sun | Final lineup; inactives for 1 PM ET games are out by 11:30 AM ET = 9:30 AM MT, and those games lock at 11 AM MT |
| Mon | Monday-night check |

If you want extra coverage you can add a second task on Sunday at 1:55 PM MT
(before the 2:05/2:25 PM MT late games) with the same prompt; the prompt is
idempotent, so running it twice is harmless.

## Creating the task (Claude app, phone or web)

1. Make sure the connector is added and connected under
   **Customize → Connectors** (see the main README).
2. Open scheduled tasks in the Claude app and create a new task.
3. Name: `ESPN fantasy manager`. Frequency: Daily, 10:07 AM (your local time
   zone is used; set it to Mountain Time if you are not in it).
4. Prompt: paste the text under the horizontal rule in `scheduled-task.md`.
5. Connectors: keep **only** the ESPN Fantasy Football connector enabled for
   the task. Fewer connectors means fewer ways to go wrong and faster runs.
6. Model: the most capable model available to you. The prompt is long and the
   decisions benefit from it.
7. Run it once manually ("Run now") and read the report. The first run also
   seeds the journal.

## Checking on it

* Each run ends with a short report; the Claude app notifies you.
* `read_journal` in any normal chat (with the connector enabled) shows what
  previous runs did: "Show me the last 5 journal entries from my fantasy
  connector."
* If a report says the ESPN cookies expired, refresh `ESPN_S2` / `ESPN_SWID`
  in Netlify (README → Getting your ESPN cookies) and redeploy.

## Talking to the connector yourself

In a regular chat with the connector enabled you can say things like:

* "Call get_context and tell me how my team looks this week."
* "Show the lineup recommendation but don't apply it."
* "Find the top 10 free-agent RBs by projected season points."
* "Propose Lima Lightning for Ty Trotter to team 5 as a dry run so I can see the payload."

Tool calls from a normal chat ask for your permission unless you choose
"always allow"; scheduled runs do not ask.
