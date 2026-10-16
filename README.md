# Are You Smarter Than a Former 5th Grader?

A homemade version of the game show for a room full of friends, with everyone answering every question at once. Picture, audio and video questions, sound cues, and an original episode to start from.

The site republishes itself on GitHub Pages whenever you change a file on the `main` branch, usually within a minute.

## How a game works

- Add the players, then pick any subject on the board. Each player writes down an answer (paper, whiteboards, phones — whatever you like).
- Before questions 1, 3, 5, 7 and 9, the game asks the group to pick a new **5th grader**, a different person each time. Pick one of the players or type in anyone else in the room. The game marks who has already gone, and the **change** link next to their name on the board fixes a wrong pick.
- Press **Space** for pencils down and the answer appears.
- Mark each player ✓ or ✗ (or use **Everyone ✓ / ✗**), then press **Space** to continue. If someone used Copy, or used Save and got it wrong, the game needs to know whether the 5th grader was right. When the 5th grader is a player, their own ✓ or ✗ counts. When it's someone else, a yellow card appears so you can mark them.
- Every right answer moves a player up the money ladder: $1,000 → $2,000 → $5,000 → $10,000 → **$25,000 (guaranteed)** → $50,000 → $100,000 → $175,000 → $300,000 → $500,000.
- One wrong answer and you flunk out — with $25,000 if you'd reached it, otherwise nothing — and you have to say "I am not smarter than a former 5th grader!"
- After seeing a question, a player can **drop out** and keep what they've banked.
- Each player gets one of each cheat, one per question. Click the cheat on their card before you reveal the answer. The current 5th grader can't cheat while it's their turn.
  - **Peek** — the player looks at the 5th grader's answer, then writes their own
  - **Copy** — the player is locked into the 5th grader's answer, right or wrong
  - **Save** — if the player is wrong but the 5th grader is right, they're saved
- Anyone who survives all 10 must answer the **$1,000,000 question**. They see the subject first, but there are no cheats and no walking away: wrong means $25,000.
- Players who are out keep answering for bragging rights. The winner is whoever banked the most, with total correct answers breaking ties.

The game saves itself in the browser, so a refresh or a closed tab won't lose a game in progress — you'll see a **Resume** button.

### Host shortcuts

- **Space / Enter:** pencils down, continue, dismiss pop-ups
- **Escape:** back to the board (before the answer is revealed)
- **M:** mute or unmute
- **0:** show or hide the play-along leaderboard

You can link straight to an episode with `?game=episode1` at the end of the site address.

## Audience play-along

Everyone who isn't playing can answer along on their phone, with a leaderboard that runs all game. It works the same way as the Wheel of Fortune play-along: messages go through a free public relay, so there's nothing to sign up for or set up.

1. On the setup screen, press **Turn on play-along**. You get a 5-letter room code and a QR code.
2. People scan the QR code (or go to the site address with `/play` on the end and type the room code), enter a name, pick their two best subjects from the dropdowns, and they're in. They can join any time: the room code stays in the bottom corner during the game, and pressing **0** shows a big QR code with the leaderboard.
3. Each question shows up on their phones as soon as it's on the TV. Multiple choice questions get tap-to-pick buttons; the rest get a text box. **One answer per question.**
4. **Scoring:** a right answer is worth 1,000 points if it's locked in right away, dropping to 100 points over 30 seconds. After that it stays at 100. Wrong answers are worth nothing. The million-dollar question uses the same scale.
5. **No spoilers:** phones only say "Locked in" until you reveal the answer, and the answer never reaches the phones before then.
6. Answers are checked automatically. Capitals and punctuation don't matter, longer words forgive a typo or two, and number answers just need the right number ("210 minutes" counts). Under the question you'll see how many people locked in, and after the reveal how many got it and who was fastest.
7. If the checker got something wrong, press **Check answers** after the reveal. It lists every answer people gave; tap one to flip it between right and wrong (everyone who gave that answer changes together).
8. The board shows the top 6 next to the money ladder, with everyone's two best subjects. The final results screen shows the play-along leaderboard under the players.
9. **Picking the 5th grader:** when it's time for a new 5th grader, the picker lists everyone in the play-along by score, with their subjects and how many they've gotten right. Tap one to make them the 5th grader.

The subjects to choose from are Math; Measurement & Time; Geometry & Shapes; Grammar; Spelling & Vocabulary; Reading & Literature; Animals & Life Science; Earth Science; Space Science; Physical Science; Human Body & Health; U.S. History; World History; Geography; Government & Civics; and Art & Music. To change the list, edit `SUBJECTS` at the top of `js/audience.js`.

If you refresh the game, play-along comes back with the same room code and everyone's scores. Phones reconnect by themselves if they sleep or lose Wi-Fi for a moment. **Reset scores** starts the leaderboard over and **New room code** opens a fresh room (everyone has to join again). Scores carry over if you press **Play this episode again**.

The game tab has to stay open, since it's what checks the answers. Messages go through public relays that anyone could listen in on, so the play-along never sends an answer before it's revealed. That's fine for a party, but don't use it for anything private.

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
      "note": "Maine borders only New Hampshire. Alaska borders no other state."
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
| `accept` | Other answers the play-along should count as right, e.g. `["seven"]` or `["Madison"]` |
| `needs` | Words that must all be in a play-along answer, in any order, e.g. `["igneous", "sedimentary", "metamorphic"]` |

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
  "answer": "An axolotl"
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
