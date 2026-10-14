# Are You Smarter Than a 5th Grader?

A homemade version of the game show for a room full of friends, with everyone answering every question at once. Picture, audio and video questions, sound cues, and an original episode to start from.

The site republishes itself on GitHub Pages whenever you change a file on the `main` branch, usually within a minute.

## How a game works

- Add the players, then pick any subject on the board. Each player writes down an answer (paper, whiteboards, phones — whatever you like).
- Press **Space** for pencils down. The answer appears, along with what the 5th-grade classmate wrote.
- Mark each player ✓ or ✗ (or use **Everyone ✓ / ✗**), then press **Space** to continue.
- Every right answer moves a player up the money ladder: $1,000 → $2,000 → $5,000 → $10,000 → **$25,000 (guaranteed)** → $50,000 → $100,000 → $175,000 → $300,000 → $500,000.
- One wrong answer and you flunk out — with $25,000 if you'd reached it, otherwise nothing — and you have to say "I am not smarter than a 5th grader!"
- After seeing a question, a player can **drop out** and keep what they've banked.
- Each player gets one of each cheat, one per question:
  - **Peek** — the screen tells everyone else to look away, then shows that player the classmate's answer
  - **Copy** — the player is locked into the classmate's answer, right or wrong
  - **Save** — if the player is wrong but the classmate is right, they're saved
- Anyone who survives all 10 sees the subject of the **$1,000,000 question** and decides: go for it (no cheats; wrong means $25,000) or walk away with $500,000.
- Players who are out keep answering for bragging rights. The winner is whoever banked the most, with total correct answers breaking ties.

The game saves itself in the browser, so a refresh or a closed tab won't lose a game in progress — you'll see a **Resume** button.

### Host shortcuts

- **Space / Enter:** pencils down, continue, dismiss pop-ups
- **Escape:** back to the board (before the answer is revealed)
- **M:** mute or unmute

You can link straight to an episode with `?game=episode1` at the end of the site address.

## Editing the questions

Each episode is a file in `games/`. Edit one on github.com with the pencil icon and commit; the site updates on its own.

An episode has 10 questions (two per grade, 1st through 5th) and a million-dollar question:

```json
{
  "title": "Episode 1",
  "questions": [
    {
      "grade": 3,
      "subject": "U.S. Geography",
      "question": "Which U.S. state borders exactly one other state?",
      "answer": "Maine",
      "classmate": { "name": "Maya", "answer": "Alaska", "correct": false }
    }
  ],
  "million": {
    "subject": "5th Grade American History",
    "question": "From which country did the United States buy Alaska in 1867?",
    "answer": "Russia"
  }
}
```

| Field | What it does |
| --- | --- |
| `grade` | 1–5; sets the label and the tile color |
| `subject` | The name on the board tile |
| `question`, `answer` | What's shown, and what's revealed |
| `choices` | Optional list for multiple choice or true/false, e.g. `["True", "False"]`. Write `answer` exactly as it appears in the list so it highlights |
| `note` | Optional small print under the answer, e.g. `"All three needed."` |
| `classmate` | The 5th grader's answer used by Peek, Copy and Save. Set `correct` to `false` to make them wrong — that's what makes the cheats a gamble |

Questions can have any number of entries and the board grows to fit, though the money ladder is built for 10. Leave out `million` to skip the million-dollar round.

### Adding an episode

1. Copy `games/episode1.json` and rename it, e.g. `episode2.json`.
2. Add it to `games/index.json` so it shows up on the start screen:

```json
{ "id": "episode2", "title": "Episode 2", "description": "Anything you like" }
```

The `id` is the file name without `.json`. You can also load a game file from your computer with **Load a game file…** on the start screen.

If a file has a typo that breaks the JSON (a missing comma or quote), the deploy fails with a red ✗ on the repo's **Actions** tab and the site keeps the last working version.

## Picture, audio and video questions

Upload the file into the `media/` folder, then point to it from the question:

```json
{
  "grade": 3,
  "subject": "Animals",
  "question": "What animal is this?",
  "image": "media/axolotl.jpg",
  "answer": "An axolotl",
  "classmate": { "name": "Lucy", "answer": "A salamander", "correct": false }
}
```

| Field | What it does |
| --- | --- |
| `image` | Shows a picture under the question |
| `audio` | Plays an audio clip, with controls |
| `video` | Plays a video, with controls |
| `answerImage` | Shows a picture once the answer is revealed |

Any of these can also be a full web address. The million-dollar question supports them too.

## Sound cues

Drop MP3s into the `sounds/` folder with these names (or change the names at the top of `js/sounds.js`):

| Moment | File |
| --- | --- |
| Start screen and player setup (loops) | `theme.mp3` |
| While a question is up (loops) | `think.mp3` |
| Answer revealed | `reveal.mp3` |
| Player marked right | `correct.mp3` |
| Player marked wrong | `wrong.mp3` |
| A player flunks out | `flunk.mp3` |
| Million-dollar subject revealed (loops) | `million.mp3` |
| Final results | `winner.mp3` |

Until you add them, the short cues play simple built-in tones and the music cues stay silent.

## Running it on your own computer

There's no build step. From the repo folder:

```
python3 -m http.server
```

Then open http://localhost:8000. (Opening `index.html` directly from your files won't load the episodes; it needs a little web server like this.)
