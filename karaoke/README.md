# 歌で覚える — karaoke study

Sing along to YouTube with furigana lyrics, tap words to look them up, and review saved words with spaced repetition, using the line of the song they came from as the prompt.

## Run it

YouTube embeds refuse to play from `file://`, so serve the folder over HTTP:

```sh
cd karaoke
python3 -m http.server 8000
# open http://localhost:8000
```

For phone use, turn on GitHub Pages for this repo and open `/karaoke/`.

## Use it

1. **＋ Add song** → paste a YouTube link. The app reads the title/artist from the video and searches [LRCLIB](https://lrclib.net) for synced lyrics. Click a result, or paste LRC/plain text yourself.
2. **♪ Sing** — the current line is highlighted and scrolls into view.
   - Tap a **word** → dictionary sheet (conjugated form ← dictionary form). **★ Save card**, **✓ Mark known**, or **✎ Sung reading** (e.g. 運命 → さだめ).
   - Tap a **timestamp** or empty part of a line → jump there.
   - **🔁 Loop** repeats the current line. **🎤 Shadow** pauses after each line so you can sing it back. **▢ Cloze** blanks your saved words (tap to reveal).
   - **Speed** 0.5–1× (YouTube keeps the pitch). **Sync −/＋** fixes lyrics that run early or late (MVs often have intros the audio release doesn't).
   - **⏱ Tap-sync**: for plain-text lyrics, play the song and press Space (or TAP) as each line starts.
3. **復習 Review** — due cards show the lyric line with the word highlighted and play that line's audio. Grade with Again/Hard/Good/Easy (keys 1–4; Space = show/Good; R = replay).
4. **単語 Deck** — browse and delete cards, manage known words, and choose which kanji levels hide furigana in *Smart* mode (default: N4 and below). Words you mark known or whose cards reach 21+ days also lose their furigana. **Export/Import backup** — data lives in this browser's localStorage, so back it up.

Keys in Sing view: Space play/pause, ←/→ previous/next line, L loop, S shadow, C cloze, Esc close popup.

## Data

- `data/dict.json.gz` — built from [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) and `data/kanji.json` from KANJIDIC2 (old JLPT levels), both © EDRDG, CC BY-SA 4.0. Rebuild with `tools/build_dict.py` (instructions inside).
- Tokenizer: [kuromoji.js](https://github.com/takuyaa/kuromoji.js) loaded from jsDelivr.
