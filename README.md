# polyreader

Read a book in a language you only half know: the epub on the left, a Claude translation on the right, sentence by sentence. Point at a sentence on either side and its counterpart lights up; scroll one side and the other follows.

Translation runs through your local Claude Code (over ACP), a chapter at a time, as you read, plus the next chapter ahead. Results are stored next to the book, so each chapter is translated once.

## Running it

```sh
nix develop          # Node 24
npm install
mkdir -p data/mybook && cp ~/Books/livre.epub data/mybook/book.epub
npm run dev          # http://localhost:3000
```

Claude Code must be logged in on this machine (the agent is launched with `npx @agentclientprotocol/claude-agent-acp`).

Settings (environment variables, or a `.env.local` file):

- `POLYREADER_LANG`: target language, default `English`.
- `POLYREADER_DIR`: the library folder, default `./data`.
- `POLYREADER_AGENT`: the ACP agent command.
- `POLYREADER_DEV_ORIGINS`: other hostnames you open the dev server by, comma-separated (e.g. `*.local,reader.example.com`). Without them the page loads but never comes alive.

## ⚠️ No login yet

polyreader has no authentication. Anyone who can reach it can read your books and start translations on your Claude subscription. Keep it on localhost or a private network (or behind your reverse proxy's auth) until it grows a password lock.

## License

[AGPL-3.0-or-later](LICENSE)
